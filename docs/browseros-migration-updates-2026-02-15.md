# Browser Automation Migration Updates

This document captures the browser automation migration history.

## Chrome DevTools MCP Migration (2026-02-15)

Replaced BrowserOS MCP (HTTP transport to `localhost:9000`) with Chrome DevTools MCP (stdio transport via `npx chrome-devtools-mcp@latest`).

### What Changed

#### `scripts/llm-agent.mjs`

- **Tool names**: Replaced 14 BrowserOS tool names (`browser_navigate`, `browser_click_element`, `browser_get_active_tab`, etc.) with Chrome DevTools MCP tools (`navigate_page`, `click`, `take_snapshot`, `fill`, `press_key`, `list_pages`, `evaluate_script`, etc.).
- **Server detection** (`isBrowserOsServer()`): Now detects `chrome-devtools` / `chromedevtools` in name and `chrome-devtools-mcp` in command/args, with backward compat for `browseros`.
- **Removed port fallback infrastructure**: `browserOsFallbackPorts`, `parseEnvPortList()`, `withUrlPort()` removed. `buildServerCandidates()` simplified to return `[server]` (stdio doesn't need port scanning).
- **`buildBrowserOsPrompt()`**: Rewritten for Chrome DevTools MCP tools — `take_snapshot` for page content (a11y tree with uid), `click` with uid, `navigate_page` for URLs, `list_pages` for final URL capture.
- **Navigation fallback**: Changed from `browser_navigate`/`browser_open_tab` to `navigate_page`/`new_page`.
- **`autoAcceptExcalidrawOverride()`**: Rewritten to use `take_snapshot` + `click` with uid instead of `browser_get_active_tab`/`browser_grep_interactive_elements`/`browser_click_element`.
- **Client lifecycle**: Chrome DevTools MCP clients are intentionally NOT closed after automation runs. Closing the stdio client would terminate the npx process, which shuts down the Chrome instance. The browser window stays open for the user.
- **Error messages**: Updated to reference "Chrome DevTools MCP" instead of "BrowserOS MCP".

#### `src-tauri/src/lib.rs`

- **Default MCP config**: Changed from `"browseros": { "transport": "http", "url": "http://127.0.0.1:9000/mcp" }` to `"chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }`.
- **Automatic config migration**: Added `ensure_mcp_config_migrated()` — replaces old `browseros` entry with `chrome-devtools` on first access. Runs in `get_mcp_config`, `run_llm_agent`, and `test_mcp_config`.
- **Browser app name**: Default changed from `"BrowserOS"` to `"Google Chrome"`.
- **Browser window**: Always opens a new Chrome window (not reusing existing tabs).

#### `src/openrouter.ts`

- **Intent planner prompt**: Added Chrome DevTools MCP tool guidance (`take_snapshot`, `click`, `navigate_page`, `fill`, `press_key`).

#### `src/App.tsx`

- **Error detection**: Added `"chrome devtools mcp server is not connected"` and `"chrome-devtools mcp"` patterns.
- **`buildDefaultBrowserOSPrompts()`**: Updated from BrowserOS tool guidance to Chrome DevTools snapshot/click guidance.
- **UI text**: "BrowserOS Deep Dive" → "Browser Deep Dive", "Running BrowserOS deep dive" → "Running browser deep dive", etc.

#### `src/SettingsApp.tsx`

- **Card title**: "BrowserOS Automation" → "Browser Automation".
- **MCP guidance**: Updated to show Chrome DevTools MCP config example, removed `chrome://browseros/mcp` reference.

### Mode strings preserved (minimal rename)

Internal mode strings (`"browseros-intent"`, `"browseros-act"`) and variable names (`browserosInFlightRef`, `browserosRunCountRef`, etc.) were intentionally kept to minimize diff size.

---

## Original BrowserOS Migration (2026-02-15)

### Scope Completed

- Replaced Stagehand/Chrome automation runtime with BrowserOS MCP runtime.
- Updated frontend, backend, settings UI, and docs to BrowserOS terminology and execution flow.
- Removed Stagehand package dependency from the app runtime.

### Runtime Changes

#### `scripts/llm-agent.mjs`

- Added BrowserOS execution modes: `browseros-intent`, `browseros-act`.
- Added Excalidraw execution mode: `excalidraw-act`.
- Added BrowserOS-only MCP loading (`onlyBrowserOs` + `requireBrowserOs`).
- Added Excalidraw-only MCP loading (`onlyExcalidraw` + `excalidrawConnected` tracking).
- Added MCP connection fallback candidates for BrowserOS URLs with configurable ports (now removed in Chrome DevTools MCP migration).
- Added BrowserOS tool-output sanitization/truncation to reduce context bloat.
- Restricted act runs to known tools (`activeTools` list).
- Added Excalidraw automation functions.
- Added loop/output bounds for agent runs (`stopWhen` + `maxOutputTokens`).

#### `src/App.tsx`

- Updated run path to open browser window when helper/MCP connectivity is missing, retry after open, retry on transient provider errors.
- Added Excalidraw routing (`actionType: "browser" | "excalidraw"`).

#### `src-tauri/src/lib.rs`

- Added Excalidraw MCP server to default config.
- Added `excalidraw-act` mode timeout handling.

### Excalidraw Integration (2026-02-15)

- Planner instructions restructured to make `actionType` the first decision.
- Backend `runBrowserOsIntentPlanner()` updated to extract and return excalidraw fields.
- Timeout increases: intent planner 45s → 90s, excalidraw 60s → 120s.
- Added Excalidraw integration test (mock transcript + eval expectations).
- Added frontend test instrumentation (excalidraw counter refs + run-complete events).
