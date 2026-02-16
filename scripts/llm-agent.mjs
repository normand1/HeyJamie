import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ToolLoopAgent, stepCountIs } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

const DEFAULT_MCP_LOAD_TIMEOUT_MS = 12_000;
const DEFAULT_AGENT_TIMEOUT_MS = 45_000;
const DEFAULT_INTENT_TIMEOUT_MS = 90_000;
const DEFAULT_BROWSEROS_TIMEOUT_MS = 180_000;

const mcpLoadTimeoutMs = parseEnvInt(
  "HEYJAMIE_MCP_LOAD_TIMEOUT_MS",
  DEFAULT_MCP_LOAD_TIMEOUT_MS,
  1000
);
const agentGenerateTimeoutMs = parseEnvInt(
  "HEYJAMIE_LLM_TIMEOUT_MS",
  DEFAULT_AGENT_TIMEOUT_MS,
  1000
);
const intentGenerateTimeoutMs = parseEnvInt(
  "HEYJAMIE_INTENT_TIMEOUT_MS",
  DEFAULT_INTENT_TIMEOUT_MS,
  5000
);
const browserOsGenerateTimeoutMs = parseEnvInt(
  "HEYJAMIE_BROWSEROS_TIMEOUT_MS",
  DEFAULT_BROWSEROS_TIMEOUT_MS,
  10_000
);
const browserOsMaxSteps = parseEnvInt("HEYJAMIE_BROWSEROS_MAX_STEPS", 12, 1);
const browserOsMaxOutputTokens = parseEnvInt(
  "HEYJAMIE_BROWSEROS_MAX_OUTPUT_TOKENS",
  1500,
  100
);
const browserOsToolResultMaxChars = parseEnvInt(
  "HEYJAMIE_BROWSEROS_TOOL_RESULT_MAX_CHARS",
  6000,
  400
);
const browserOsToolResultMaxArrayItems = parseEnvInt(
  "HEYJAMIE_BROWSEROS_TOOL_RESULT_MAX_ARRAY_ITEMS",
  48,
  4
);
const browserOsToolResultMaxObjectKeys = parseEnvInt(
  "HEYJAMIE_BROWSEROS_TOOL_RESULT_MAX_OBJECT_KEYS",
  40,
  6
);
const BROWSEROS_ACTIVE_TOOLS = new Set([
  // Navigation
  "navigate_page", "close_page", "list_pages", "select_page", "wait_for",
  // Input
  "click", "fill", "fill_form", "hover", "press_key", "drag", "handle_dialog", "upload_file",
  // Debugging (for observing page state)
  "take_snapshot", "take_screenshot", "evaluate_script",
]);

const DEFAULT_EXCALIDRAW_TIMEOUT_MS = 120_000;
const excalidrawGenerateTimeoutMs = parseEnvInt(
  "HEYJAMIE_EXCALIDRAW_TIMEOUT_MS",
  DEFAULT_EXCALIDRAW_TIMEOUT_MS,
  5000
);

const DEFAULT_TOPIC_SHIFT_TIMEOUT_MS = 15_000;
const topicShiftGenerateTimeoutMs = parseEnvInt(
  "HEYJAMIE_TOPIC_SHIFT_TIMEOUT_MS",
  DEFAULT_TOPIC_SHIFT_TIMEOUT_MS,
  2000
);
const excalidrawMaxSteps = parseEnvInt("HEYJAMIE_EXCALIDRAW_MAX_STEPS", 12, 1);

const EXCALIDRAW_ACTIVE_TOOLS = new Set([
  "read_diagram_guide",
  "create_element",
  "batch_create_elements",
  "update_element",
  "delete_element",
  "query_elements",
  "describe_scene",
  "set_viewport",
  "export_to_excalidraw_url",
]);

// Track active MCP clients so SIGTERM can close them before exit,
// preventing EPIPE crashes in the chrome-devtools-mcp child process.
const activeMcpClients = new Set();

// Module-level abort controller for graceful cancellation.
// When SIGTERM arrives, abort in-flight API requests first so the
// process can exit promptly instead of waiting for HTTP responses.
const globalAbort = new AbortController();

process.on("SIGTERM", () => {
  globalAbort.abort();  // abort in-flight API calls immediately
  const closePromises = [];
  for (const client of activeMcpClients) {
    try { closePromises.push(client.close()); } catch { /* ignore */ }
  }
  activeMcpClients.clear();
  Promise.allSettled(closePromises).finally(() => process.exit(0));
  // Force exit after 1.5s if close() hangs.
  setTimeout(() => process.exit(0), 1500).unref();
});

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseEnvInt(name, fallback, minValue = 0) {
  const raw = Number.parseInt(asString(process.env[name]).trim(), 10);
  if (Number.isFinite(raw) && raw >= minValue) {
    return raw;
  }
  return fallback;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value, max = 280) {
  const text = asString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(asString(value).trim());
}

function extractJsonPayload(text) {
  const trimmed = asString(text).trim();
  if (!trimmed) return null;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenceMatch ? asString(fenceMatch[1]).trim() : trimmed;
  if (!candidate) return null;

  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    const objStart = candidate.indexOf("{");
    const arrStart = candidate.indexOf("[");
    const starts = [objStart, arrStart].filter((index) => index >= 0);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    const end = start === objStart ? candidate.lastIndexOf("}") : candidate.lastIndexOf("]");
    if (end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function safeSerialize(value, maxLength = 1800) {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(
      value,
      (_, currentValue) => {
        if (typeof currentValue === "bigint") {
          return currentValue.toString();
        }
        if (typeof currentValue === "object" && currentValue !== null) {
          if (seen.has(currentValue)) return "[Circular]";
          seen.add(currentValue);
        }
        return currentValue;
      },
      2
    );
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}…`;
  } catch (error) {
    return `<<unserializable:${error?.message || String(error)}>>`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeAndDrain(data) {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(data);
    if (ok) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
      process.stdout.once("error", reject);
    }
  });
}

async function withTimeout(promise, timeoutMs, label, abortController) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (abortController) {
            abortController.abort();
          }
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function resolveSharedModelName() {
  const explicitShared = asString(process.env.HEYJAMIE_LLM_MODEL).trim();
  if (explicitShared) {
    return explicitShared;
  }
  return asString(process.env.VITE_HEYJAMIE_LLM_MODEL).trim();
}

function resolveOpenRouterApiKey(configuredApiKey) {
  const explicitServerKey = asString(process.env.HEYJAMIE_OPENROUTER_API_KEY).trim();
  if (explicitServerKey) {
    return {
      apiKey: explicitServerKey,
      source: "env.server",
    };
  }

  const viteKey = asString(process.env.VITE_HEYJAMIE_OPENROUTER_API_KEY).trim();
  if (viteKey) {
    return {
      apiKey: viteKey,
      source: "env.vite",
    };
  }

  return {
    apiKey: asString(configuredApiKey).trim(),
    source: "payload",
  };
}

function normalizePlannerSuggestionType(value) {
  const normalized = asString(value).trim().toLowerCase();
  if (normalized === "search") return "Search";
  if (normalized === "image") return "Image";
  if (normalized === "video") return "Video";
  if (normalized === "news") return "News";
  return "";
}

const plannerQueryNoiseWords = new Set([
  "please",
  "prioritize",
  "prioritise",
  "priority",
  "focus",
  "focused",
  "focusing",
  "emphasize",
  "emphasise",
  "highlight",
  "start",
  "starting",
  "begin",
  "beginning",
  "open",
  "click",
  "search",
  "find",
  "look",
  "browse",
  "show",
  "give",
  "check",
  "explore",
  "investigate",
  "batch",
  "first",
  "next",
  "new",
  "this",
  "that",
]);

function sanitizePlannerQuery(value) {
  let text = asString(value).trim().toLowerCase();
  if (!text) return "";

  text = text
    .replace(
      /^(?:please\s+)?(?:prioritize|prioritise|focus(?:\s+on)?|emphasize|emphasise|highlight|start(?:ing)?\s+with|begin(?:ning)?\s+with)\s+/i,
      ""
    )
    .replace(
      /\b(?:in|for|on)\s+(?:this|that)\s+(?:new\s+)?(?:search|topic)\b/gi,
      " "
    )
    .replace(
      /\b(?:in|for|on)\s+(?:the\s+)?(?:first|next|new)\s+batch\b/gi,
      " "
    )
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";

  const tokens = text
    .split(" ")
    .map((token) => token.replace(/^[-']+|[-']+$/g, ""))
    .filter(Boolean);
  const uniqueTokens = [];
  for (const token of tokens) {
    if (!/\d/.test(token) && token.length < 2) continue;
    if (plannerQueryNoiseWords.has(token)) continue;
    if (!uniqueTokens.includes(token)) {
      uniqueTokens.push(token);
    }
  }

  return uniqueTokens.slice(0, 12).join(" ");
}

function summarizeToolOutput(value) {
  if (typeof value === "string") {
    return truncateText(value, 320);
  }
  if (value === undefined) {
    return "";
  }
  return truncateText(safeSerialize(value, 700), 320);
}

function extractUrls(value, depth = 0, output = []) {
  if (depth > 4 || output.length >= 10) return output;

  if (typeof value === "string") {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/gi);
    if (matches) {
      for (const match of matches) {
        if (isHttpUrl(match) && !output.includes(match)) {
          output.push(match);
        }
      }
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractUrls(item, depth + 1, output);
      if (output.length >= 10) break;
    }
    return output;
  }

  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "headers") continue;
      extractUrls(item, depth + 1, output);
      if (output.length >= 10) break;
    }
  }

  return output;
}

function hasErrorInOutput(value) {
  if (isObject(value)) {
    if (value.isError === true) return true;
    const message = asString(value.error || value.message).toLowerCase();
    if (
      message.includes("error") ||
      message.includes("failed") ||
      message.includes("unable")
    ) {
      return true;
    }
  }

  const text = asString(value).toLowerCase();
  if (text) {
    return (
      text.includes(" error") ||
      text.startsWith("error") ||
      text.includes("failed") ||
      text.includes("unable")
    );
  }

  return false;
}

function sanitizeToolResult(value, depth = 0) {
  if (depth > 5) {
    return "[truncated:depth]";
  }

  if (typeof value === "string") {
    return truncateText(value, browserOsToolResultMaxChars);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    const limited = value
      .slice(0, browserOsToolResultMaxArrayItems)
      .map((item) => sanitizeToolResult(item, depth + 1));
    if (value.length > browserOsToolResultMaxArrayItems) {
      limited.push(
        `[truncated:${value.length - browserOsToolResultMaxArrayItems} items]`
      );
    }
    return limited;
  }

  const output = {};
  const entries = Object.entries(value);
  for (let index = 0; index < entries.length; index += 1) {
    if (index >= browserOsToolResultMaxObjectKeys) {
      output.__truncatedKeys = entries.length - browserOsToolResultMaxObjectKeys;
      break;
    }

    const [key, item] = entries[index];
    const lowerKey = key.toLowerCase();
    const maybeBinaryLike =
      lowerKey.includes("base64") ||
      lowerKey.includes("screenshot") ||
      lowerKey.includes("image") ||
      lowerKey.includes("blob");
    if (maybeBinaryLike && typeof item === "string" && item.length > 120) {
      output[key] = `[omitted:${key}:${item.length} chars]`;
      continue;
    }

    output[key] = sanitizeToolResult(item, depth + 1);
  }
  return output;
}

function wrapToolWithOutputSanitizer(tool) {
  if (!isObject(tool) || typeof tool.execute !== "function") {
    return tool;
  }

  return {
    ...tool,
    async execute(...args) {
      const result = await tool.execute.apply(tool, args);
      return sanitizeToolResult(result);
    },
  };
}

/**
 * Capture a content snapshot from the current page/diagram state.
 * Non-fatal — returns null on any error.
 */
async function captureContentSnapshot(tools, type) {
  const SNAPSHOT_CHAR_LIMIT = 3000;
  try {
    if (type === "excalidraw") {
      const describeScene = tools["describe_scene"];
      if (!isObject(describeScene) || typeof describeScene.execute !== "function") {
        return null;
      }
      const result = await withTimeout(describeScene.execute({}), 10_000, "captureContentSnapshot.excalidraw");
      const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
      return text.slice(0, SNAPSHOT_CHAR_LIMIT);
    }

    if (type === "browser") {
      const evaluateScript = tools["evaluate_script"];
      if (!isObject(evaluateScript) || typeof evaluateScript.execute !== "function") {
        return null;
      }
      const script = `JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 2000) })`;
      const result = await withTimeout(evaluateScript.execute({ expression: script }), 10_000, "captureContentSnapshot.browser");
      const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
      return text.slice(0, SNAPSHOT_CHAR_LIMIT);
    }
  } catch (error) {
    console.error(`[captureContentSnapshot] ${type} failed: ${error?.message || String(error)}`);
  }
  return null;
}

// Fixed port for Chrome remote debugging.  Chrome is launched as a detached
// process so it survives Node/MCP restarts.  MCP connects via --browserUrl.
const CHROME_DEBUG_PORT = parseEnvInt("HEYJAMIE_CHROME_DEBUG_PORT", 9224, 1024);

const CHROME_USER_DATA_DIR = path.join(
  os.homedir(),
  ".cache",
  "chrome-devtools-mcp",
  "chrome-profile"
);

// Lockfile to coordinate Chrome launches across concurrent llm-agent processes.
const CHROME_LAUNCH_LOCKFILE = path.join(
  os.tmpdir(),
  "heyjamie-chrome-launch.lock"
);
const CHROME_LAUNCH_LOCK_MAX_AGE_MS = 15_000;

/**
 * TCP probe: is something listening on the given port?
 */
async function isPortReachable(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(1500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Find the Chrome binary on macOS.
 */
function findChromeBinary() {
  const envBinary = (process.env.HEYJAMIE_CHROME_BINARY || "").trim();
  if (envBinary) return envBinary;

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Launch Chrome as a detached process with --remote-debugging-port so it
 * survives when the Node/MCP process is killed on cancel.
 */
async function launchPersistentChrome() {
  const chromeBinary = findChromeBinary();
  if (!chromeBinary) {
    console.error("[chrome-persist] no Chrome binary found");
    return false;
  }

  const args = [
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${CHROME_USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "about:blank",
  ];

  console.error(`[chrome-persist] launching: ${chromeBinary} (port=${CHROME_DEBUG_PORT})`);

  try {
    const child = spawn(chromeBinary, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    console.error(`[chrome-persist] spawn failed: ${err?.message || String(err)}`);
    return false;
  }

  // Wait for Chrome to start listening.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await isPortReachable(CHROME_DEBUG_PORT)) {
      console.error(`[chrome-persist] Chrome listening on port ${CHROME_DEBUG_PORT}`);
      return true;
    }
  }
  console.error("[chrome-persist] Chrome failed to start within 8s");
  return false;
}

/**
 * Ensure a persistent Chrome instance is running on CHROME_DEBUG_PORT.
 * Returns the port if Chrome is reachable, null otherwise.
 */
async function ensurePersistentChrome() {
  // Fast path: Chrome already running from a previous session.
  if (await isPortReachable(CHROME_DEBUG_PORT)) {
    console.error(`[chrome-persist] reusing existing Chrome on port ${CHROME_DEBUG_PORT}`);
    return CHROME_DEBUG_PORT;
  }

  // Check lockfile to avoid racing with another process that's launching Chrome.
  try {
    const stat = await fs.stat(CHROME_LAUNCH_LOCKFILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < CHROME_LAUNCH_LOCK_MAX_AGE_MS) {
      console.error(`[chrome-persist] lockfile found (${Math.round(ageMs)}ms old), waiting...`);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await sleep(400);
        if (await isPortReachable(CHROME_DEBUG_PORT)) {
          console.error(`[chrome-persist] Chrome appeared on port ${CHROME_DEBUG_PORT} after waiting`);
          return CHROME_DEBUG_PORT;
        }
      }
      console.error("[chrome-persist] timed out waiting for other launch");
    }
  } catch {
    // No lockfile — we're the first launcher.
  }

  // Write lockfile and launch Chrome ourselves.
  try {
    await fs.writeFile(CHROME_LAUNCH_LOCKFILE, String(process.pid), "utf-8");
  } catch { /* best effort */ }

  const launched = await launchPersistentChrome();
  return launched ? CHROME_DEBUG_PORT : null;
}

function buildServerCandidates(server) {
  return [server];
}

function isBrowserOsServer(name, server) {
  const normalizedName = asString(name).trim().toLowerCase();
  if (
    normalizedName.includes("chrome-devtools") ||
    normalizedName.includes("chromedevtools") ||
    normalizedName.includes("browseros") ||
    normalizedName.includes("browser-os")
  ) return true;

  // Check command/args for stdio-based detection
  const command = asString(server?.command).trim().toLowerCase();
  const args = Array.isArray(server?.args) ? server.args.map(a => asString(a).toLowerCase()) : [];
  if (command.includes("chrome-devtools-mcp") || args.some(arg => arg.includes("chrome-devtools-mcp")))
    return true;

  // Backward compat: check URL for old browseros pattern
  const url = asString(server?.url).trim().toLowerCase();
  if (url && url.includes("browseros")) return true;

  return false;
}

function isExcalidrawServer(name, server) {
  const normalizedName = asString(name).trim().toLowerCase();
  if (normalizedName.includes("excalidraw")) {
    return true;
  }

  // Check command/args for stdio-based detection (mcp_excalidraw)
  const command = asString(server?.command).trim().toLowerCase();
  const args = Array.isArray(server?.args) ? server.args.map(a => asString(a).toLowerCase()) : [];
  if (command.includes("excalidraw") || args.some(arg => arg.includes("excalidraw")))
    return true;

  // Check env for EXPRESS_SERVER_URL (mcp_excalidraw canvas server)
  if (isObject(server?.env) && asString(server.env.EXPRESS_SERVER_URL).trim())
    return true;

  const url = asString(server?.url).trim().toLowerCase();
  if (!url) return false;

  return url.includes("excalidraw");
}

function isServerEnabled(server) {
  if (!isObject(server)) return true;
  return server.enabled !== false;
}

async function createClientForServer(name, server) {
  if (!isObject(server)) {
    throw new Error(`Invalid config for server "${name}".`);
  }

  if (typeof server.command === "string" && server.command.trim()) {
    const transport = new Experimental_StdioMCPTransport({
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      env: isObject(server.env) ? server.env : undefined,
      cwd: typeof server.cwd === "string" ? server.cwd : undefined,
    });
    const client = await createMCPClient({ transport });
    return {
      client,
      transport: "stdio",
    };
  }

  const url = asString(server.url).trim();
  if (url) {
    const transportTypeRaw = asString(server.transport).trim().toLowerCase();
    const transportType = transportTypeRaw === "sse" ? "sse" : "http";

    const headers = isObject(server.headers)
      ? Object.fromEntries(
          Object.entries(server.headers)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => [key, asString(value)])
        )
      : undefined;

    const client = await createMCPClient({
      transport: {
        type: transportType,
        url,
        headers,
      },
    });

    return {
      client,
      transport: transportType,
    };
  }

  throw new Error(
    `Server "${name}" must define either "command" (stdio) or "url" (http/sse).`
  );
}

async function loadMcpTools(configPath, options = {}) {
  if (!configPath) {
    return { tools: {}, clients: [], servers: [], browserOsConnected: false, excalidrawConnected: false };
  }

  let config;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    return { tools: {}, clients: [], servers: [], browserOsConnected: false, excalidrawConnected: false };
  }

  const servers = isObject(config?.mcpServers) ? config.mcpServers : {};
  const tools = {};
  const clients = [];
  const serverSummaries = [];
  let browserOsConnected = false;
  let excalidrawConnected = false;
  let excalidrawCanvasUrl = "";

  for (let [name, server] of Object.entries(servers)) {
    const isBrowserOs = isBrowserOsServer(name, server);
    const isExcalidraw = isExcalidrawServer(name, server);
    if (!isServerEnabled(server)) {
      serverSummaries.push({
        name,
        skipped: true,
        reason: "disabled",
        browserOs: isBrowserOs,
      });
      continue;
    }
    if (options.onlyBrowserOs && !isBrowserOs) {
      serverSummaries.push({
        name,
        skipped: true,
        reason: "onlyBrowserOs",
        browserOs: false,
      });
      continue;
    }
    if (options.onlyExcalidraw && !isExcalidraw) {
      serverSummaries.push({
        name,
        skipped: true,
        reason: "onlyExcalidraw",
        browserOs: false,
      });
      continue;
    }

    // For chrome-devtools-mcp: strip --isolated and --auto-connect (we handle
    // Chrome reuse ourselves), then check if Chrome is already running from a
    // previous session.  If so, build two candidates: first try connecting to
    // the existing Chrome via --browserUrl, then fall back to launching fresh.
    if (isBrowserOs && typeof server.command === "string") {
      let args = Array.isArray(server.args) ? [...server.args] : [];
      args = args.filter((a) => {
        const val = asString(a).trim();
        return val !== "--isolated" && val !== "--auto-connect";
      });

      // Hide the "Chrome is being controlled by automated test software" banner.
      const stealthChromeArgs = [
        "--ignore-default-chrome-arg=--enable-automation",
      ];
      for (const flag of stealthChromeArgs) {
        if (!args.some((a) => asString(a).trim() === flag)) {
          args.push(flag);
        }
      }

      server = { ...server, args };
    }

    let candidates;
    if (isBrowserOs && typeof server.command === "string") {
      // Ensure a persistent Chrome is running (detached, survives Node/MCP kill).
      const chromePort = await ensurePersistentChrome();
      if (chromePort) {
        // Tell MCP to connect to our persistent Chrome instead of launching one.
        const reusableArgs = [
          ...server.args,
          `--browserUrl=http://127.0.0.1:${chromePort}`,
        ];
        candidates = [{ ...server, args: reusableArgs }];
        console.error(`[mcp] ${name}: connecting MCP to persistent Chrome on port ${chromePort}`);
      } else {
        // Fallback: let MCP launch its own Chrome (will be killed on cancel).
        candidates = buildServerCandidates(server);
        console.error(`[mcp] ${name}: falling back to MCP-managed Chrome`);
      }
    } else {
      candidates = buildServerCandidates(server);
    }
    const attemptErrors = [];
    let activeClient = null;
    let activeTransport = "";
    let activeTools = null;
    let activeServer = server;

    for (const candidate of candidates) {
      const maxCandidateAttempts = isBrowserOs ? 3 : 1;
      const candidateTarget =
        asString(candidate?.url).trim() ||
        asString(candidate?.command).trim() ||
        "unknown-target";

      for (let attempt = 1; attempt <= maxCandidateAttempts; attempt += 1) {
        let candidateClient = null;
        try {
          const { client, transport } = await createClientForServer(name, candidate);
          candidateClient = client;
          const serverTools = await client.tools();

          activeClient = client;
          activeTransport = transport;
          activeTools = serverTools;
          activeServer = candidate;
          break;
        } catch (error) {
          if (candidateClient) {
            try {
              await candidateClient.close();
            } catch {
              // ignore close errors
            }
          }
          attemptErrors.push(
            `${candidateTarget} (attempt ${attempt}/${maxCandidateAttempts}): ${
              error?.message || String(error)
            }`
          );
          if (attempt < maxCandidateAttempts) {
            await sleep(250 * attempt);
          }
        }
      }
      if (activeClient && activeTools) {
        break;
      }
    }

    if (activeClient && activeTools) {
      clients.push(activeClient);
      activeMcpClients.add(activeClient);
      for (const [toolName, tool] of Object.entries(activeTools)) {
        const wrappedTool = isBrowserOs ? wrapToolWithOutputSanitizer(tool) : tool;
        if (!tools[toolName]) {
          tools[toolName] = wrappedTool;
        }
        if (!options.onlyBrowserOs && !options.onlyExcalidraw) {
          const namespacedToolName = `${name}:${toolName}`;
          tools[namespacedToolName] = wrappedTool;
        }
      }

      const configuredUrl = asString(server?.url).trim();
      const resolvedUrl = asString(activeServer?.url).trim();
      serverSummaries.push({
        name,
        transport: activeTransport,
        toolCount: Object.keys(activeTools).length,
        browserOs: isBrowserOs,
        resolvedUrl: resolvedUrl || undefined,
        usedFallback:
          Boolean(configuredUrl) &&
          Boolean(resolvedUrl) &&
          configuredUrl !== resolvedUrl,
      });

      if (isBrowserOs && Object.keys(activeTools).length > 0) {
        browserOsConnected = true;
      }
      if (isExcalidraw && Object.keys(activeTools).length > 0) {
        excalidrawConnected = true;
        const canvasUrl = asString(server?.env?.EXPRESS_SERVER_URL).trim();
        if (canvasUrl) {
          excalidrawCanvasUrl = canvasUrl;
        }
      }
      continue;
    }

    const failureMessage = attemptErrors.join(" | ") || "Failed to load MCP server.";
    serverSummaries.push({
      name,
      error: failureMessage,
      browserOs: isBrowserOs,
    });
    console.error(`[mcp] failed to load "${name}": ${failureMessage}`);
  }

  if (options.requireBrowserOs && !browserOsConnected) {
    throw new Error(
      "Chrome DevTools MCP server is not connected. Add a Chrome DevTools MCP server in Settings -> MCP Config (e.g., name \"chrome-devtools\" with command \"npx\" and args [\"-y\", \"chrome-devtools-mcp@latest\"])."
    );
  }

  return {
    tools,
    clients,
    servers: serverSummaries,
    browserOsConnected,
    excalidrawConnected,
    excalidrawCanvasUrl,
  };
}

function buildBrowserOsPrompt(payload) {
  const context = isObject(payload?.context) ? payload.context : {};
  const startUrl = asString(context.url).trim();
  const query = asString(context.query).trim();
  const directCommand = asString(context.directCommand).trim();
  const note = asString(context.note).trim();
  const narrative = asString(context.narrative).trim();
  const transcript = asString(context.transcript).trim();
  const suggestionType = asString(context.suggestionType).trim();
  const userPrompt = asString(payload?.prompt).trim();

  const lines = [
    "Use Chrome DevTools MCP tools to complete the browsing task.",
    "Always interact through tools for navigation and page actions.",
    "Avoid logins, purchases, submissions, or destructive actions.",
    "When choosing between PDF and HTML versions of a document, always prefer the HTML link over the PDF.",
    "Use take_snapshot to observe the current page — it returns an accessibility tree with uid identifiers for each element.",
    "Use click with the uid parameter to interact with elements found in the snapshot.",
    "Use navigate_page to go to a URL. Use fill to type into input fields. Use press_key for keyboard actions (PageDown/PageUp for scrolling).",
    "If the start URL matches the page already loaded (check with list_pages), interact with the current page directly to save steps. Otherwise, use navigate_page to go to the start URL.",
    "On large listing pages with many items, if you cannot find the target content in the visible elements, use evaluate_script to search the DOM or use the site's own search feature rather than scrolling through the entire page.",
    "IMPORTANT: When you land on a search results page (Google, Bing, etc.), you MUST click through to the most relevant result. Never finish with a search results page as your final destination — always navigate to the actual content page, take a snapshot, and summarize what you find.",
    "Be efficient with steps: you have a strict 12-step limit. Use navigate_page to go to URLs. After navigating or clicking, use take_snapshot to see the page. ALWAYS call list_pages as your VERY LAST step — this captures the final page URL for the endUrl field.",
    "Return STRICT JSON only with schema:",
    '{"completed":boolean,"message":"string","endUrl":"string","actions":["string"]}',
  ];

  if (startUrl) {
    lines.push(`Start URL: ${startUrl}`);
  }
  if (directCommand) {
    lines.push(`Direct command: ${directCommand}`);
    lines.push("Treat this as highest priority.");
  } else if (query) {
    lines.push(`Topic query: ${query}`);
  }

  if (suggestionType) {
    lines.push(`Suggestion type: ${suggestionType}`);
  }
  if (note) {
    lines.push(`Suggestion note: ${note}`);
  }
  if (narrative) {
    lines.push(`Narrative context: ${narrative}`);
  }
  if (transcript) {
    lines.push(`Transcript context: ${truncateText(transcript, 1500)}`);
  }
  if (userPrompt) {
    lines.push(`Planner prompt: ${userPrompt}`);
  }

  lines.push(
    "If no action is possible, set completed=false and explain why in message."
  );

  return lines.join("\n");
}

function summarizeToolCalls(result) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const toolCalls = steps.flatMap((step) =>
    Array.isArray(step?.toolCalls) ? step.toolCalls : []
  );
  const toolResults = steps.flatMap((step) =>
    Array.isArray(step?.toolResults) ? step.toolResults : []
  );

  const resultsById = new Map(
    toolResults.map((item) => [asString(item?.toolCallId), item])
  );

  return toolCalls.map((call) => {
    const id = asString(call?.toolCallId);
    const resultItem = resultsById.get(id);
    return {
      id,
      name: asString(call?.toolName),
      input: call?.input,
      output: resultItem ? resultItem.output : undefined,
    };
  });
}

function summarizeActionsFromToolCalls(toolCallDetails) {
  return toolCallDetails.slice(0, 20).map((call, index) => {
    const urls = extractUrls(call.output);
    return {
      type: "tool",
      action: call.name || `tool-${index + 1}`,
      instruction: summarizeToolOutput(call.input) || "tool invoked",
      pageUrl: urls[0] || "",
    };
  });
}

function deriveEndUrl(startUrl, parsedText, toolCallDetails) {
  // Prefer the most recent URL found in tool call outputs — this reflects
  // the actual browser state more accurately than the agent's summarized
  // endUrl, which may be truncated by output token limits or report an
  // earlier page.
  for (let index = toolCallDetails.length - 1; index >= 0; index -= 1) {
    const urls = extractUrls(toolCallDetails[index].output);
    const candidate = urls.find((value) => isHttpUrl(value));
    if (candidate) {
      return candidate;
    }
  }

  const parsedEndUrl = asString(parsedText?.endUrl).trim();
  if (isHttpUrl(parsedEndUrl)) {
    return parsedEndUrl;
  }

  return isHttpUrl(startUrl) ? startUrl : "";
}

/**
 * Parse the output of list_pages into an array of {id, url} objects.
 * Handles both structured JSON arrays and the text format returned by
 * chrome-devtools-mcp: "# list_pages response ## Pages 1: URL 2: URL ..."
 */
function parseListPagesOutput(output) {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");

  // Try structured array first (e.g. [{id, url}, ...])
  let pages = [];
  try {
    const parsed = Array.isArray(output) ? output : JSON.parse(text);
    if (Array.isArray(parsed)) {
      pages = parsed
        .filter((p) => isObject(p))
        .map((p) => ({
          id: String(p.id ?? p.targetId ?? p.pageId ?? ""),
          url: asString(p.url).trim(),
        }))
        .filter((p) => p.id);
    }
  } catch {
    // not valid JSON or not an array — fall through to text parsing
  }

  if (pages.length === 0) {
    // Extract text from MCP response wrapper {content:[{type:"text",text:"..."}]}
    let rawText = text;
    if (isObject(output) && Array.isArray(output.content)) {
      const textItem = output.content.find((c) => isObject(c) && c.type === "text");
      if (textItem) rawText = asString(textItem.text);
    }

    // Match "N: URL" format (chrome-devtools-mcp)
    for (const match of rawText.matchAll(/(\d+):\s*(https?:\/\/\S+)/g)) {
      pages.push({ id: match[1], url: match[2] });
    }

    // Also try "[N] URL" format as fallback
    if (pages.length === 0) {
      for (const match of rawText.matchAll(/\[(\d+)\]\s*(https?:\/\/\S+)/g)) {
        pages.push({ id: match[1], url: match[2] });
      }
    }
  }

  return pages;
}

async function closeBlankTabs(tools) {
  const listPages = tools["list_pages"];
  const closePage = tools["close_page"];
  if (!isObject(listPages) || typeof listPages.execute !== "function") {
    console.error("[blank-tabs] list_pages tool not available, skipping cleanup");
    return;
  }
  if (!isObject(closePage) || typeof closePage.execute !== "function") {
    console.error("[blank-tabs] close_page tool not available, skipping cleanup");
    return;
  }

  try {
    const output = await withTimeout(listPages.execute({}), 5_000, "closeBlankTabs.list");
    const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
    console.error(`[blank-tabs] list_pages output: ${text.slice(0, 500)}`);
    const pages = parseListPagesOutput(output);
    const blankIds = pages
      .filter((p) => !p.url || p.url === "about:blank")
      .map((p) => p.id);
    console.error(`[blank-tabs] found ${blankIds.length} blank tab(s) to close: [${blankIds.join(", ")}]`);
    for (const id of blankIds) {
      try {
        await withTimeout(closePage.execute({ id }), 3_000, "closeBlankTabs.close");
        console.error(`[blank-tabs] closed tab ${id}`);
      } catch (err) {
        console.error(`[blank-tabs] failed to close tab ${id}: ${err?.message || String(err)}`);
      }
    }
  } catch (err) {
    console.error(`[blank-tabs] cleanup failed: ${err?.message || String(err)}`);
  }
}

/**
 * Select or reuse an existing tab for the preferred URL, then close all other
 * tabs so only a single content tab remains visible.  Prefers an exact URL
 * match, then a domain match, then the first non-blank tab.
 * Returns the selected tab ID or null.
 */
async function selectOrReuseTab(tools, preferredUrl) {
  const listPages = tools["list_pages"];
  const selectPage = tools["select_page"];
  const closePage = tools["close_page"];
  if (!isObject(listPages) || typeof listPages.execute !== "function") {
    console.error("[tab-reuse] list_pages tool not available");
    return null;
  }
  if (!isObject(selectPage) || typeof selectPage.execute !== "function") {
    console.error("[tab-reuse] select_page tool not available");
    return null;
  }

  try {
    const output = await withTimeout(listPages.execute({}), 5_000, "selectOrReuseTab.list");
    const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
    console.error(`[tab-reuse] list_pages output: ${text.slice(0, 500)}`);

    const pages = parseListPagesOutput(output);

    // Filter out blank tabs
    const nonBlank = pages.filter(
      (p) => p.url && p.url !== "about:blank" && p.url !== ""
    );

    if (nonBlank.length === 0) {
      console.error("[tab-reuse] no non-blank tabs found");
      return null;
    }

    // 1. Prefer exact URL match
    let target = null;
    if (isHttpUrl(preferredUrl)) {
      const normalPref = preferredUrl.replace(/\/$/, "").toLowerCase();
      target = nonBlank.find((p) => {
        try {
          return p.url.replace(/\/$/, "").toLowerCase() === normalPref;
        } catch {
          return false;
        }
      });

      // 2. Fall back to domain match
      if (!target) {
        try {
          const preferredHost = new URL(preferredUrl).hostname;
          target = nonBlank.find((p) => {
            try {
              return new URL(p.url).hostname === preferredHost;
            } catch {
              return false;
            }
          });
        } catch {
          // invalid URL, skip domain matching
        }
      }
    }

    // 3. Fall back to first non-blank tab
    if (!target) {
      target = nonBlank[0];
    }

    console.error(`[tab-reuse] selecting tab ${target.id} (${target.url})`);
    await withTimeout(selectPage.execute({ id: target.id }), 3_000, "selectOrReuseTab.select");

    // Close all other tabs so only the selected tab remains visible.
    if (isObject(closePage) && typeof closePage.execute === "function") {
      const others = nonBlank.filter((p) => p.id !== target.id);
      if (others.length > 0) {
        console.error(`[tab-reuse] closing ${others.length} other tab(s)`);
        for (const p of others) {
          try {
            await withTimeout(closePage.execute({ id: p.id }), 3_000, "selectOrReuseTab.close");
            console.error(`[tab-reuse] closed tab ${p.id} (${p.url})`);
          } catch (err) {
            console.error(`[tab-reuse] failed to close tab ${p.id}: ${err?.message || String(err)}`);
          }
        }
      }
    }

    return target.id;
  } catch (err) {
    console.error(`[tab-reuse] failed: ${err?.message || String(err)}`);
    return null;
  }
}

/**
 * Bring the current MCP target tab to the foreground in Chrome's UI.
 * Calls list_pages to find the most recently active non-blank page,
 * then select_page to activate it (Target.activateTarget).
 */
async function activateCurrentPage(tools) {
  const listPages = tools["list_pages"];
  const selectPage = tools["select_page"];
  if (!isObject(listPages) || typeof listPages.execute !== "function") return;
  if (!isObject(selectPage) || typeof selectPage.execute !== "function") return;

  try {
    const output = await withTimeout(listPages.execute({}), 3_000, "activatePage.list");

    const pages = parseListPagesOutput(output);
    const nonBlank = pages.filter(
      (p) => p.url && p.url !== "about:blank" && p.url !== ""
    );
    // Select the last non-blank page (most recently navigated)
    const target = nonBlank.length > 0 ? nonBlank[nonBlank.length - 1] : null;
    if (target) {
      await withTimeout(selectPage.execute({ id: target.id }), 3_000, "activatePage.select");
      console.error(`[tab-focus] activated tab ${target.id} (${target.url})`);
    }
  } catch (err) {
    console.error(`[tab-focus] failed: ${err?.message || String(err)}`);
  }
}

/**
 * Wrap navigate_page so that after every navigation the navigated tab
 * is brought to the foreground in Chrome's UI.
 */
function wrapNavigateWithActivation(tools) {
  const rawNavigate = tools["navigate_page"];
  if (!isObject(rawNavigate) || typeof rawNavigate.execute !== "function") return;

  tools["navigate_page"] = {
    ...rawNavigate,
    async execute(...args) {
      const result = await rawNavigate.execute.apply(rawNavigate, args);
      await activateCurrentPage(tools);
      return result;
    },
  };
}

async function executeBrowserOsNavigationFallback(tools, startUrl) {
  if (!isHttpUrl(startUrl)) return null;

  const candidates = [
    {
      name: "navigate_page",
      input: { url: startUrl },
    },
  ];

  for (const candidate of candidates) {
    const tool = tools[candidate.name];
    if (!isObject(tool) || typeof tool.execute !== "function") {
      continue;
    }

    try {
      const output = await withTimeout(
        tool.execute(candidate.input),
        Math.min(agentGenerateTimeoutMs, 20_000),
        `browseros-fallback.${candidate.name}`
      );
      return {
        id: `fallback_${candidate.name}_${Date.now().toString(36)}`,
        name: candidate.name,
        input: candidate.input,
        output,
      };
    } catch {
      // Try the next fallback tool.
    }
  }

  return null;
}

function resolveModel(settings) {
  const sharedModel = resolveSharedModelName();
  const configuredModel = asString(settings?.model).trim();
  // Environment variable takes priority over settings (for testing/override)
  const modelName = sharedModel || configuredModel;

  return {
    modelName,
    source: sharedModel ? "env.shared" : "settings",
  };
}

/**
 * Detect whether the user has shifted to a new topic based on comparing the
 * active topic with recent transcript content. Uses a fast LLM call without
 * any MCP tools.
 */
async function runTopicShiftDetection(payload) {
  const settings = isObject(payload?.settings) ? payload.settings : {};
  const apiKeySelection = resolveOpenRouterApiKey(settings.apiKey);
  const apiKey = apiKeySelection.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      error: "Missing OpenRouter API key for topic shift detection.",
    };
  }

  const modelSelection = resolveModel(settings);
  if (!modelSelection.modelName) {
    return {
      ok: false,
      error: "Missing model for topic shift detection.",
    };
  }

  const activeTopicQuery = asString(payload?.activeTopicQuery).trim();
  const activeTaskType = asString(payload?.activeTaskType).trim();
  const recentTranscript = asString(payload?.recentTranscript).trim();

  if (!recentTranscript) {
    return {
      ok: false,
      error: "Missing recent transcript for topic shift detection.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
    };
  }

  const systemPrompt = `You detect if a user has shifted to a new topic in a voice transcription.

Analyze the recent transcript and compare it to the active topic to determine if the user has moved on to a genuinely different subject.

A topic shift occurs when:
- The user explicitly mentions switching topics ("let's talk about...", "moving on to...", "now about...")
- The user starts discussing something clearly unrelated to the active topic
- The subject matter, entities, or domain changes significantly

NOT a topic shift:
- Asking follow-up questions about the same topic
- Requesting more details or examples within the same topic
- Minor tangents that relate back to the main topic
- Describing components or aspects of the current topic

Return ONLY valid JSON with this exact schema (no markdown, no explanation):
{
  "hasTopicShift": boolean,
  "confidence": number (0.0 to 1.0),
  "newTopicSummary": string (brief description of new topic, empty string if no shift),
  "reasoning": string (brief explanation),
  "suggestedActionType": "browser" | "excalidraw" | "none" | null
}

Rules for suggestedActionType:
- "excalidraw": The new topic involves systems, architectures, diagrams, flowcharts, relationships, or visual structures
- "browser": The new topic involves looking up information, searching, reading articles, podcasts, videos, or web navigation
- "none": The new topic doesn't require any external action (just conversation)
- null: No topic shift detected

Be conservative - only report a topic shift if you're confident the user has moved to a genuinely different subject.`;

  const userPrompt = `Active topic: ${activeTopicQuery || "(none)"}
Active task type: ${activeTaskType || "(none)"}

Recent transcript:
${recentTranscript}

Has the user shifted to a new topic?`;

  const openrouter = createOpenRouter({ apiKey });
  const model =
    typeof openrouter.chat === "function"
      ? openrouter.chat(modelSelection.modelName)
      : openrouter(modelSelection.modelName);

  const agent = new ToolLoopAgent({
    model,
    instructions: systemPrompt,
    tools: {},
  });

  let result;
  try {
    result = await withTimeout(
      agent.generate({ prompt: userPrompt, abortSignal: globalAbort.signal }),
      topicShiftGenerateTimeoutMs,
      "topic-shift-detect.generate"
    );
  } catch (error) {
    return {
      ok: false,
      error: `Topic shift detection failed: ${error?.message || String(error)}`,
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
    };
  }

  const text = asString(result?.text).trim();
  if (!text) {
    return {
      ok: false,
      error: "Topic shift detection returned empty text.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
    };
  }

  const parsed = extractJsonPayload(text);
  if (!isObject(parsed)) {
    return {
      ok: false,
      error: "Topic shift detection did not return valid JSON.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
      text,
    };
  }

  return {
    ok: true,
    hasTopicShift: !!parsed.hasTopicShift,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    newTopicSummary: asString(parsed.newTopicSummary).trim(),
    reasoning: asString(parsed.reasoning).trim(),
    suggestedActionType: ["browser", "excalidraw", "none"].includes(parsed.suggestedActionType)
      ? parsed.suggestedActionType
      : null,
    modelName: modelSelection.modelName,
    modelSource: modelSelection.source,
  };
}

async function runBrowserOsIntentPlanner(payload) {
  const settings = isObject(payload?.settings) ? payload.settings : {};
  const apiKeySelection = resolveOpenRouterApiKey(settings.apiKey);
  const apiKey = apiKeySelection.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      error: "Missing OpenRouter API key for BrowserOS intent planning.",
    };
  }

  const modelSelection = resolveModel(settings);
  if (!modelSelection.modelName) {
    return {
      ok: false,
      error: "Missing model for BrowserOS intent planning.",
    };
  }

  const instructions = asString(payload?.instructions).trim();
  const prompt = asString(payload?.prompt).trim();
  const context = isObject(payload?.context) ? payload.context : {};
  if (!instructions || !prompt) {
    return {
      ok: false,
      error: "Missing intent planner instructions or prompt.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
    };
  }

  const openrouter = createOpenRouter({ apiKey });
  const model =
    typeof openrouter.chat === "function"
      ? openrouter.chat(modelSelection.modelName)
      : openrouter(modelSelection.modelName);

  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools: {},
  });

  const result = await withTimeout(
    agent.generate({ prompt, abortSignal: globalAbort.signal }),
    intentGenerateTimeoutMs,
    "browseros-intent.generate"
  );

  const text = asString(result?.text).trim();
  if (!text) {
    return {
      ok: false,
      error: "BrowserOS intent planner returned empty text.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
    };
  }

  const parsed = extractJsonPayload(text);
  if (!isObject(parsed)) {
    return {
      ok: false,
      error: "BrowserOS intent planner did not return valid JSON.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
      text,
    };
  }

  const rawQuery = asString(parsed.query).trim();
  const suggestionType = normalizePlannerSuggestionType(parsed.suggestionType);
  const plannerPrompt = asString(
    parsed.browserosPrompt || parsed.stagehandPrompt || parsed.browserPrompt
  ).trim();
  const plannerSystemPrompt = asString(
    parsed.browserosSystemPrompt ||
      parsed.stagehandSystemPrompt ||
      parsed.browserSystemPrompt
  ).trim();
  const narrative = asString(parsed.narrative).trim();
  const reasoning = asString(parsed.reasoning).trim();
  const actionType = asString(parsed.actionType).trim().toLowerCase() === "excalidraw"
    ? "excalidraw"
    : "browser";
  const excalidrawPrompt = asString(parsed.excalidrawPrompt).trim();
  const excalidrawSystemPrompt = asString(parsed.excalidrawSystemPrompt).trim();
  const userNote = asString(parsed.userNote).trim();
  const contextDirectCommand = asString(context.directCommand).trim();
  const hasDirectCommand = Boolean(contextDirectCommand);
  const contextExistingSuggestion = isObject(context.existingSuggestion)
    ? context.existingSuggestion
    : {};

  const normalizedRawQuery = sanitizePlannerQuery(rawQuery);
  const fallbackQueryCandidates = [
    normalizedRawQuery,
    asString(contextExistingSuggestion.query).trim(),
    asString(context.recentTranscript).trim(),
    asString(context.fullTranscript).trim(),
  ];

  const query = hasDirectCommand
    ? normalizedRawQuery
    : (() => {
        for (const candidate of fallbackQueryCandidates) {
          const normalized = sanitizePlannerQuery(candidate);
          if (normalized) return normalized;
        }
        return "";
      })();

  if (!query && !hasDirectCommand) {
    return {
      ok: false,
      error: "BrowserOS intent planner returned empty query for non-direct request.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
      text,
    };
  }

  // For excalidraw actions, browserosPrompt/SystemPrompt may be empty placeholders — that's OK.
  if (actionType !== "excalidraw" && (!plannerPrompt || !plannerSystemPrompt)) {
    return {
      ok: false,
      error: "BrowserOS intent planner response is missing prompt fields.",
      modelName: modelSelection.modelName,
      modelSource: modelSelection.source,
      text,
    };
  }

  return {
    ok: true,
    query,
    suggestionType,
    browserosPrompt: plannerPrompt,
    browserosSystemPrompt: plannerSystemPrompt,
    narrative,
    reasoning,
    actionType,
    excalidrawPrompt,
    excalidrawSystemPrompt,
    userNote,
    modelName: modelSelection.modelName,
    modelSource: modelSelection.source,
  };
}

async function runBrowserOsAutomation(payload) {
  console.error(`[browseros] automation starting pid=${process.pid}`);
  const settings = isObject(payload?.settings) ? payload.settings : {};
  const apiKeySelection = resolveOpenRouterApiKey(settings.apiKey);
  const apiKey = apiKeySelection.apiKey;
  if (!apiKey) {
    return { ok: false, error: "Missing OpenRouter API key for BrowserOS." };
  }

  const modelSelection = resolveModel(settings);
  const modelName = asString(modelSelection.modelName).trim();
  if (!modelName) {
    return { ok: false, error: "Missing model for BrowserOS automation." };
  }

  const context = isObject(payload?.context) ? payload.context : {};
  const startUrl = asString(context.url).trim();
  if (!isHttpUrl(startUrl)) {
    return { ok: false, error: "Missing valid BrowserOS start URL." };
  }

  const mcpConfigPath = asString(payload?.mcpConfigPath).trim();
  let tools = {};
  let clients = [];
  let serverSummaries = [];

  try {
    const loaded = await withTimeout(
      loadMcpTools(mcpConfigPath, {
        requireBrowserOs: true,
        onlyBrowserOs: true,
      }),
      mcpLoadTimeoutMs,
      "loadMcpTools"
    );
    tools = loaded.tools;
    clients = loaded.clients;
    serverSummaries = loaded.servers;
    console.error(`[browseros] MCP loaded: ${Object.keys(tools).length} tools, ${clients.length} client(s), browserOs=${loaded.browserOsConnected}`);
  } catch (error) {
    console.error(`[browseros] MCP load failed: ${error?.message || String(error)}`);
    return {
      ok: false,
      error: error?.message || String(error),
      startUrl,
    };
  }

  if (Object.keys(tools).length === 0) {
    return {
      ok: false,
      error: "No MCP tools are available for BrowserOS automation.",
      startUrl,
      mcpServers: serverSummaries,
    };
  }

  const activeBrowserOsTools = Object.keys(tools).filter((toolName) =>
    BROWSEROS_ACTIVE_TOOLS.has(toolName)
  );
  if (activeBrowserOsTools.length === 0) {
    return {
      ok: false,
      error:
        "Chrome DevTools MCP connected but no supported tools were available.",
      startUrl,
      mcpServers: serverSummaries,
    };
  }

  const openrouter = createOpenRouter({ apiKey });
  const model =
    typeof openrouter.chat === "function"
      ? openrouter.chat(modelName)
      : openrouter(modelName);

  const instructions =
    asString(payload?.instructions).trim() ||
    [
      "You are HeyJamie's browser automation copilot.",
      "Use Chrome DevTools MCP tools to interact with the browser.",
      "Be safe and avoid destructive actions.",
    ].join(" ");

  const prompt = buildBrowserOsPrompt(payload);

  try {
    // Close any leftover about:blank tabs from previous runs or Chrome launch.
    await closeBlankTabs(tools);

    // Reuse an existing tab rather than creating a new one.
    await selectOrReuseTab(tools, startUrl);

    // Wrap navigate_page so every navigation brings the tab to focus.
    wrapNavigateWithActivation(tools);

    // Activate the selected tab so Chrome's UI shows it immediately,
    // not just after the first navigate_page call.
    await activateCurrentPage(tools);

    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
      activeTools: activeBrowserOsTools,
      stopWhen: stepCountIs(browserOsMaxSteps),
      maxOutputTokens: browserOsMaxOutputTokens,
    });

    const result = await withTimeout(
      agent.generate({ prompt, abortSignal: globalAbort.signal }),
      browserOsGenerateTimeoutMs,
      "browseros.generate"
    );

    const text = asString(result?.text).trim();
    const parsedText = extractJsonPayload(text);
    const initialToolCallDetails = summarizeToolCalls(result);
    let toolCallDetails = initialToolCallDetails;
    let fallbackApplied = false;
    if (toolCallDetails.length === 0) {
      const fallbackToolCall = await executeBrowserOsNavigationFallback(tools, startUrl);
      if (fallbackToolCall) {
        toolCallDetails = [fallbackToolCall];
        fallbackApplied = true;
      }
    }
    const toolErrors = toolCallDetails.filter((call) => hasErrorInOutput(call.output));
    const actionSummaries = summarizeActionsFromToolCalls(toolCallDetails);

    const endUrl = deriveEndUrl(startUrl, parsedText, toolCallDetails);
    const parsedMessage = isObject(parsedText)
      ? asString(parsedText.message || parsedText.summary).trim()
      : "";
    const message =
      parsedMessage ||
      text ||
      (toolCallDetails.length > 0
        ? fallbackApplied
          ? "BrowserOS automation fallback navigated to the target URL."
          : "BrowserOS automation completed."
        : "BrowserOS automation produced no textual summary.");

    const parsedCompleted =
      isObject(parsedText) && typeof parsedText.completed === "boolean"
        ? parsedText.completed
        : undefined;

    const completed =
      typeof parsedCompleted === "boolean"
        ? parsedCompleted
        : toolCallDetails.length > 0 && toolErrors.length === 0;

    const ok = completed && toolErrors.length === 0 && toolCallDetails.length > 0;

    const contentSnapshot = await captureContentSnapshot(tools, "browser");

    return {
      ok,
      completed,
      message,
      startUrl,
      endUrl,
      actions: actionSummaries,
      toolCalls: toolCallDetails,
      toolErrorCount: toolErrors.length,
      modelName,
      modelSource: modelSelection.source,
      mcpServers: serverSummaries,
      rawText: text || null,
      fallbackApplied,
      llmToolCallCount: initialToolCallDetails.length,
      contentSnapshot,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      startUrl,
      endUrl: startUrl,
      modelName,
      modelSource: modelSelection.source,
      mcpServers: serverSummaries,
    };
  }
  // NOTE: Chrome DevTools MCP clients are intentionally NOT closed here.
  // Closing the stdio client would terminate the npx process, which shuts
  // down the Chrome instance it launched.  We want the browser window to
  // stay open so the user can see results.  The orphaned process will be
  // cleaned up when HeyJamie exits.
}

function buildExcalidrawPrompt(payload) {
  const context = isObject(payload?.context) ? payload.context : {};
  const topic = asString(context.topic).trim();
  const transcript = asString(context.transcript).trim();
  const excalidrawPrompt = asString(context.excalidrawPrompt).trim();
  const userPrompt = asString(payload?.prompt).trim();

  const lines = [
    "You are HeyJamie's Excalidraw diagram creator.",
    "Use the Excalidraw MCP tools to create diagrams based ONLY on what the user explicitly describes.",
    "",
    "IMPORTANT: Do NOT guess or invent components. Only draw elements that are explicitly mentioned in the transcript or prompt.",
    "If the user says 'show the architecture' but hasn't described what components exist yet, do NOT draw anything - just read the guide and wait.",
    "It is perfectly fine to have a blank canvas until the user provides specific details about what to draw.",
    "",
    "Follow these steps IN ORDER:",
    "1. Call `read_diagram_guide` to learn best-practice color palettes, sizing rules, and layout patterns.",
    "2. If the user asks to modify, rename, or delete existing elements, first call `describe_scene` to get the current elements and their IDs.",
    "3. Use `batch_create_elements` (preferred for multiple elements) or `create_element` to add new elements. Use rectangles, arrows, text, ellipses, and diamonds as appropriate. Position elements clearly with enough spacing.",
    "4. Use `update_element` with the element ID to modify existing elements. When updating text, you MUST pass the complete new text value in the `text` property - do not pass empty strings. When updating position, pass `x` and `y`. Use `delete_element` with the element ID to remove elements.",
    "5. Optionally call `describe_scene` to verify the diagram looks correct.",
    "6. Call `set_viewport` with scrollToContent=true to auto-fit the diagram.",
    "7. Call `export_to_excalidraw_url` to get a shareable Excalidraw URL.",
    "",
    "After completing all steps, return STRICT JSON only with this schema:",
    '{"completed":true,"message":"string describing what was diagrammed","diagramUrl":"the excalidraw URL from export_to_excalidraw_url"}',
    "",
    "If you cannot complete the diagram, return:",
    '{"completed":false,"message":"explanation of what went wrong"}',
    "",
    "## Layout and spacing (IMPORTANT)",
    "NEVER overlap elements. Use generous spacing between all elements:",
    "- Minimum 150px horizontal gap between adjacent boxes",
    "- Minimum 120px vertical gap between rows of elements",
    "- Make boxes wide enough to fit their text (minimum 180px width for labels)",
    "- Position arrow labels away from other elements to avoid collisions",
    "- When adding new elements to an existing diagram, check positions of existing elements first and place new ones in empty space",
    "- Use the full canvas - spread elements out rather than clustering them together",
    "",
    "## Multi-section diagrams",
    "When the topic describes multiple sections, subgraphs, or stages, visually group related nodes using large background-colored rectangles with low opacity (e.g., light blue, light green). Label each group with a bold title at the top of the rectangle.",
    "Arrange sections in a clear spatial layout — left-to-right or top-to-bottom — so the overall flow is easy to follow.",
    "",
    "## Corrections in transcript",
    "If the transcript contains corrections ('actually...', 'wait, I forgot...', 'no scratch that...'), the corrected version supersedes the earlier statement. Only diagram the final corrected version, not the mistake.",
    "",
    "## Incomplete requests",
    "If a request to update an element is incomplete or unclear (e.g., 'change the label to...' without specifying the new label), do NOT clear the existing content. Keep the element unchanged and wait for more information. Never leave a box empty that previously had text, and never guess what the new content should be.",
  ];

  if (excalidrawPrompt) {
    lines.push(`\nDiagram instructions: ${excalidrawPrompt}`);
  }
  if (topic) {
    lines.push(`Topic: ${topic}`);
  }
  if (transcript) {
    lines.push(`Transcript context: ${truncateText(transcript, 1500)}`);
  }
  if (userPrompt) {
    lines.push(`Planner prompt: ${userPrompt}`);
  }

  return lines.join("\n");
}

async function runExcalidrawAutomation(payload) {
  const settings = isObject(payload?.settings) ? payload.settings : {};
  const apiKeySelection = resolveOpenRouterApiKey(settings.apiKey);
  const apiKey = apiKeySelection.apiKey;
  if (!apiKey) {
    return { ok: false, error: "Missing OpenRouter API key for Excalidraw." };
  }

  const modelSelection = resolveModel(settings);
  const modelName = asString(modelSelection.modelName).trim();
  if (!modelName) {
    return { ok: false, error: "Missing model for Excalidraw automation." };
  }

  const mcpConfigPath = asString(payload?.mcpConfigPath).trim();
  let tools = {};
  let clients = [];
  let serverSummaries = [];

  try {
    const loaded = await withTimeout(
      loadMcpTools(mcpConfigPath, {
        onlyExcalidraw: true,
      }),
      mcpLoadTimeoutMs,
      "loadMcpTools.excalidraw"
    );
    tools = loaded.tools;
    clients = loaded.clients;
    serverSummaries = loaded.servers;
    var excalidrawCanvasUrl = loaded.excalidrawCanvasUrl || "";

    if (!loaded.excalidrawConnected) {
      for (const client of clients) {
        try { await client.close(); } catch { /* ignore */ }
        activeMcpClients.delete(client);
      }
      return {
        ok: false,
        error: "Excalidraw MCP server is not connected. Add an Excalidraw MCP server in Settings -> MCP Config.",
        mcpServers: serverSummaries,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }

  const activeExcalidrawTools = Object.keys(tools).filter((toolName) =>
    EXCALIDRAW_ACTIVE_TOOLS.has(toolName)
  );
  if (activeExcalidrawTools.length === 0) {
    for (const client of clients) {
      try { await client.close(); } catch { /* ignore */ }
      activeMcpClients.delete(client);
    }
    return {
      ok: false,
      error: "Excalidraw MCP connected but no supported tools were available.",
      mcpServers: serverSummaries,
    };
  }

  const openrouter = createOpenRouter({ apiKey });
  const model =
    typeof openrouter.chat === "function"
      ? openrouter.chat(modelName)
      : openrouter(modelName);

  const instructions =
    asString(payload?.instructions).trim() ||
    "You are HeyJamie's Excalidraw diagram creator. Use MCP tools to create diagrams.";

  const prompt = buildExcalidrawPrompt(payload);

  // Lazy-clear: wrap element-creating tools so the canvas is cleared
  // only when the agent actually starts drawing, not at session start.
  // This preserves the previous diagram if the agent is cancelled before drawing.
  const shouldClear = Boolean(isObject(payload?.context) && payload.context.clearCanvas);
  if (shouldClear && excalidrawCanvasUrl) {
    let canvasCleared = false;
    const CLEAR_BEFORE_TOOLS = ["create_element", "batch_create_elements"];
    for (const toolName of CLEAR_BEFORE_TOOLS) {
      const original = tools[toolName];
      if (isObject(original) && typeof original.execute === "function") {
        tools[toolName] = {
          ...original,
          async execute(...args) {
            if (!canvasCleared) {
              canvasCleared = true;
              try {
                const clearResp = await fetch(
                  `${excalidrawCanvasUrl}/api/elements/clear`,
                  { method: "DELETE" }
                );
                if (clearResp.ok) {
                  console.error("[excalidraw] cleared canvas before first draw");
                } else {
                  console.error(`[excalidraw] failed to clear canvas: ${clearResp.status}`);
                }
              } catch (clearErr) {
                console.error(`[excalidraw] failed to clear canvas: ${clearErr?.message || clearErr}`);
              }
            }
            return original.execute.apply(original, args);
          },
        };
      }
    }
  }

  try {
    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
      activeTools: activeExcalidrawTools,
      stopWhen: stepCountIs(excalidrawMaxSteps),
    });

    const result = await withTimeout(
      agent.generate({ prompt, abortSignal: globalAbort.signal }),
      excalidrawGenerateTimeoutMs,
      "excalidraw.generate"
    );

    const text = asString(result?.text).trim();
    const parsedText = extractJsonPayload(text);
    const toolCallDetails = summarizeToolCalls(result);

    console.error(`[excalidraw] agent finished. toolCalls=${toolCallDetails.length} tools=[${toolCallDetails.map(c => c.name).join(",")}] textLen=${text.length}`);

    if (toolCallDetails.length === 0) {
      console.error(
        `[excalidraw] WARNING: model ${modelName} made zero tool calls. rawText (first 300 chars): ${text.slice(0, 300)}`
      );
    }

    // Extract diagram URL from export_to_excalidraw_url tool call output
    let shareUrl = "";
    for (const call of toolCallDetails) {
      if (call.name === "export_to_excalidraw_url") {
        const urls = extractUrls(call.output);
        if (urls.length > 0) {
          shareUrl = urls[0];
        }
      }
    }

    // Also check the parsed text for diagramUrl, but only if the agent
    // actually called tools.  Without this guard the LLM can hallucinate a
    // URL in its text response and the result would look successful while
    // the Excalidraw canvas is empty.
    if (!shareUrl && toolCallDetails.length > 0 && isObject(parsedText)) {
      const parsedUrl = asString(parsedText.diagramUrl).trim();
      if (isHttpUrl(parsedUrl)) {
        shareUrl = parsedUrl;
      }
    }

    // Prefer the local canvas URL over the excalidraw.com share URL so the
    // app opens the locally-hosted Excalidraw instance where the diagram was
    // already rendered, rather than redirecting to excalidraw.com.
    const diagramUrl = (excalidrawCanvasUrl && (shareUrl || toolCallDetails.length > 0))
      ? excalidrawCanvasUrl
      : shareUrl;

    const parsedMessage = isObject(parsedText)
      ? asString(parsedText.message || parsedText.summary).trim()
      : "";

    const noToolCallsError = toolCallDetails.length === 0
      ? `Model ${modelName} did not use Excalidraw tools. Try a different model (e.g. anthropic/claude-sonnet-4).`
      : "";
    const message = noToolCallsError || parsedMessage || text || "Excalidraw diagram created.";

    const parsedCompleted =
      isObject(parsedText) && typeof parsedText.completed === "boolean"
        ? parsedText.completed
        : undefined;

    const completed =
      typeof parsedCompleted === "boolean"
        ? parsedCompleted
        : Boolean(diagramUrl);

    const ok = completed && Boolean(diagramUrl);

    const contentSnapshot = await captureContentSnapshot(tools, "excalidraw");

    return {
      ok,
      completed,
      message,
      diagramUrl,
      error: noToolCallsError || undefined,
      toolCalls: toolCallDetails,
      modelName,
      modelSource: modelSelection.source,
      mcpServers: serverSummaries,
      rawText: text || null,
      contentSnapshot,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      modelName,
      modelSource: modelSelection.source,
      mcpServers: serverSummaries,
    };
  } finally {
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
      activeMcpClients.delete(client);
    }
  }
}

/**
 * Lightweight navigate-only mode: connect to persistent Chrome via MCP,
 * clean up blank tabs, reuse an existing tab, and navigate to the URL.
 * No LLM involved — just direct MCP tool calls.
 */
async function runBrowserOsNavigate(payload) {
  console.error(`[browseros-navigate] starting pid=${process.pid}`);
  const context = isObject(payload?.context) ? payload.context : {};
  const startUrl = asString(context.url).trim();
  if (!isHttpUrl(startUrl)) {
    return { ok: false, error: "Missing valid URL for browseros-navigate." };
  }

  const mcpConfigPath = asString(payload?.mcpConfigPath).trim();
  let tools = {};
  let clients = [];

  try {
    const loaded = await withTimeout(
      loadMcpTools(mcpConfigPath, {
        requireBrowserOs: true,
        onlyBrowserOs: true,
      }),
      mcpLoadTimeoutMs,
      "loadMcpTools.navigate"
    );
    tools = loaded.tools;
    clients = loaded.clients;
    console.error(`[browseros-navigate] MCP loaded: ${Object.keys(tools).length} tools`);
  } catch (error) {
    console.error(`[browseros-navigate] MCP load failed: ${error?.message || String(error)}`);
    return { ok: false, error: error?.message || String(error), startUrl };
  }

  try {
    await closeBlankTabs(tools);
    await selectOrReuseTab(tools, startUrl);

    const navigatePage = tools["navigate_page"];
    if (!isObject(navigatePage) || typeof navigatePage.execute !== "function") {
      return { ok: false, error: "navigate_page tool not available.", startUrl };
    }

    await withTimeout(
      navigatePage.execute({ url: startUrl }),
      15_000,
      "browseros-navigate.navigate"
    );

    // Bring the navigated tab to the foreground in Chrome.
    await activateCurrentPage(tools);

    // Derive final URL via list_pages
    let endUrl = startUrl;
    const listPages = tools["list_pages"];
    if (isObject(listPages) && typeof listPages.execute === "function") {
      try {
        const output = await withTimeout(listPages.execute({}), 5_000, "browseros-navigate.list");
        const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
        const urls = extractUrls(text);
        if (urls.length > 0) {
          endUrl = urls[urls.length - 1];
        }
      } catch {
        // keep startUrl as endUrl
      }
    }

    console.error(`[browseros-navigate] done: ${startUrl} → ${endUrl}`);
    return { ok: true, startUrl, endUrl };
  } catch (error) {
    console.error(`[browseros-navigate] failed: ${error?.message || String(error)}`);
    return { ok: false, error: error?.message || String(error), startUrl };
  }
  // MCP clients intentionally not closed (see runBrowserOsAutomation).
}

async function runGeneralAgent(payload) {
  const settings = isObject(payload?.settings) ? payload.settings : {};
  const instructions = asString(payload?.instructions).trim();
  const prompt = asString(payload?.prompt).trim();
  const mcpConfigPath = asString(payload?.mcpConfigPath).trim();

  const apiKeySelection = resolveOpenRouterApiKey(settings.apiKey);
  const modelSelection = resolveModel(settings);
  const effectiveApiKey = apiKeySelection.apiKey;
  const effectiveModel = asString(modelSelection.modelName).trim();

  if (!effectiveApiKey || !effectiveModel) {
    throw new Error("Missing OpenRouter settings.");
  }

  const openrouter = createOpenRouter({ apiKey: effectiveApiKey });
  const model =
    typeof openrouter.chat === "function"
      ? openrouter.chat(effectiveModel)
      : openrouter(effectiveModel);

  let clients = [];
  let tools = {};

  try {
    const loaded = await withTimeout(
      loadMcpTools(mcpConfigPath, { requireBrowserOs: false }),
      mcpLoadTimeoutMs,
      "loadMcpTools"
    );
    clients = loaded.clients;
    tools = loaded.tools;

    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
    });

    const result = await withTimeout(
      agent.generate({ prompt, abortSignal: globalAbort.signal }),
      agentGenerateTimeoutMs,
      "agent.generate"
    );

    const text = asString(result?.text).trim();
    const toolCallDetails = summarizeToolCalls(result);
    if (!text) {
      throw new Error("LLM agent returned empty text.");
    }

    return {
      text,
      toolCalls: toolCallDetails,
    };
  } finally {
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        // ignore close errors
      }
      activeMcpClients.delete(client);
    }
  }
}

async function testMcpServers(configPath) {
  if (!configPath) {
    return { ok: false, error: "Missing MCP config path." };
  }

  let config;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }

  const servers = isObject(config?.mcpServers) ? config.mcpServers : {};
  const results = [];

  for (const [name, server] of Object.entries(servers)) {
    if (!isServerEnabled(server)) {
      results.push({
        name,
        ok: true,
        skipped: true,
        reason: "disabled",
        browserOs: isBrowserOsServer(name, server),
      });
      continue;
    }
    try {
      const { client, transport } = await createClientForServer(name, server);
      const tools = await client.tools();
      await client.close();
      results.push({
        name,
        ok: true,
        transport,
        tools: Object.keys(tools),
        browserOs: isBrowserOsServer(name, server),
      });
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: error?.message || String(error),
        browserOs: isBrowserOsServer(name, server),
      });
    }
  }

  return { ok: results.every((item) => item.ok), servers: results };
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    throw new Error("Missing LLM agent input.");
  }

  const payload = JSON.parse(input);

  if (payload?.mode === "mcp-test") {
    const summary = await testMcpServers(asString(payload?.mcpConfigPath).trim());
    process.stdout.write(JSON.stringify(summary));
    return;
  }

  if (payload?.mode === "browseros-intent") {
    let result;
    try {
      result = await runBrowserOsIntentPlanner(payload);
    } catch (error) {
      console.error(
        `[browseros-intent] fatal failure: ${error?.message || String(error)}`
      );
      result = {
        ok: false,
        error: error?.message || String(error),
      };
    }
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (payload?.mode === "topic-shift-detect") {
    let result;
    try {
      result = await runTopicShiftDetection(payload);
    } catch (error) {
      console.error(
        `[topic-shift-detect] fatal failure: ${error?.message || String(error)}`
      );
      result = {
        ok: false,
        error: error?.message || String(error),
      };
    }
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (payload?.mode === "browseros-act") {
    let result;
    try {
      result = await runBrowserOsAutomation(payload);
    } catch (error) {
      console.error(`[browseros] fatal failure: ${error?.message || String(error)}`);
      result = {
        ok: false,
        error: error?.message || String(error),
      };
    }
    await writeAndDrain(JSON.stringify(result));
    process.exit(0);
  }

  if (payload?.mode === "browseros-navigate") {
    let result;
    try {
      result = await runBrowserOsNavigate(payload);
    } catch (error) {
      console.error(`[browseros-navigate] fatal failure: ${error?.message || String(error)}`);
      result = {
        ok: false,
        error: error?.message || String(error),
      };
    }
    await writeAndDrain(JSON.stringify(result));
    process.exit(0);
  }

  if (payload?.mode === "excalidraw-act") {
    let result;
    try {
      result = await runExcalidrawAutomation(payload);
    } catch (error) {
      console.error(`[excalidraw] fatal failure: ${error?.message || String(error)}`);
      result = {
        ok: false,
        error: error?.message || String(error),
      };
    }
    await writeAndDrain(JSON.stringify(result));
    process.exit(0);
  }

  const genericResult = await runGeneralAgent(payload);
  process.stdout.write(JSON.stringify(genericResult));
}

main().catch(async (error) => {
  console.error(error?.message || String(error));
  await sleep(10);
  process.exit(1);
});
