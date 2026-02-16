# CLAUDE.md

## Development

### Running the app

Prefer running the app in dev mode rather than building and installing a macOS DMG:

```bash
npm run tauri dev
```

### Browser automation

Browser automation uses [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) via stdio transport (`npx chrome-devtools-mcp@latest`). It launches its own Chrome instance automatically. The default MCP config entry is:

```json
"chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest", "--ignore-default-chrome-arg=--enable-automation"] }
```

### Quality checks

Build quality gate used by CI and the Ralph autonomous loop:

```bash
npm run quality-check                                                    # tsc + vite build
bash scripts/ralph/run-quality-checks.sh --scenario excalidraw-diagram   # build + integration test
```

### Ralph autonomous loop

Ralph (`scripts/ralph/`) is an autonomous development loop that invokes Claude Code repeatedly to implement stories from a PRD. See `README.md` for full documentation.

```bash
cp scripts/ralph/prd.json.example scripts/ralph/prd.json
# edit prd.json with stories
npm run ralph
```

Key files:
- `scripts/ralph/ralph.sh` — Main loop (invokes `claude --dangerously-skip-permissions --print`)
- `scripts/ralph/prompt.md` — Prompt template piped to each iteration
- `scripts/ralph/prd.json` — Stories (gitignored, create from `.example`)
- `scripts/ralph/progress.txt` — Progress log (gitignored, auto-created)
- `scripts/ralph/run-quality-checks.sh` — Quality gate (tsc + vite build + optional eval)

# HeyJamie Status

## Summary

HeyJamie uses a Chrome DevTools MCP-first research flow with Excalidraw diagram support.
The app records microphone audio, transcribes locally with `whisper.cpp`,
detects transcript topic shifts, and launches either browser deep dives
(web research) or Excalidraw diagram creation depending on the topic.
The previous frontend LLM suggestion-generation loop has been removed.

## Current Behavior

- UI: IDE-style header with status badges, listen toggle, and meter.
- Sidebar: transcript + "Active Deep Dive" (current topic/query).
- Main panel: Browser deep dive narrative output + session log (tool calls + topics).
- Audio: mic capture → 16 kHz WAV segments (8s segment, 2s min) →
  `transcribe_audio`.
- Transcription: backend invokes `whisper-cli` with `ggml-base.en.bin`.
- Setup: if whisper CLI/model are missing, app shows setup banner and can run
  in-app installation.
- Automation:
  - Topic-shift deep dives are debounced and transcript-driven.
  - Direct commands (`Hey Jamie ...`) trigger immediate browser command mode.
  - Intent planner decides between `browser` (web research) and `excalidraw` (diagram creation) action types.
  - Browser automation uses Chrome DevTools MCP (stdio transport via `npx chrome-devtools-mcp@latest`), which launches its own Chrome instance.
  - Chrome DevTools MCP tools: `take_snapshot` (a11y tree with uid), `click` (by uid), `navigate_page`, `fill`, `press_key`, `list_pages`, `evaluate_script`, etc.
  - Excalidraw diagrams are generated via mcp_excalidraw MCP tools (`read_diagram_guide` -> `batch_create_elements` -> `describe_scene` -> `export_to_excalidraw_url`) and opened as shareable URLs.
- Settings window:
  - OpenRouter credentials + model + reasoning toggle.
  - OpenRouter test prompt runner.
  - Browser automation note (manual suggestion settings removed).
  - MCP config editor/test tools.

## MCP Status

- MCP config/testing still exists in settings and backend commands.
- Browser deep dives require a Chrome DevTools MCP server entry in MCP config (default: `"chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }`).
- Excalidraw diagram creation uses [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) — a local canvas server + stdio MCP server with element-level control, iterative refinement, and 26 tools. Requires running the canvas server (`npm run canvas` on port 3000) and configuring the MCP stdio entry with `EXPRESS_SERVER_URL=http://localhost:3000`.
- Runtime supports both MCP stdio servers (`command` + `args`) and HTTP/SSE servers (`url` + optional `transport`).
- On first launch after migration from BrowserOS, the old `browseros` HTTP config entry is automatically replaced with the new `chrome-devtools` stdio entry.

## Key Files

- `index.html`: React entry point
- `settings.html`: Settings React entry point
- `src/main.tsx`: mounts main React app
- `src/settings.tsx`: mounts settings app
- `src/App.tsx`: main UI + transcript-to-browser deep dive pipeline
- `src/SettingsApp.tsx`: OpenRouter + MCP settings UI
- `src/openrouter.ts`: localStorage helpers/defaults
- `scripts/llm-agent.mjs`: Chrome DevTools MCP/Excalidraw/OpenRouter runtime + MCP client loader
- `src-tauri/src/lib.rs`: Tauri commands (`transcribe_audio`, `run_llm_agent`,
  `cancel_llm_agent`, `check_whisper`, `setup_whisper`, MCP config commands, config migration)
- `scripts/setup-whisper.sh`: whisper.cpp install/build helper
- `src-tauri/Info.plist`: microphone/speech usage strings
- `src-tauri/tauri.conf.json`: app metadata
- `vite.config.ts`: Vite config + multi-page entry (main/settings)

## Whisper Setup

- In-app setup runs `scripts/setup-whisper.sh`.
- Script clones `ggml-org/whisper.cpp`, downloads `ggml-base.en`, builds
  `whisper-cli` via CMake.
- Default lookup:
  - `whisper_cpp/build/bin/whisper-cli`
  - `whisper_cpp/models/ggml-base.en.bin`
- Optional overrides:
  - `WHISPER_CLI_PATH`
  - `WHISPER_MODEL_PATH`

## OpenRouter Settings

- Open via native menu: File → Settings.
- Stored in browser `localStorage` key `heyjamie.openrouter`.
- Fields:
  - API key
  - Default model
  - Reasoning toggle
- Test prompt calls:
  - `https://openrouter.ai/api/v1/chat/completions`

## Logs

- Frontend (DevTools): mic capture, queue/drain, deep-dive scheduling, browser automation logs.
- Backend terminal (`npm run tauri dev`): whisper execution + llm-agent process logs.
- File log: `heyjamie.log` in OS temp dir.
  - macOS: `tail -f "$TMPDIR/heyjamie.log"`
  - Linux: `tail -f /tmp/heyjamie.log`

## Known Issues / Investigation Notes

- Transcription may return empty text on some segments.
- If transcript seems missing, verify:
  - `whisper-cli` path resolution
  - model path resolution
  - whisper stderr output
  - frontend RMS logs (mic is not silent)
- If deep dives are not running:
  - OpenRouter key availability
  - topic-shift gating logs in frontend
  - `run_llm_agent` timeout logs / Chrome DevTools MCP stderr in `heyjamie.log`
- Chrome DevTools MCP clients are intentionally NOT closed after automation runs.
  Closing the stdio client would terminate the npx process, which shuts down
  the Chrome instance. The browser window stays open so the user can see results.
- Excalidraw agent may time out with default 120s timeout due to multi-step MCP tool loop (each LLM call ~20-40s via OpenRouter). Increase via `HEYJAMIE_EXCALIDRAW_TIMEOUT_MS=240000`.
- Intent planner has a dedicated 90s timeout (`HEYJAMIE_INTENT_TIMEOUT_MS`), separate from the general LLM timeout.

## Run Commands

Always run `nvm use` in new shells before `npm`/`npx`.

```bash
nvm use
npm install
npm run tauri dev
```

## Mock Transcript Runs

```bash
nvm use
npm run tauri:dev:mock
npm run tauri:dev:mock:topic-changes
npm run tauri:dev:mock:topic-changes:integration
npm run tauri:dev:mock:excalidraw-diagram
npm run tauri:dev:mock:excalidraw-diagram:integration
```

For integration runs that require OpenRouter credentials from `.env`, export the
file into the shell before running the script:

```bash
nvm use
set -a
source .env
set +a
npm run tauri:dev:mock:topic-changes:integration
```

## Build Bundled App (macOS)

```bash
nvm use
npm run tauri build -- --debug --bundles app
open "src-tauri/target/debug/bundle/macos/HeyJamie.app"
```

## Build Bundled App (Linux)

```bash
nvm use
npm run tauri build -- --debug --bundles deb   # or appimage
```

### Linux Prerequisites

Whisper build dependencies (Debian/Ubuntu):
```bash
sudo apt install build-essential cmake git
```

Fedora:
```bash
sudo dnf install gcc gcc-c++ cmake git
```

Optional — Chrome window focus support:
```bash
sudo apt install xdotool
```

## Permissions (macOS)

- `NSMicrophoneUsageDescription`
- `NSSpeechRecognitionUsageDescription`

## Permissions (Linux)

- Mic access uses PipeWire/PulseAudio — no plist equivalent needed.

## Ralph Autonomous Loop

Ralph (`scripts/ralph/`) is an autonomous AI agent loop that drives Claude Code
through repeated iterations to implement user stories from a PRD.

- **Loop**: `ralph.sh` pipes `prompt.md` to `claude --dangerously-skip-permissions --print`
- **Stories**: `prd.json` (gitignored) — copy from `prd.json.example`
- **Quality gate**: `run-quality-checks.sh` — tsc + vite build + optional integration test eval
- **Progress**: `progress.txt` (gitignored) — learnings persist across iterations
- **Branch management**: reads `branchName` from `prd.json`, creates/checks out branch
- **Completion**: loop exits when Claude outputs `<promise>COMPLETE</promise>`
- **Integration tests**: stories with `testScenario` field trigger end-to-end eval runs;
  `scorePercent` must meet `minScorePercent` threshold

Run: `npm run ralph` (default 10 iterations), `npm run ralph:20` (20 iterations).

## Recent Changes

- Removed frontend LLM suggestion-generation loop.
- Added transcript-driven browser deep-dive scheduling.
- Added direct `Hey Jamie ...` transcript command execution path.
- Replaced "Suggested Searches" UI with "Active Deep Dive".
- Removed suggestion settings module (`src/suggestions.ts`) and settings controls.
- Replaced BrowserOS MCP with Chrome DevTools MCP (`chrome-devtools-mcp@latest` via stdio transport):
  - Tool names changed from `browser_navigate`, `browser_click_element`, etc. to `navigate_page`, `click`, `take_snapshot`, `fill`, `press_key`, `list_pages`, `evaluate_script`, etc.
  - Server detection updated to match `chrome-devtools` / `chromedevtools` names and `chrome-devtools-mcp` in command/args.
  - Port fallback infrastructure removed (not needed for stdio transport).
  - Default MCP config changed from `"browseros": { "transport": "http", "url": "..." }` to `"chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }`.
  - Automatic config migration: old `browseros` entries are replaced with `chrome-devtools` on first access.
  - Browser window always opens in a new Chrome window (not reusing existing tabs).
  - Chrome DevTools MCP clients are not closed after automation to keep the browser window open.
- Added Excalidraw MCP integration (`excalidraw-act` mode):
  - Intent planner decides `actionType: "browser" | "excalidraw"` per topic.
  - Excalidraw agent uses [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) — local canvas server + stdio MCP with element-level control (create, update, delete, batch_create, describe_scene, export, etc.).
  - Diagrams open as shareable Excalidraw URLs in the browser.
  - Default MCP config uses stdio transport with `EXPRESS_SERVER_URL` pointing to the local canvas server.
- Added dedicated timeout tiers: intent planner (90s), excalidraw (120s), browser automation (180s), general (45s).
- Added integration test for excalidraw diagram creation (`excalidraw-diagram` mock transcript + eval expectations).
