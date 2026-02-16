#!/usr/bin/env node

/**
 * Excalidraw MCP Test Harness
 *
 * Tests the Excalidraw MCP server functions directly without requiring
 * the full Tauri app. Useful for troubleshooting MCP connectivity,
 * individual tool calls, and the full agent automation pipeline.
 *
 * Usage:
 *   node scripts/test-excalidraw-mcp.mjs                  # Run all tests
 *   node scripts/test-excalidraw-mcp.mjs connect           # Test MCP connection only
 *   node scripts/test-excalidraw-mcp.mjs list-tools        # List available tools
 *   node scripts/test-excalidraw-mcp.mjs read-me           # Call read_me tool
 *   node scripts/test-excalidraw-mcp.mjs create-view       # Call create_view with a sample diagram
 *   node scripts/test-excalidraw-mcp.mjs export            # Call export_to_excalidraw (requires prior create_view)
 *   node scripts/test-excalidraw-mcp.mjs full-flow         # Run create_view + export end-to-end
 *   node scripts/test-excalidraw-mcp.mjs agent             # Run the full ToolLoopAgent automation
 *
 * Environment:
 *   HEYJAMIE_OPENROUTER_API_KEY or VITE_HEYJAMIE_OPENROUTER_API_KEY  (required for "agent" mode)
 *   HEYJAMIE_LLM_MODEL or VITE_HEYJAMIE_LLM_MODEL                   (optional, default: google/gemini-2.0-flash-001)
 *   EXCALIDRAW_MCP_URL                                                (optional, override server URL)
 */

import "dotenv/config";
import fs from "node:fs/promises";
import process from "node:process";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { join as pathJoin } from "node:path";
const DEFAULT_MCP_CONFIG_PATH = pathJoin(
  process.env.HOME,
  "Library/Application Support/com.heyjamie.app/mcp.json"
);

const DEFAULT_EXCALIDRAW_URL = "https://excalidraw-mcp-app.vercel.app/mcp";
const EXCALIDRAW_MCP_URL =
  process.env.EXCALIDRAW_MCP_URL || DEFAULT_EXCALIDRAW_URL;

const ACTIVE_TOOLS = new Set(["read_me", "create_view", "export_to_excalidraw"]);

// Sample diagram: microservices architecture
// NOTE: The MCP server expects `elements` as a JSON *string*, not a parsed array.
const SAMPLE_DIAGRAM_ELEMENTS = [
  {
    type: "rectangle",
    x: 300,
    y: 50,
    width: 200,
    height: 60,
    backgroundColor: "#a5d8ff",
    label: { text: "API Gateway" },
  },
  {
    type: "rectangle",
    x: 50,
    y: 200,
    width: 160,
    height: 60,
    backgroundColor: "#b2f2bb",
    label: { text: "User Service" },
  },
  {
    type: "rectangle",
    x: 300,
    y: 200,
    width: 160,
    height: 60,
    backgroundColor: "#b2f2bb",
    label: { text: "Order Service" },
  },
  {
    type: "rectangle",
    x: 550,
    y: 200,
    width: 160,
    height: 60,
    backgroundColor: "#b2f2bb",
    label: { text: "Payment Service" },
  },
  {
    type: "arrow",
    x: 350,
    y: 110,
    endX: 130,
    endY: 200,
    label: { text: "" },
  },
  {
    type: "arrow",
    x: 400,
    y: 110,
    endX: 380,
    endY: 200,
    label: { text: "" },
  },
  {
    type: "arrow",
    x: 450,
    y: 110,
    endX: 630,
    endY: 200,
    label: { text: "" },
  },
];
const SAMPLE_DIAGRAM_ELEMENTS_STR = JSON.stringify(SAMPLE_DIAGRAM_ELEMENTS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(startMs) {
  return `${((Date.now() - startMs) / 1000).toFixed(2)}s`;
}

function banner(title) {
  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(`${line}\n`);
}

function section(title) {
  console.log(`\n--- ${title} ---\n`);
}

function logJson(label, value) {
  console.log(`${label}:`);
  console.log(JSON.stringify(value, null, 2));
  console.log();
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MCP Connection
// ---------------------------------------------------------------------------

async function connectToExcalidraw(url) {
  const start = Date.now();
  console.log(`Connecting to Excalidraw MCP server: ${url}`);

  const client = await createMCPClient({
    transport: {
      type: "http",
      url,
    },
  });

  console.log(`Connected in ${elapsed(start)}`);
  return client;
}

async function getToolsFromClient(client) {
  const start = Date.now();
  const tools = await client.tools();
  console.log(`Retrieved ${Object.keys(tools).length} tools in ${elapsed(start)}`);
  return tools;
}

async function callTool(tools, toolName, args = {}) {
  const tool = tools[toolName];
  if (!tool) {
    throw new Error(
      `Tool "${toolName}" not found. Available: ${Object.keys(tools).join(", ")}`
    );
  }

  const start = Date.now();
  console.log(`Calling ${toolName}(${JSON.stringify(args)})...`);

  const result = await tool.execute(args);
  console.log(`${toolName} completed in ${elapsed(start)}`);
  return result;
}

// ---------------------------------------------------------------------------
// Test: connect
// ---------------------------------------------------------------------------

async function testConnect() {
  banner("TEST: MCP Connection");
  let client;
  try {
    client = await withTimeout(
      connectToExcalidraw(EXCALIDRAW_MCP_URL),
      15_000,
      "connect"
    );
    console.log("PASS: Successfully connected to Excalidraw MCP server");
    return true;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    return false;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Test: list-tools
// ---------------------------------------------------------------------------

async function testListTools() {
  banner("TEST: List Tools");
  let client;
  try {
    client = await withTimeout(
      connectToExcalidraw(EXCALIDRAW_MCP_URL),
      15_000,
      "connect"
    );
    const tools = await withTimeout(
      getToolsFromClient(client),
      10_000,
      "getTools"
    );

    const toolNames = Object.keys(tools);
    console.log(`\nAvailable tools (${toolNames.length}):`);
    for (const name of toolNames) {
      const tool = tools[name];
      const active = ACTIVE_TOOLS.has(name) ? " [ACTIVE]" : " [not used]";
      const desc = tool.description
        ? ` - ${tool.description.slice(0, 100)}`
        : "";
      console.log(`  ${name}${active}${desc}`);

      // Show full parameter schema
      if (tool.parameters) {
        const params = tool.parameters;
        if (params.properties) {
          for (const [pName, pSchema] of Object.entries(params.properties)) {
            const required = params.required?.includes(pName) ? " (required)" : " (optional)";
            const type = pSchema.type || "unknown";
            const pDesc = pSchema.description ? ` - ${pSchema.description.slice(0, 120)}` : "";
            console.log(`    ${pName}: ${type}${required}${pDesc}`);
          }
        }
      }
    }

    const missing = [...ACTIVE_TOOLS].filter((t) => !toolNames.includes(t));
    if (missing.length > 0) {
      console.log(`\nWARNING: Expected active tools missing: ${missing.join(", ")}`);
    } else {
      console.log("\nPASS: All expected active tools are available");
    }
    return true;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    return false;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Test: read_me
// ---------------------------------------------------------------------------

async function testReadMe() {
  banner("TEST: read_me");
  let client;
  try {
    client = await withTimeout(
      connectToExcalidraw(EXCALIDRAW_MCP_URL),
      15_000,
      "connect"
    );
    const tools = await withTimeout(
      getToolsFromClient(client),
      10_000,
      "getTools"
    );

    const result = await withTimeout(
      callTool(tools, "read_me", {}),
      30_000,
      "read_me"
    );

    logJson("read_me result", result);
    console.log("PASS: read_me returned successfully");
    return true;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    return false;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Test: create_view
// ---------------------------------------------------------------------------

async function testCreateView() {
  banner("TEST: create_view");
  let client;
  try {
    client = await withTimeout(
      connectToExcalidraw(EXCALIDRAW_MCP_URL),
      15_000,
      "connect"
    );
    const tools = await withTimeout(
      getToolsFromClient(client),
      10_000,
      "getTools"
    );

    section("Calling create_view with sample microservices diagram");
    const result = await withTimeout(
      callTool(tools, "create_view", { elements: SAMPLE_DIAGRAM_ELEMENTS_STR }),
      30_000,
      "create_view"
    );

    logJson("create_view result", result);
    console.log("PASS: create_view returned successfully");
    return { success: true, client, tools };
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    if (client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Test: export_to_excalidraw
// ---------------------------------------------------------------------------

async function testExport(existingClient, existingTools) {
  banner("TEST: export_to_excalidraw");

  let client = existingClient;
  let tools = existingTools;
  let ownClient = false;

  try {
    if (!client) {
      ownClient = true;
      client = await withTimeout(
        connectToExcalidraw(EXCALIDRAW_MCP_URL),
        15_000,
        "connect"
      );
      tools = await withTimeout(
        getToolsFromClient(client),
        10_000,
        "getTools"
      );

      // Need to create a view first
      section("Creating view first (required before export)");
      const createResult = await withTimeout(
        callTool(tools, "create_view", { elements: SAMPLE_DIAGRAM_ELEMENTS_STR }),
        30_000,
        "create_view"
      );
      logJson("create_view result", createResult);
    }

    section("Calling export_to_excalidraw");
    // The export tool requires a `json` parameter - pass the elements JSON
    const result = await withTimeout(
      callTool(tools, "export_to_excalidraw", { json: SAMPLE_DIAGRAM_ELEMENTS_STR }),
      30_000,
      "export_to_excalidraw"
    );

    logJson("export_to_excalidraw result", result);

    // Try to extract URL from result
    const resultStr = JSON.stringify(result);
    const urlMatch = resultStr.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      console.log(`Diagram URL: ${urlMatch[0]}`);
      console.log("PASS: export_to_excalidraw returned a URL");
    } else {
      console.log("WARNING: No URL found in export result");
    }

    return true;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    return false;
  } finally {
    if (ownClient && client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Test: full-flow (create_view + export, single connection)
// ---------------------------------------------------------------------------

async function testFullFlow() {
  banner("TEST: Full Flow (create_view -> export_to_excalidraw)");
  let client;
  try {
    client = await withTimeout(
      connectToExcalidraw(EXCALIDRAW_MCP_URL),
      15_000,
      "connect"
    );
    const tools = await withTimeout(
      getToolsFromClient(client),
      10_000,
      "getTools"
    );

    // Step 1: read_me
    section("Step 1: read_me");
    const readMeResult = await withTimeout(
      callTool(tools, "read_me", {}),
      30_000,
      "read_me"
    );
    logJson("read_me result", readMeResult);

    // Step 2: create_view
    section("Step 2: create_view");
    const createResult = await withTimeout(
      callTool(tools, "create_view", { elements: SAMPLE_DIAGRAM_ELEMENTS_STR }),
      30_000,
      "create_view"
    );
    logJson("create_view result", createResult);

    // Step 3: export (requires `json` param with the elements)
    section("Step 3: export_to_excalidraw");
    const exportResult = await withTimeout(
      callTool(tools, "export_to_excalidraw", { json: SAMPLE_DIAGRAM_ELEMENTS_STR }),
      30_000,
      "export_to_excalidraw"
    );
    logJson("export_to_excalidraw result", exportResult);

    const resultStr = JSON.stringify(exportResult);
    const urlMatch = resultStr.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      console.log(`Diagram URL: ${urlMatch[0]}`);
      console.log("\nPASS: Full flow completed with diagram URL");
    } else {
      console.log("\nWARNING: Full flow completed but no URL in export result");
    }

    return true;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    return false;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Test: agent (full ToolLoopAgent automation, same as the app)
// ---------------------------------------------------------------------------

async function testAgent() {
  banner("TEST: ToolLoopAgent Automation");

  const apiKey =
    process.env.HEYJAMIE_OPENROUTER_API_KEY ||
    process.env.VITE_HEYJAMIE_OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "SKIP: Set HEYJAMIE_OPENROUTER_API_KEY or VITE_HEYJAMIE_OPENROUTER_API_KEY to run the agent test."
    );
    return false;
  }

  const modelName =
    process.env.HEYJAMIE_LLM_MODEL ||
    process.env.VITE_HEYJAMIE_LLM_MODEL ||
    "google/gemini-2.0-flash-001";

  console.log(`Model: ${modelName}`);
  console.log(`API key source: ${process.env.HEYJAMIE_OPENROUTER_API_KEY ? "HEYJAMIE_OPENROUTER_API_KEY" : "VITE_HEYJAMIE_OPENROUTER_API_KEY"}`);
  console.log(`MCP URL: ${EXCALIDRAW_MCP_URL}\n`);

  // Write a temp MCP config pointing to the excalidraw server
  const tmpConfigPath = "/tmp/heyjamie-test-mcp.json";
  await fs.writeFile(
    tmpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          excalidraw: {
            transport: "http",
            url: EXCALIDRAW_MCP_URL,
          },
        },
      },
      null,
      2
    )
  );

  // Build the same payload the Tauri app would send
  const payload = {
    mode: "excalidraw-act",
    mcpConfigPath: tmpConfigPath,
    settings: {
      apiKey,
      model: modelName,
    },
    instructions:
      "You are a diagram creation agent. Use the Excalidraw MCP tools to create a clear, well-organized diagram.",
    prompt:
      "Create a diagram showing a microservices architecture with an API gateway routing to three services: User Service, Order Service, and Payment Service. Each service should have its own database.",
    context: {
      topic: "microservices architecture",
      excalidrawPrompt:
        "Draw boxes for API Gateway at the top, three service boxes below (User, Order, Payment), and database cylinders below each service. Connect with arrows.",
      transcript:
        "I'm designing a microservices system with an API gateway that routes requests to three backend services.",
    },
  };

  section("Payload");
  logJson("Agent payload", {
    ...payload,
    settings: { ...payload.settings, apiKey: `${apiKey.slice(0, 8)}...` },
  });

  // Invoke the same way Tauri does: pipe payload via stdin to llm-agent.mjs
  const { spawn } = await import("node:child_process");
  const scriptPath = new URL("./llm-agent.mjs", import.meta.url).pathname;

  return new Promise((resolve) => {
    section("Running llm-agent.mjs (excalidraw-act mode)");
    const start = Date.now();

    const child = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HEYJAMIE_OPENROUTER_API_KEY: apiKey,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      // Stream stderr live for visibility
      process.stderr.write(`  [agent:err] ${text}`);
    });

    child.on("close", (code) => {
      section("Agent Result");
      console.log(`Exit code: ${code}`);
      console.log(`Duration: ${elapsed(start)}`);

      if (stderr.trim()) {
        console.log(`\nStderr:\n${stderr.trim()}\n`);
      }

      if (stdout.trim()) {
        try {
          const result = JSON.parse(stdout.trim());
          logJson("Agent output", result);

          if (result.ok && result.diagramUrl) {
            console.log(`Diagram URL: ${result.diagramUrl}`);
            console.log("\nPASS: Agent automation completed with diagram URL");
          } else if (result.ok) {
            console.log(
              "\nWARNING: Agent reported ok=true but no diagramUrl found"
            );
          } else {
            console.log(
              `\nFAIL: Agent reported ok=false: ${result.error || result.message || "unknown"}`
            );
          }

          if (result.toolCalls) {
            section("Tool Call Summary");
            for (const call of result.toolCalls) {
              const outputPreview =
                typeof call.output === "string"
                  ? call.output.slice(0, 200)
                  : JSON.stringify(call.output)?.slice(0, 200);
              console.log(`  ${call.name}:`);
              console.log(`    input: ${JSON.stringify(call.input)?.slice(0, 200)}`);
              console.log(`    output: ${outputPreview}`);
              console.log();
            }
          }
        } catch {
          console.log(`Raw stdout:\n${stdout.trim()}`);
          console.log("\nFAIL: Could not parse agent output as JSON");
        }
      } else {
        console.log("FAIL: No stdout output from agent");
      }

      resolve(code === 0);
    });

    // Write payload to stdin and close
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    // Timeout
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch { /* ignore */ }
      console.log("\nFAIL: Agent timed out after 120s");
      resolve(false);
    }, 120_000);
  });
}

// ---------------------------------------------------------------------------
// Test: tool-schemas (dump raw parameter schemas for each tool)
// ---------------------------------------------------------------------------

async function testToolSchemas() {
  banner("TEST: Tool Schemas (raw)");
  let client;
  try {
    client = await withTimeout(
      connectToExcalidraw(EXCALIDRAW_MCP_URL),
      15_000,
      "connect"
    );
    const tools = await withTimeout(
      getToolsFromClient(client),
      10_000,
      "getTools"
    );

    for (const [name, tool] of Object.entries(tools)) {
      section(name);
      console.log("Description:", tool.description?.slice(0, 200) || "(none)");
      console.log("Parameters:", JSON.stringify(tool.parameters, null, 2));
      console.log();
    }

    console.log("PASS: Tool schemas retrieved");
    return true;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    return false;
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Test: loadMcpTools (test using the real mcp.json config)
// ---------------------------------------------------------------------------

async function testLoadFromConfig() {
  banner("TEST: Load from MCP Config");

  const configPath = DEFAULT_MCP_CONFIG_PATH;
  let configExists = false;
  try {
    await fs.access(configPath);
    configExists = true;
  } catch { /* not found */ }

  if (!configExists) {
    console.log(`SKIP: MCP config not found at ${configPath}`);
    return false;
  }

  console.log(`Config: ${configPath}`);
  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw);
  logJson("MCP config", config);

  // Check excalidraw server entry
  const servers = config?.mcpServers || {};
  const excalidrawEntry = Object.entries(servers).find(([name, srv]) => {
    const n = name.toLowerCase();
    const url = (srv?.url || "").toLowerCase();
    return n.includes("excalidraw") || url.includes("excalidraw");
  });

  if (!excalidrawEntry) {
    console.log("FAIL: No excalidraw server found in MCP config");
    return false;
  }

  console.log(
    `Found excalidraw server: "${excalidrawEntry[0]}" -> ${excalidrawEntry[1].url}`
  );

  // Try connecting using the config URL
  let client;
  try {
    client = await withTimeout(
      connectToExcalidraw(excalidrawEntry[1].url),
      15_000,
      "connect-from-config"
    );
    const tools = await withTimeout(
      getToolsFromClient(client),
      10_000,
      "getTools-from-config"
    );

    const toolNames = Object.keys(tools);
    console.log(`Tools from config: ${toolNames.join(", ")}`);

    const missing = [...ACTIVE_TOOLS].filter((t) => !toolNames.includes(t));
    if (missing.length > 0) {
      console.log(`WARNING: Missing expected tools: ${missing.join(", ")}`);
    } else {
      console.log("PASS: Config-based connection succeeded with all expected tools");
    }
    return true;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    return false;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const TESTS = {
  connect: testConnect,
  "list-tools": testListTools,
  "tool-schemas": testToolSchemas,
  "read-me": testReadMe,
  "create-view": async () => {
    const { success, client } = await testCreateView();
    if (client) {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
    return success;
  },
  export: () => testExport(null, null),
  "full-flow": testFullFlow,
  agent: testAgent,
  config: testLoadFromConfig,
};

async function runAll() {
  banner("Excalidraw MCP Test Harness");
  console.log(`MCP URL: ${EXCALIDRAW_MCP_URL}`);
  console.log(`Time:    ${new Date().toISOString()}\n`);

  const results = {};
  // Run non-agent tests in order
  for (const name of ["connect", "list-tools", "read-me", "full-flow", "config"]) {
    results[name] = await TESTS[name]();
  }

  // Summary
  banner("Summary");
  let allPass = true;
  for (const [name, pass] of Object.entries(results)) {
    const status = pass ? "PASS" : "FAIL";
    console.log(`  ${status}  ${name}`);
    if (!pass) allPass = false;
  }

  console.log(
    `\n${allPass ? "All tests passed!" : "Some tests failed."}`
  );
  console.log(
    '\nTo run the full agent test (requires API key):\n  node scripts/test-excalidraw-mcp.mjs agent\n'
  );
}

async function main() {
  const command = process.argv[2];

  if (!command || command === "all") {
    await runAll();
    return;
  }

  if (command === "--help" || command === "-h") {
    console.log(`
Excalidraw MCP Test Harness

Usage:
  node scripts/test-excalidraw-mcp.mjs [command]

Commands:
  (none) / all    Run all non-agent tests
  connect         Test MCP server connection
  list-tools      List available MCP tools with details
  tool-schemas    Dump raw parameter schemas for each tool
  read-me         Call the read_me tool
  create-view     Call create_view with a sample diagram
  export          Call export_to_excalidraw (creates view first)
  full-flow       Run read_me -> create_view -> export end-to-end
  agent           Run the full ToolLoopAgent automation (requires API key)
  config          Test loading from the real mcp.json config

Environment:
  EXCALIDRAW_MCP_URL                  Override the Excalidraw MCP server URL
  HEYJAMIE_OPENROUTER_API_KEY        API key for agent test
  HEYJAMIE_LLM_MODEL                 Model for agent test (default: google/gemini-2.0-flash-001)
`);
    return;
  }

  const testFn = TESTS[command];
  if (!testFn) {
    console.error(
      `Unknown command: "${command}". Run with --help for usage.`
    );
    process.exit(2);
  }

  const pass = await testFn();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
