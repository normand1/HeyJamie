# Browser Automation Fixes — 2026-02-15

This session fixed several critical issues that were breaking BrowserOS automation end-to-end: a JavaScript crash in MCP tool loading, Chrome instance lifecycle problems causing about:blank tab floods, redundant search generation, and a Chrome infobar warning.

---

## Fix 1: `const` reassignment crash in MCP tool loading (critical)

**File:** `scripts/llm-agent.mjs` (line 604)

**Problem:** The `loadMcpTools()` for-of loop declared `server` with `const`, but a later line reassigned it to inject stealth Chrome flags:

```javascript
for (const [name, server] of Object.entries(servers)) { ... }
// later:
server = { ...server, args };  // TypeError: Assignment to constant variable
```

This crashed every MCP tool load, meaning browser automation never connected. The agent always fell back to osascript, which just opened new browser tabs without any page interaction.

**Fix:** Changed `const` to `let` in the destructuring.

---

## Fix 2: Persistent Chrome process (architectural)

**Files:** `scripts/llm-agent.mjs`

**Problem:** Each `browseros-act` request spawned a new Node process → new MCP process → new Chrome instance (with an `about:blank` tab). When the frontend cancelled a request for a topic shift, the Node process was killed (SIGKILL), which cascaded to kill MCP and Chrome. The next request found no Chrome and launched another, creating another `about:blank` tab. With rapid topic shifts, 6–7 about:blank tabs accumulated.

Additional complications discovered during debugging:
- chrome-devtools-mcp uses **pipe-based debugging** (not TCP), so it never writes a `DevToolsActivePort` file. The original port-file-based Chrome reuse strategy was fundamentally broken.
- The profile directory was `chrome-profile`, not `chrome-profile-stable` as assumed.

**Fix:** Chrome is now launched as a **detached process** independent of Node/MCP:

1. `ensurePersistentChrome()` checks if Chrome is already listening on port 9224 (TCP probe)
2. If not, `launchPersistentChrome()` spawns Chrome with `--remote-debugging-port=9224` using `child_process.spawn()` with `detached: true` and `child.unref()`
3. MCP is told to connect to the existing Chrome via `--browserUrl=http://127.0.0.1:9224`
4. When Node/MCP die on cancel, Chrome stays alive
5. Next request finds Chrome on port 9224 and reuses it — no new instance, no new about:blank tab

A lockfile (`/tmp/heyjamie-chrome-launch.lock`) coordinates concurrent launches so only one process starts Chrome.

### New constants and functions

| Name | Purpose |
|------|---------|
| `CHROME_DEBUG_PORT` (9224) | Fixed debugging port, configurable via `HEYJAMIE_CHROME_DEBUG_PORT` |
| `CHROME_USER_DATA_DIR` | `~/.cache/chrome-devtools-mcp/chrome-profile` |
| `isPortReachable(port)` | TCP probe to check if a port is listening |
| `findChromeBinary()` | Locates Chrome on macOS, configurable via `HEYJAMIE_CHROME_BINARY` |
| `launchPersistentChrome()` | Spawns Chrome detached with remote debugging |
| `ensurePersistentChrome()` | Orchestrates reuse or launch with lockfile coordination |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEYJAMIE_CHROME_DEBUG_PORT` | `9224` | Chrome remote debugging port |
| `HEYJAMIE_CHROME_BINARY` | auto-detect | Path to Chrome binary |

---

## Fix 3: Remove `new_page` from active tools

**File:** `scripts/llm-agent.mjs`

**Problem:** The LLM agent had `new_page` in its available tools (`BROWSEROS_ACTIVE_TOOLS`), which it sometimes used instead of `navigate_page`. Each `new_page` call creates a new tab, potentially leaving old tabs (including `about:blank`) behind.

**Fix:**
- Removed `new_page` from `BROWSEROS_ACTIVE_TOOLS` — the agent can only use `navigate_page` now
- Removed `new_page` from the navigation fallback candidates
- Added `closeBlankTabs()` function that runs before each automation to clean up any lingering `about:blank` tabs via `list_pages` + `close_page`

---

## Fix 4: Suppress osascript fallback on Chrome connection errors

**File:** `src/App.tsx`

**Problem:** When BrowserOS automation failed with "Protocol error: Target closed" (Chrome died), the frontend opened a new tab via osascript as a fallback. Since Chrome was broken, this just added useless tabs.

**Fix:** Both the error-path fallback and the exception-handler fallback now detect Chrome connection errors (`/target closed|protocol error|connection/i`) and suppress the osascript tab open. Applies to:
- The `!ok` branch (line ~2700): added `isChromeConnectionError` / `isChromeConnectionMessage` checks to `shouldSkipFallback`
- The `catch` block (line ~2750): checks `errorStr` before calling `openSuggestionUrl`

---

## Fix 5: Planner instructions to avoid redundant searches

**File:** `src/App.tsx`

**Problem:** With MCP now working, the agent successfully explored search results. But the planner kept generating near-duplicate Google searches for the same topic on each cycle, instead of reusing the page already open.

**Fix:** Added an "Avoiding Redundant Searches" section to `plannerInstructionLines` (before "General"):
- If `lastBrowserOSPageUrl` is already a search results page for a similar query, the planner should set `startUrl` to the existing page and write a `browserosPrompt` that clicks through results
- Avoid generating searches that are near-duplicates of `existingSuggestion.query`

---

## Fix 6: Remove `--disable-blink-features=AutomationControlled` flag

**Files:** `scripts/llm-agent.mjs`, `src-tauri/src/lib.rs`, `src/SettingsApp.tsx`, `CLAUDE.md`

**Problem:** Chrome showed an infobar warning: "You are using an unsupported command-line flag: --disable-blink-features=AutomationControlled".

**Fix:**
- Removed the flag from runtime injection (`scripts/llm-agent.mjs`)
- Removed from default MCP config (`src-tauri/src/lib.rs`)
- Added migration to strip it from existing user configs on startup (`src-tauri/src/lib.rs`)
- Updated docs and settings UI examples
- Kept `--ignore-default-chrome-arg=--enable-automation` (a chrome-devtools-mcp flag, not a Chrome flag — no warning)

---

## Fix 7: Logging for Chrome lifecycle debugging

**File:** `scripts/llm-agent.mjs`

Added `console.error` logging (visible as `[llm-agent] stderr:` in app logs) to key functions:

| Log prefix | Function | What it logs |
|------------|----------|--------------|
| `[chrome-persist]` | `ensurePersistentChrome()`, `launchPersistentChrome()` | Chrome reuse vs launch, port probe results, spawn status |
| `[mcp]` | `loadMcpTools()` | Whether connecting to persistent Chrome or falling back to MCP-managed |
| `[blank-tabs]` | `closeBlankTabs()` | `list_pages` output, blank tabs found/closed |
| `[browseros]` | `runBrowserOsAutomation()` | pid at start, MCP load result (tool count, client count) |

---

## Files changed

| File | Changes |
|------|---------|
| `scripts/llm-agent.mjs` | `const` → `let` fix; persistent Chrome architecture; `new_page` removal; `closeBlankTabs()`; logging; flag removal |
| `src/App.tsx` | Redundant search planner instructions; osascript fallback suppression for Chrome errors |
| `src-tauri/src/lib.rs` | `--disable-blink-features` removal from default config + migration to strip from existing configs |
| `src/SettingsApp.tsx` | Updated MCP config example (removed flag) |
| `CLAUDE.md` | Updated MCP config example (removed flag) |
