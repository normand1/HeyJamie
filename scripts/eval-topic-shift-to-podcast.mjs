#!/usr/bin/env node

/**
 * End-to-end integration test for topic shift detection from architecture to podcasts.
 *
 * Validates that when user shifts from discussing system architecture to talking
 * about podcasts, the intent planner correctly switches from excalidraw to browser action.
 *
 * Usage:
 *   node scripts/eval-topic-shift-to-podcast.mjs [--output <report.json>] [--timeout <ms>]
 *
 * Environment:
 *   VITE_HEYJAMIE_OPENROUTER_API_KEY or HEYJAMIE_OPENROUTER_API_KEY must be set.
 */

import { readFileSync, existsSync, unlinkSync, watchFile, unwatchFile } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const TRANSCRIPT_ID = "topic-shift-to-podcast";
const VITE_PORT = 1436;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { output: null, timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--output":
        args.output = argv[++i];
        break;
      case "--timeout":
        args.timeout = parseInt(argv[++i], 10);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(2);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Log polling — wait for "run-complete" event
// ---------------------------------------------------------------------------

function waitForRunComplete(logPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function checkLog() {
      if (!existsSync(logPath)) return false;
      try {
        const raw = readFileSync(logPath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.event === "run-complete") return true;
          } catch { /* skip */ }
        }
      } catch { /* file may be mid-write */ }
      return false;
    }

    // Check immediately
    if (checkLog()) { resolve(); return; }

    // Poll via fs.watchFile (works even if file doesn't exist yet)
    const interval = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(interval);
        unwatchFile(logPath, onChange);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for run-complete in ${logPath}`));
        return;
      }
      if (checkLog()) {
        clearInterval(interval);
        unwatchFile(logPath, onChange);
        resolve();
      }
    }, 2000);

    function onChange() {
      if (checkLog()) {
        clearInterval(interval);
        unwatchFile(logPath, onChange);
        resolve();
      }
    }
    watchFile(logPath, { interval: 1000 }, onChange);
  });
}

// ---------------------------------------------------------------------------
// Kill process tree
// ---------------------------------------------------------------------------

function killTree(pid) {
  try {
    // On macOS/Linux, kill the process group
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
  // Follow up with SIGKILL after a short delay
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* ok */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* ok */ }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const logPath = resolve(join(projectRoot, `heyjamie-integration-test-${TRANSCRIPT_ID}.log`));
  const expectationsFile = join(projectRoot, "docs", "eval-expectations", `${TRANSCRIPT_ID}.json`);

  // Validate API key
  const apiKey =
    process.env.VITE_HEYJAMIE_OPENROUTER_API_KEY ||
    process.env.HEYJAMIE_OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "Error: VITE_HEYJAMIE_OPENROUTER_API_KEY or HEYJAMIE_OPENROUTER_API_KEY must be set."
    );
    process.exit(2);
  }

  console.log(`=== Integration Test: ${TRANSCRIPT_ID} ===`);
  console.log(`Log path:         ${logPath}`);
  console.log(`Expectations:     ${expectationsFile}`);
  console.log(`Timeout:          ${args.timeout}ms`);
  console.log("");

  // Remove stale log from a previous run
  if (existsSync(logPath)) {
    unlinkSync(logPath);
    console.log("Removed stale log file from previous run.");
  }

  // Build tauri dev config for this transcript
  const tauriConfig = JSON.stringify({
    build: {
      beforeDevCommand: `vite --host --port ${VITE_PORT} --strictPort`,
      devUrl: `http://localhost:${VITE_PORT}/?mockTranscript=${TRANSCRIPT_ID}`,
    },
  });

  // Launch the Tauri app
  console.log("Launching Tauri app with mock transcript...");
  const child = spawn("npx", ["tauri", "dev", "--config", tauriConfig], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      VITE_HEYJAMIE_OPENROUTER_API_KEY: apiKey,
      HEYJAMIE_OPENROUTER_API_KEY: apiKey,
      VITE_HEYJAMIE_LLM_MODEL: process.env.HEYJAMIE_LLM_MODEL || "anthropic/claude-sonnet-4",
      HEYJAMIE_LLM_MODEL: process.env.HEYJAMIE_LLM_MODEL || "anthropic/claude-sonnet-4",
      VITE_HEYJAMIE_ENABLE_TEST_LOG: "1",
      HEYJAMIE_TEST_LOG_PATH: logPath,
    },
  });

  child.stdout.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.log(`  [app] ${text}`);
  });
  child.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.log(`  [app:err] ${text}`);
  });

  let exitCode = 0;

  try {
    console.log("Waiting for run-complete event in log...");
    await waitForRunComplete(logPath, args.timeout);
    console.log("run-complete detected!\n");

    // Give a small buffer for any final log writes
    await new Promise((r) => setTimeout(r, 2000));
  } catch (err) {
    console.error(`\n${err.message}`);
    exitCode = 1;
  } finally {
    // Kill the app
    console.log("Stopping Tauri app...");
    killTree(child.pid);
    // Wait a moment for cleanup
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Run the evaluation if the log exists
  if (!existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(2);
  }

  console.log("Running evaluation...\n");
  const evalScript = join(projectRoot, "scripts", "eval-integration-test.mjs");
  const evalArgs = [evalScript, "--log", logPath, "--expectations", expectationsFile];
  if (args.output) {
    evalArgs.push("--output", args.output);
  }

  try {
    const result = execFileSync("node", evalArgs, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(result);
  } catch (err) {
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();
