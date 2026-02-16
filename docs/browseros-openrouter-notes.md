# Chrome DevTools MCP + OpenRouter Runtime Notes

Date: 2026-02-15 (updated: topic shift detection improvements)

This document describes the current Chrome DevTools MCP-first runtime used by HeyJamie.

## Scope

- `src/App.tsx`
- `scripts/llm-agent.mjs`
- `src-tauri/src/lib.rs`
- `src/SettingsApp.tsx`

## Current Flow

1. Frontend captures mic audio and sends WAV segments to `transcribe_audio`.
2. Transcript deltas are analyzed in `src/App.tsx` for topic shift (heuristic + optional LLM confirmation).
3. On topic shift (or direct `Hey Jamie ...` command), frontend schedules a deep dive.
4. Frontend calls `run_llm_agent` intent pass with `mode: "browseros-intent"`, including `latestSpeech` (the newest transcript lines since the last evaluation) so the planner can distinguish new content from older context.
5. Intent planner decides `actionType`: `"browser"` (web research) or `"excalidraw"` (diagram creation).
6. If `actionType` is `"browser"`: frontend calls execution pass with `mode: "browseros-act"`.
7. If `actionType` is `"excalidraw"`: frontend calls execution pass with `mode: "excalidraw-act"`.
8. Rust launches `node scripts/llm-agent.mjs` and forwards payload (`settings`, `instructions`, `prompt`, `context`, `mcpConfigPath`).
9. Node loads MCP servers from config (Chrome DevTools MCP-only or Excalidraw-only depending on mode), runs the ToolLoop agent, and returns structured JSON.

## MCP Requirements

Browser deep dives require a Chrome DevTools MCP server entry. Excalidraw diagram creation requires an Excalidraw MCP server entry. Example:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "excalidraw": {
      "transport": "http",
      "url": "https://excalidraw-mcp-app.vercel.app/mcp"
    }
  }
}
```

The app supports both MCP stdio servers (`command` + `args`) and HTTP/SSE servers (`url` + optional `transport`).

Chrome DevTools MCP uses **stdio transport** — it launches its own Chrome instance automatically. No manual Chrome launch or debugging flags are needed.

### Chrome DevTools MCP Tools

- `take_snapshot`: returns an accessibility tree with uid identifiers for each element.
- `click`: click an element by uid.
- `navigate_page`: navigate to a URL.
- `fill`: type into an input field.
- `press_key`: keyboard actions (PageDown/PageUp for scrolling).
- `list_pages`: list open pages and their URLs.
- `evaluate_script`: run JavaScript in the page (useful for DOM search on large pages).
- `new_page`, `close_page`, `select_page`, `wait_for`, `fill_form`, `hover`, `drag`, `handle_dialog`, `upload_file`, `take_screenshot`.

### Excalidraw MCP Tools

The Excalidraw MCP server is hosted externally and provides three tools:
- `read_me`: learn the element format and available shapes.
- `create_view`: create a diagram with positioned elements.
- `export_to_excalidraw`: export the diagram and get a shareable URL.

## Config Migration

On first launch after upgrading from BrowserOS, the app automatically migrates the MCP config:
- If `"browseros"` entry exists and `"chrome-devtools"` does not, the old entry is replaced.
- Migration runs before every `run_llm_agent` call and when Settings is opened.
- Migration is idempotent — subsequent calls are no-ops.

## Key Behavioral Rules

- Deep dives are debounced (`BROWSEROS_DEEPDIVE_DEBOUNCE_MS = 1200`).
- Direct commands are transcript-triggered:
  - `Hey Jamie ...` (minor spelling variations handled).
- Topic-shift detection uses transcript novelty, intent-anchor checks, and LLM-based confirmation.
- When excalidraw is the active task and heuristic signals suggest a potential topic shift (score >= 2), an LLM call (`mode: "topic-shift-detect"`) confirms the shift before switching action types.
- The intent planner receives a `latestSpeech` field containing only the newest transcript lines since the last evaluation. This prevents older context (e.g. architecture keywords) from overriding the planner's actionType decision when the user has shifted to a new topic (e.g. podcasts).
- If Chrome DevTools MCP is unavailable, runtime returns structured errors instead of empty output.
- Chrome DevTools MCP clients are intentionally NOT closed after automation runs, so the Chrome browser window stays open for the user to see results.
- Each automation run opens a new Chrome window (not reusing existing tabs).

## Settings Surface

`src/SettingsApp.tsx` contains:

- OpenRouter credentials + default model + reasoning toggle.
- OpenRouter test prompt runner.
- Browser automation note with Chrome DevTools MCP config guidance.
- MCP config editor/test tools.

## Environment Variables

### OpenRouter / model selection

- `VITE_HEYJAMIE_LLM_MODEL`
- `HEYJAMIE_LLM_MODEL`
- `VITE_HEYJAMIE_OPENROUTER_API_KEY`
- `HEYJAMIE_OPENROUTER_API_KEY`

### Runtime timeouts

- `HEYJAMIE_BROWSEROS_TIMEOUT_MS` (default 180s) — browser automation (`browseros-act` mode)
- `HEYJAMIE_LLM_TIMEOUT_MS` (default 45s) — general agent
- `HEYJAMIE_INTENT_TIMEOUT_MS` (default 90s) — intent planner (`browseros-intent` mode)
- `HEYJAMIE_EXCALIDRAW_TIMEOUT_MS` (default 120s) — excalidraw agent (`excalidraw-act` mode)
- `HEYJAMIE_TOPIC_SHIFT_TIMEOUT_MS` (default 15s) — LLM topic shift detection (`topic-shift-detect` mode)
- `HEYJAMIE_MCP_LOAD_TIMEOUT_MS`

### Browser launcher

- `HEYJAMIE_BROWSEROS_APP_NAME` — macOS app name for fallback browser window opening (default: `Google Chrome`).

## Failure Signatures and Triage

### `Missing OpenRouter settings`

- Ensure OpenRouter key/model exist in settings or env overrides.

### Chrome DevTools MCP connection errors

- Ensure `npx` is available in the system PATH.
- Check that `chrome-devtools-mcp@latest` installs correctly: `npx -y chrome-devtools-mcp@latest --help`.
- Use Settings -> Test MCP servers to verify the connection.
- Check `heyjamie.log` for stderr output from the Chrome DevTools MCP process.

### `llm agent timed out after ...ms`

- For browser automation: increase `HEYJAMIE_BROWSEROS_TIMEOUT_MS` (default 180s).
- For intent planner: increase `HEYJAMIE_INTENT_TIMEOUT_MS` (default 90s).
- For Excalidraw: increase `HEYJAMIE_EXCALIDRAW_TIMEOUT_MS` (default 120s). The multi-step MCP tool loop (read_me → create_view → export_to_excalidraw) requires multiple LLM calls via OpenRouter, each taking ~20-40s. Total 3-step flow typically takes 60-120s; 180-240s recommended if timeouts persist.
- Check `heyjamie.log` for runtime stderr output.

## Content Snapshots (Test Analytics)

After each automation run completes, `llm-agent.mjs` captures a **content snapshot** — a textual summary of what's actually displayed in the diagram or browser page. This lets eval expectations verify rendered content, not just whether events fired.

### How it works

The `captureContentSnapshot(tools, type)` helper in `llm-agent.mjs` calls MCP tools directly:

- **Excalidraw** (`type: "excalidraw"`): calls the `describe_scene` MCP tool, which returns a text description of all elements currently on the canvas.
- **Browser** (`type: "browser"`): calls `evaluate_script` to run `document.title` + `document.body.innerText.slice(0, 2000)`, returning a concise page summary. This avoids `take_snapshot` which returns the full accessibility tree and would flood the log.

The helper is non-fatal — returns `null` on any error or if the required MCP tool is unavailable. Results are truncated to 3000 characters. A 10-second timeout prevents hangs.

### Data flow

1. `runExcalidrawAutomation` / `runBrowserOsAutomation` call `captureContentSnapshot` after the `ok` computation.
2. The `contentSnapshot` string (or `null`) is included in the return object.
3. `src/App.tsx` logs `contentSnapshot` in the `excalidraw-response` and `browseros-response` test events via `appendTestLogEvent`.
4. `eval-integration-test.mjs` supports a `contentSnapshotContains` match criterion for verifying snapshot content in eval expectations.

### Eval expectation usage

Add `contentSnapshotContains` to the `match` object of any expectation:

```json
{
  "id": "diagram-has-database",
  "event": "excalidraw-response",
  "match": {
    "ok": true,
    "contentSnapshotContains": "database"
  }
}
```

```json
{
  "id": "page-shows-results",
  "event": "browseros-response",
  "match": {
    "ok": true,
    "contentSnapshotContains": "Search results"
  }
}
```

The match uses case-insensitive substring matching (via `strContains`), consistent with the other `*Contains` criteria.

## Validation Checklist

1. `nvm use`
2. `npm run build`
3. `npm run tauri dev`
4. Validate one live deep dive:
   - transcript grows,
   - Active Deep Dive updates,
   - Chrome DevTools MCP tools execute and narrative/session log updates.
5. Validate Excalidraw diagram creation:
   - discuss a topic suited for a diagram (e.g. system architecture, flowcharts),
   - intent planner routes to `actionType: "excalidraw"`,
   - Excalidraw MCP tools are called (`read_me` -> `create_view` -> `export_to_excalidraw`),
   - diagram URL appears in narrative and opens in the browser.
6. Validate topic shift from excalidraw to browser:
   - discuss a topic suited for a diagram (e.g. system architecture),
   - then shift to discussing a podcast or other browsable topic,
   - intent planner should switch from `actionType: "excalidraw"` to `actionType: "browser"`.
7. Optional mock validation:
   - `npm run tauri:dev:mock:topic-changes`
   - `npm run tauri:dev:mock:excalidraw-diagram`
   - `npm run tauri:dev:mock:excalidraw-diagram:integration` (requires OpenRouter credentials)
   - `node scripts/eval-topic-shift-to-podcast.mjs` (requires OpenRouter credentials)
