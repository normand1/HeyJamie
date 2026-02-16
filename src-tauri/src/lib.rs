use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, Submenu},
    Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WhisperStatus {
    cli_found: bool,
    model_found: bool,
    cli_path: Option<String>,
    model_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpConfigResponse {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmAgentSettings {
    api_key: String,
    model: String,
    reasoning: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmAgentRequest {
    settings: LlmAgentSettings,
    instructions: String,
    prompt: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    context: Option<JsonValue>,
}

struct LlmAgentState {
    cancel_requested: Arc<AtomicBool>,
}

impl Default for LlmAgentState {
    fn default() -> Self {
        Self {
            cancel_requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct ExcalidrawServerState {
    child: Mutex<Option<std::process::Child>>,
}

/// Start the Excalidraw Express/WebSocket canvas server on app launch.
/// Reads the MCP config to find the excalidraw server entry and spawns
/// `node dist/server.js` from its configured cwd.
fn start_excalidraw_server(app: &tauri::AppHandle) -> Option<std::process::Child> {
    let config_path = match mcp_config_path(app) {
        Ok(p) => p,
        Err(e) => {
            log_line(&format!("[excalidraw] failed to resolve MCP config path: {}", e));
            return None;
        }
    };

    let config_str = if config_path.exists() {
        fs::read_to_string(&config_path).unwrap_or_else(|_| default_mcp_config())
    } else {
        default_mcp_config()
    };

    let config: JsonValue = match serde_json::from_str(&config_str) {
        Ok(v) => v,
        Err(e) => {
            log_line(&format!("[excalidraw] failed to parse MCP config: {}", e));
            return None;
        }
    };

    let excalidraw = match config.get("mcpServers").and_then(|s| s.get("excalidraw")) {
        Some(e) => e,
        None => {
            log_line("[excalidraw] no excalidraw server entry in MCP config");
            return None;
        }
    };

    if excalidraw.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
        log_line("[excalidraw] server disabled in config, skipping auto-start");
        return None;
    }

    let cwd = match excalidraw.get("cwd").and_then(|v| v.as_str()) {
        Some(c) => {
            if c.starts_with("~/") {
                dirs::home_dir()
                    .map(|h| h.join(&c[2..]))
                    .unwrap_or_else(|| PathBuf::from(c))
            } else {
                PathBuf::from(c)
            }
        }
        None => {
            log_line("[excalidraw] no cwd in server config");
            return None;
        }
    };

    let server_js = cwd.join("dist/server.js");
    if !server_js.exists() {
        log_line(&format!(
            "[excalidraw] dist/server.js not found at {}",
            server_js.display()
        ));
        return None;
    }

    let mut cmd = Command::new("node");
    cmd.arg("dist/server.js")
        .current_dir(&cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if let Some(env_obj) = excalidraw.get("env").and_then(|v| v.as_object()) {
        for (k, v) in env_obj {
            if let Some(val) = v.as_str() {
                cmd.env(k, val);
            }
        }
    }

    match cmd.spawn() {
        Ok(child) => {
            log_line(&format!(
                "[excalidraw] canvas server started (pid: {})",
                child.id()
            ));
            Some(child)
        }
        Err(e) => {
            log_line(&format!("[excalidraw] failed to start canvas server: {}", e));
            None
        }
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn transcribe_audio(audio_base64: String) -> Result<String, String> {
    log_line(&format!(
        "transcribe_audio called (payload bytes: {})",
        audio_base64.len()
    ));
    let wav_bytes = general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|err| format!("invalid audio payload: {}", err))?;

    let wav_path = write_temp_wav(&wav_bytes)?;
    log_line(&format!(
        "current_dir: {}",
        env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    ));
    let cli_path = resolve_whisper_cli()?;
    let model_path = resolve_whisper_model()?;

    log_line(&format!(
        "whisper-cli: {} | model: {} | wav: {}",
        cli_path.display(),
        model_path.display(),
        wav_path.display()
    ));

    let whisper_logprob_thold = parse_env_float("HEYJAMIE_WHISPER_LOGPROB_THOLD", -2.0, 1.0);
    let whisper_no_speech_thold = parse_env_float("HEYJAMIE_WHISPER_NO_SPEECH_THOLD", 0.0, 1.0);
    if let Some(value) = whisper_logprob_thold {
        log_line(&format!("whisper logprob threshold override: {:.2}", value));
    }
    if let Some(value) = whisper_no_speech_thold {
        log_line(&format!("whisper no-speech threshold override: {:.2}", value));
    }

    let mut command = Command::new(&cli_path);
    command
        .arg("-m")
        .arg(&model_path)
        .arg("-f")
        .arg(&wav_path)
        .arg("-nt")
        .arg("-sns")
        .arg("-np");
    if let Some(value) = whisper_logprob_thold {
        command.arg("-lpt").arg(format!("{:.2}", value));
    }
    if let Some(value) = whisper_no_speech_thold {
        command.arg("-nth").arg(format!("{:.2}", value));
    }

    let output = command
        .output()
        .map_err(|err| format!("failed to run whisper-cli: {}", err))?;

    let _ = fs::remove_file(&wav_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log_line(&format!("whisper-cli failed: {}", stderr.trim()));
        return Err(format!("whisper-cli failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let transcript = extract_transcript(&stdout);
    log_line(&format!("whisper-cli stdout bytes: {}", stdout.len()));
    if !stderr.trim().is_empty() {
        log_line(&format!(
            "whisper-cli stderr (truncated): {}",
            truncate_for_log(&stderr, 300)
        ));
    }
    log_line(&format!("whisper-cli transcript: {}", transcript));
    Ok(transcript)
}

#[tauri::command]
fn check_whisper() -> WhisperStatus {
    let cli_path = find_whisper_cli();
    let model_path = find_whisper_model();

    WhisperStatus {
        cli_found: cli_path.is_some(),
        model_found: model_path.is_some(),
        cli_path: cli_path.map(|path| path.display().to_string()),
        model_path: model_path.map(|path| path.display().to_string()),
    }
}

#[tauri::command]
fn setup_whisper() -> Result<String, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root_dir = manifest_dir
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "failed to resolve repo root".to_string())?;
    let script_path = root_dir.join("scripts/setup-whisper.sh");

    if !script_path.exists() {
        return Err("setup-whisper.sh not found in scripts/".to_string());
    }

    log_line(&format!(
        "Running whisper setup script: {}",
        script_path.display()
    ));

    let output = Command::new(&script_path)
        .current_dir(&root_dir)
        .output()
        .map_err(|err| format!("failed to run setup script: {}", err))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    log_line(&format!("setup-whisper stdout bytes: {}", stdout.len()));
    if !stderr.trim().is_empty() {
        log_line(&format!(
            "setup-whisper stderr (truncated): {}",
            truncate_for_log(&stderr, 300)
        ));
    }

    if !output.status.success() {
        return Err(format!(
            "setup-whisper failed: {}",
            truncate_for_log(&stderr, 500)
        ));
    }

    Ok(format!("{}\n{}", stdout, stderr))
}

#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|err| format!("failed to build HTTP client: {}", err))?;
    let response = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (compatible; HeyJamie/1.0)")
        .send()
        .await
        .map_err(|err| format!("request failed: {}", err))?;
    if !response.status().is_success() {
        return Err(format!("request failed ({})", response.status()));
    }
    response
        .text()
        .await
        .map_err(|err| format!("failed to read response body: {}", err))
}

#[tauri::command]
fn log_frontend(message: String) {
    log_line(&format!("[frontend] {}", message));
}

#[tauri::command]
fn browser_control(app: tauri::AppHandle, action: String) -> Result<(), String> {
    log_line(&format!("[browser-control] {}", action));
    app.emit_to("main", "browser-control", action)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn cancel_llm_agent(state: tauri::State<'_, LlmAgentState>) {
    state.cancel_requested.store(true, Ordering::SeqCst);
}

/// Send SIGTERM first to allow graceful MCP client cleanup, then SIGKILL
/// if the process hasn't exited within the grace period.
fn graceful_kill(child: &mut std::process::Child) {
    let pid = child.id() as i32;
    // Send SIGTERM so the Node.js process can close MCP clients cleanly.
    unsafe { libc::kill(pid, libc::SIGTERM); }

    // Wait up to 2 seconds for graceful exit.
    for _ in 0..40 {
        match child.try_wait() {
            Ok(Some(_)) => return, // exited cleanly
            Ok(None) => {}
            Err(_) => break,
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // Still running — force kill.
    let _ = child.kill();
    let _ = child.wait(); // reap to ensure pipe cleanup before returning
}

fn test_log_path() -> PathBuf {
    if let Ok(path) = env::var("HEYJAMIE_TEST_LOG_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    env::temp_dir().join("heyjamie-integration-test.log")
}

#[tauri::command]
fn reset_test_log(run_label: Option<String>) -> Result<String, String> {
    let path = test_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("failed to create log dir: {}", err))?;
    }

    let mut file = fs::File::create(&path).map_err(|err| format!("failed to reset log: {}", err))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis();
    let label = run_label
        .unwrap_or_else(|| "integration-run".to_string())
        .trim()
        .to_string();
    let header = format!("# HeyJamie Integration Test Log [{}] {}\n", stamp, label);
    file.write_all(header.as_bytes())
        .map_err(|err| format!("failed to write log header: {}", err))?;

    Ok(path.display().to_string())
}

#[tauri::command]
fn append_test_log(line: String) -> Result<(), String> {
    let path = test_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("failed to create log dir: {}", err))?;
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("failed to open test log: {}", err))?;
    let normalized = line.replace('\n', " ");
    file.write_all(normalized.as_bytes())
        .map_err(|err| format!("failed to append test log: {}", err))?;
    file.write_all(b"\n")
        .map_err(|err| format!("failed to append test log newline: {}", err))?;
    Ok(())
}

fn default_mcp_config() -> String {
    // Build excalidraw cwd from home directory
    let excalidraw_cwd = dirs::home_dir()
        .map(|h| h.join("mcp_excalidraw").display().to_string())
        .unwrap_or_else(|| "~/mcp_excalidraw".to_string());

    let value = serde_json::json!({
        "mcpServers": {
            "chrome-devtools": {
                "command": "npx",
                "args": [
                    "-y", "chrome-devtools-mcp@latest",
                    "--ignore-default-chrome-arg=--enable-automation"
                ]
            },
            "context7": {
                "command": "npx",
                "args": ["-y", "@upstash/context7-mcp@latest"]
            },
            "excalidraw": {
                "command": "node",
                "args": ["dist/index.js"],
                "cwd": excalidraw_cwd,
                "env": {
                    "EXPRESS_SERVER_URL": "http://localhost:3000",
                    "ENABLE_CANVAS_SYNC": "true"
                }
            }
        }
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
}

fn mcp_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("failed to resolve app config dir: {}", err))?;
    fs::create_dir_all(&dir).map_err(|err| format!("failed to create config dir: {}", err))?;
    Ok(dir.join("mcp.json"))
}

/// Migrate MCP config on disk:
/// 1. Replace old "browseros" HTTP entry with "chrome-devtools" stdio entry.
/// 2. Strip "--isolated" and "--auto-connect" flags — Chrome instance reuse is
///    handled at runtime by the Node agent layer (via DevToolsActivePort probe).
fn ensure_mcp_config_migrated(path: &std::path::Path) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut root: serde_json::Map<String, JsonValue> = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(_) => return,
    };
    let servers = match root.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        Some(s) => s,
        None => return,
    };

    let mut changed = false;

    // Migration 1: browseros → chrome-devtools
    if servers.contains_key("browseros") && !servers.contains_key("chrome-devtools") {
        servers.remove("browseros");
        servers.insert(
            "chrome-devtools".to_string(),
            serde_json::json!({
                "command": "npx",
                "args": ["-y", "chrome-devtools-mcp@latest"]
            }),
        );
        log_line("[mcp] migrated old \"browseros\" config to \"chrome-devtools\"");
        changed = true;
    }

    // Migration 2: strip --isolated / --auto-connect (runtime handles reuse)
    if let Some(entry) = servers.get_mut("chrome-devtools") {
        if let Some(args) = entry.get_mut("args").and_then(|v| v.as_array_mut()) {
            let before_len = args.len();
            args.retain(|a| {
                let s = a.as_str().unwrap_or("");
                s != "--isolated" && s != "--auto-connect"
            });
            if args.len() != before_len {
                log_line("[mcp] stripped --isolated/--auto-connect from chrome-devtools config (runtime handles Chrome reuse)");
                changed = true;
            }
        }
    }

    // Migration 3: add stealth Chrome flags to avoid bot detection
    if let Some(entry) = servers.get_mut("chrome-devtools") {
        if let Some(args) = entry.get_mut("args").and_then(|v| v.as_array_mut()) {
            // Remove deprecated Chrome flags from earlier migrations
            let before_len = args.len();
            args.retain(|a| {
                let s = a.as_str().unwrap_or("");
                s != "--chromeArg=--disable-infobars"
                    && s != "--chromeArg=--disable-blink-features=AutomationControlled"
            });
            if args.len() != before_len {
                changed = true;
            }

            let stealth_flags: &[&str] = &[
                "--ignore-default-chrome-arg=--enable-automation",
            ];
            let mut added_stealth = false;
            for &flag in stealth_flags {
                if !args.iter().any(|a| a.as_str() == Some(flag)) {
                    args.push(JsonValue::String(flag.to_string()));
                    added_stealth = true;
                }
            }
            if added_stealth {
                log_line("[mcp] added stealth Chrome flags to chrome-devtools config");
                changed = true;
            }
        }
    }

    if changed {
        if let Ok(migrated) = serde_json::to_string_pretty(&root) {
            let _ = fs::write(path, migrated.as_bytes());
        }
    }
}

#[tauri::command]
fn get_mcp_config(app: tauri::AppHandle) -> Result<McpConfigResponse, String> {
    let path = mcp_config_path(&app)?;
    if !path.exists() {
        let content = default_mcp_config();
        fs::write(&path, content.as_bytes())
            .map_err(|err| format!("failed to write default config: {}", err))?;
    }

    ensure_mcp_config_migrated(&path);

    let content = fs::read_to_string(&path).unwrap_or_else(|_| default_mcp_config());
    Ok(McpConfigResponse {
        path: path.display().to_string(),
        content,
    })
}

#[tauri::command]
fn save_mcp_config(app: tauri::AppHandle, content: String) -> Result<McpConfigResponse, String> {
    let parsed: JsonValue =
        serde_json::from_str(&content).map_err(|err| format!("invalid JSON: {}", err))?;
    let pretty = serde_json::to_string_pretty(&parsed)
        .map_err(|err| format!("failed to format JSON: {}", err))?;
    let path = mcp_config_path(&app)?;
    fs::write(&path, pretty.as_bytes())
        .map_err(|err| format!("failed to write config: {}", err))?;
    Ok(McpConfigResponse {
        path: path.display().to_string(),
        content: pretty,
    })
}

#[tauri::command]
async fn test_mcp_config(app: tauri::AppHandle) -> Result<String, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root_dir = manifest_dir
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "failed to resolve repo root".to_string())?;
        let script_path = root_dir.join("scripts/llm-agent.mjs");
        if !script_path.exists() {
            return Err("llm-agent.mjs not found in scripts/".to_string());
        }

        let mcp_path = mcp_config_path(&app)?;
        ensure_mcp_config_migrated(&mcp_path);
        let request = serde_json::json!({
            "mode": "mcp-test",
            "mcpConfigPath": mcp_path.display().to_string()
        });

        let mut child = Command::new("node")
            .arg(script_path)
            .current_dir(&root_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to start mcp test: {}", err))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(request.to_string().as_bytes())
                .map_err(|err| format!("failed to write mcp test input: {}", err))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|err| format!("failed to read mcp test output: {}", err))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("mcp test failed: {}", stderr.trim()));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Err("mcp test returned empty output".to_string());
        }

        let parsed: JsonValue = serde_json::from_str(&stdout)
            .map_err(|err| format!("failed to parse mcp test output: {}", err))?;
        let pretty = serde_json::to_string_pretty(&parsed)
            .map_err(|err| format!("failed to format mcp test output: {}", err))?;

        Ok(pretty)
    })
    .await
    .map_err(|err| format!("mcp test task failed: {}", err))?
}

#[tauri::command]
async fn run_llm_agent(
    app: tauri::AppHandle,
    payload: LlmAgentRequest,
    state: tauri::State<'_, LlmAgentState>,
) -> Result<String, String> {
    let app = app.clone();
    state.cancel_requested.store(false, Ordering::SeqCst);
    let cancel_requested = state.cancel_requested.clone();
    tauri::async_runtime::spawn_blocking(move || {
        log_line("[llm-agent] starting request");
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root_dir = manifest_dir
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "failed to resolve repo root".to_string())?;
        let script_path = root_dir.join("scripts/llm-agent.mjs");
        if !script_path.exists() {
            return Err("llm-agent.mjs not found in scripts/".to_string());
        }

        let mcp_path = mcp_config_path(&app)?;
        ensure_mcp_config_migrated(&mcp_path);
        let request = serde_json::json!({
            "mode": payload.mode,
            "settings": {
                "apiKey": payload.settings.api_key,
                "model": payload.settings.model,
                "reasoning": payload.settings.reasoning
            },
            "instructions": payload.instructions,
            "prompt": payload.prompt,
            "context": payload.context,
            "mcpConfigPath": mcp_path.display().to_string()
        });

        let mut child = Command::new("node")
            .arg(script_path)
            .current_dir(&root_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to start llm agent: {}", err))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(request.to_string().as_bytes())
                .map_err(|err| format!("failed to write llm agent input: {}", err))?;
        }

        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture llm agent stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture llm agent stderr".to_string())?;
        let stderr_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        if !line.trim().is_empty() {
                            log_line(&format!(
                                "[llm-agent] stderr: {}",
                                truncate_for_log(&line, 600)
                            ));
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let is_browseros_mode = payload.mode.as_deref() == Some("browseros-act");
        let is_navigate_mode = payload.mode.as_deref() == Some("browseros-navigate");
        let is_excalidraw_mode = payload.mode.as_deref() == Some("excalidraw-act");
        let is_intent_mode = payload.mode.as_deref() == Some("browseros-intent");
        let is_topic_shift_mode = payload.mode.as_deref() == Some("topic-shift-detect");
        let default_timeout_ms: u128 = if is_browseros_mode {
            180_000
        } else if is_navigate_mode {
            30_000
        } else if is_excalidraw_mode {
            120_000
        } else if is_intent_mode {
            90_000
        } else if is_topic_shift_mode {
            15_000
        } else {
            45_000
        };
        let timeout_env_key = if is_browseros_mode || is_navigate_mode {
            "HEYJAMIE_BROWSEROS_TIMEOUT_MS"
        } else if is_excalidraw_mode {
            "HEYJAMIE_EXCALIDRAW_TIMEOUT_MS"
        } else if is_intent_mode {
            "HEYJAMIE_INTENT_TIMEOUT_MS"
        } else if is_topic_shift_mode {
            "HEYJAMIE_TOPIC_SHIFT_TIMEOUT_MS"
        } else {
            "HEYJAMIE_LLM_TIMEOUT_MS"
        };
        let timeout_ms: u128 = env::var(timeout_env_key)
            .ok()
            .and_then(|raw| raw.trim().parse::<u128>().ok())
            .filter(|ms| *ms >= 1_000)
            .unwrap_or(default_timeout_ms);
        let started_at = Instant::now();
        let mut terminal_error: Option<String> = None;

        loop {
            if cancel_requested.load(Ordering::SeqCst) {
                graceful_kill(&mut child);
                log_line("[llm-agent] cancelled");
                terminal_error = Some("llm agent cancelled".to_string());
                break;
            }

            if started_at.elapsed().as_millis() > timeout_ms {
                graceful_kill(&mut child);
                log_line(&format!("[llm-agent] timed out after {}ms", timeout_ms));
                terminal_error = Some(format!("llm agent timed out after {}ms", timeout_ms));
                break;
            }

            match child.try_wait() {
                Ok(Some(_status)) => break,
                Ok(None) => {}
                Err(err) => {
                    terminal_error = Some(format!("failed to poll llm agent: {}", err));
                    break;
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        if let Some(error_message) = terminal_error {
            let _ = stderr_thread.join();
            return Err(error_message);
        }

        let mut stdout_text = String::new();
        if let Err(err) = stdout.read_to_string(&mut stdout_text) {
            let _ = stderr_thread.join();
            return Err(format!("failed to read llm agent stdout: {}", err));
        }
        let _ = stderr_thread.join();

        let stdout_text = stdout_text.trim().to_string();
        if stdout_text.is_empty() {
            return Err("llm agent returned empty output".to_string());
        }

        log_line("[llm-agent] completed");
        Ok(stdout_text)
    })
    .await
    .map_err(|err| format!("llm agent task failed: {}", err))?
}

#[cfg(desktop)]
#[tauri::command]
fn open_browser_window(_app: tauri::AppHandle, url: String, new_tab: bool) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|err| format!("invalid url: {}", err))?;
    let target = parsed.to_string();
    let launcher = launch_external_url(&target, new_tab)?;
    log_line(&format!("[browser] opened via {}: {}", launcher, target));
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn open_browser_window(_app: tauri::AppHandle, _url: String, _new_tab: bool) -> Result<(), String> {
    Err("Browser window not supported on mobile.".to_string())
}

#[cfg(all(desktop, target_os = "macos"))]
#[tauri::command]
fn focus_chrome_window() -> Result<(), String> {
    let script = r#"tell application "Google Chrome" to activate"#;
    if run_browser_launcher("osascript", &["-e", script]).is_ok() {
        return Ok(());
    }
    run_browser_launcher("open", &["-a", "Google Chrome"])
}

#[cfg(all(desktop, not(target_os = "macos")))]
#[tauri::command]
fn focus_chrome_window() -> Result<(), String> {
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn focus_chrome_window() -> Result<(), String> {
    Ok(())
}

#[cfg(all(desktop, target_os = "macos"))]
#[tauri::command]
fn reload_chrome_tab(url_prefix: String) -> Result<(), String> {
    let script = format!(
        r#"tell application "Google Chrome"
    activate
    repeat with w in windows
        set tabIndex to 0
        repeat with t in tabs of w
            set tabIndex to tabIndex + 1
            if URL of t starts with "{}" then
                set active tab index of w to tabIndex
                set index of w to 1
                reload t
                return
            end if
        end repeat
    end repeat
    error "tab not found"
end tell"#,
        url_prefix
    );
    run_browser_launcher("osascript", &["-e", &script])
}

#[cfg(all(desktop, not(target_os = "macos")))]
#[tauri::command]
fn reload_chrome_tab(_url_prefix: String) -> Result<(), String> {
    Err("not supported".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
fn reload_chrome_tab(_url_prefix: String) -> Result<(), String> {
    Err("not supported".to_string())
}

#[cfg(all(desktop, target_os = "macos"))]
#[tauri::command]
fn focus_chrome_tab(url_prefix: String) -> Result<(), String> {
    let app_name = env::var("HEYJAMIE_BROWSEROS_APP_NAME")
        .unwrap_or_else(|_| "Google Chrome".to_string());
    let app_name = app_name.trim();
    let app_name = if app_name.is_empty() { "Google Chrome" } else { app_name };
    let script = format!(
        r#"tell application "{}"
    activate
    repeat with w in windows
        set tabIndex to 0
        repeat with t in tabs of w
            set tabIndex to tabIndex + 1
            if URL of t starts with "{}" then
                set active tab index of w to tabIndex
                set index of w to 1
                return
            end if
        end repeat
    end repeat
    error "tab not found"
end tell"#,
        app_name, url_prefix
    );
    run_browser_launcher("osascript", &["-e", &script])
}

#[cfg(all(desktop, not(target_os = "macos")))]
#[tauri::command]
fn focus_chrome_tab(_url_prefix: String) -> Result<(), String> {
    Err("not supported".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
fn focus_chrome_tab(_url_prefix: String) -> Result<(), String> {
    Err("not supported".to_string())
}

#[cfg(desktop)]
fn run_browser_launcher(program: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|err| format!("{}: {}", program, err))?;
    if status.success() {
        return Ok(());
    }
    Err(format!("{} exited with {}", program, status))
}

#[cfg(all(desktop, target_os = "macos"))]
fn launch_external_url(url: &str, new_tab: bool) -> Result<String, String> {
    let browseros_app_name = env::var("HEYJAMIE_BROWSEROS_APP_NAME")
        .unwrap_or_else(|_| "Google Chrome".to_string())
        .trim()
        .to_string();
    if !browseros_app_name.is_empty() {
        let script = if new_tab {
            // Open a new tab in the existing front window
            format!(
                r#"tell application "{}"
    activate
    tell front window
        make new tab with properties {{URL:"{}"}}
    end tell
end tell"#,
                browseros_app_name, url
            )
        } else {
            // First time: open a new window so HeyJamie browsing is isolated
            format!(
                r#"tell application "{}"
    activate
    make new window
    set URL of active tab of front window to "{}"
end tell"#,
                browseros_app_name, url
            )
        };

        if run_browser_launcher("osascript", &["-e", &script]).is_ok() {
            return Ok(format!("osascript ({})", browseros_app_name));
        }

        // Fallback to simple open if AppleScript fails
        if run_browser_launcher("open", &["-a", &browseros_app_name, url]).is_ok() {
            return Ok(format!("open -a {}", browseros_app_name));
        }
    }
    run_browser_launcher("open", &[url]).map(|_| "open".to_string())
}

#[cfg(all(desktop, target_os = "linux"))]
fn launch_external_url(url: &str, _new_tab: bool) -> Result<String, String> {
    run_browser_launcher("xdg-open", &[url]).map(|_| "xdg-open".to_string())
}

#[cfg(all(desktop, target_os = "windows"))]
fn launch_external_url(url: &str, _new_tab: bool) -> Result<String, String> {
    run_browser_launcher("cmd", &["/C", "start", "", url])
        .map(|_| "cmd /C start".to_string())
}

#[cfg(all(
    desktop,
    not(any(target_os = "macos", target_os = "linux", target_os = "windows"))
))]
fn launch_external_url(_url: &str, _new_tab: bool) -> Result<String, String> {
    Err("unsupported platform for external URL launch".to_string())
}

fn write_temp_wav(bytes: &[u8]) -> Result<PathBuf, String> {
    let tmp_dir = env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis();
    let path = tmp_dir.join(format!("heyjamie-{}.wav", stamp));
    fs::write(&path, bytes).map_err(|err| err.to_string())?;
    log_line(&format!("wrote wav segment to {}", path.display()));
    Ok(path)
}

fn resolve_whisper_cli() -> Result<PathBuf, String> {
    if let Some(path) = find_whisper_cli() {
        return Ok(path);
    }

    log_line("whisper-cli not found in expected paths.");
    Err("whisper-cli not found. Run scripts/setup-whisper.sh or set WHISPER_CLI_PATH.".to_string())
}

fn resolve_whisper_model() -> Result<PathBuf, String> {
    if let Some(path) = find_whisper_model() {
        return Ok(path);
    }

    log_line("whisper model not found in expected paths.");
    Err(
        "Whisper model not found. Run scripts/setup-whisper.sh or set WHISPER_MODEL_PATH."
            .to_string(),
    )
}

fn find_whisper_cli() -> Option<PathBuf> {
    if let Ok(path) = env::var("WHISPER_CLI_PATH") {
        log_line(&format!("WHISPER_CLI_PATH set: {}", path));
        return Some(PathBuf::from(path));
    }

    let cwd = env::current_dir().ok()?;
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        cwd.join("whisper_cpp/build/bin/whisper-cli"),
        cwd.join("../whisper_cpp/build/bin/whisper-cli"),
        cwd.join("whisper.cpp/build/bin/whisper-cli"),
        cwd.join("../whisper.cpp/build/bin/whisper-cli"),
        manifest_dir.join("../whisper_cpp/build/bin/whisper-cli"),
        manifest_dir.join("../whisper.cpp/build/bin/whisper-cli"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            log_line(&format!("whisper-cli found at {}", candidate.display()));
            return Some(candidate);
        }
    }

    None
}

fn find_whisper_model() -> Option<PathBuf> {
    if let Ok(path) = env::var("WHISPER_MODEL_PATH") {
        log_line(&format!("WHISPER_MODEL_PATH set: {}", path));
        return Some(PathBuf::from(path));
    }

    let cwd = env::current_dir().ok()?;
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        cwd.join("whisper_cpp/models/ggml-base.en.bin"),
        cwd.join("../whisper_cpp/models/ggml-base.en.bin"),
        cwd.join("whisper.cpp/models/ggml-base.en.bin"),
        cwd.join("../whisper.cpp/models/ggml-base.en.bin"),
        manifest_dir.join("../whisper_cpp/models/ggml-base.en.bin"),
        manifest_dir.join("../whisper.cpp/models/ggml-base.en.bin"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            log_line(&format!("whisper model found at {}", candidate.display()));
            return Some(candidate);
        }
    }

    None
}

fn parse_env_float(name: &str, min: f32, max: f32) -> Option<f32> {
    let value = env::var(name).ok()?;
    let parsed = value.trim().parse::<f32>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    if parsed < min || parsed > max {
        return None;
    }
    Some(parsed)
}

fn extract_transcript(output: &str) -> String {
    let mut lines = Vec::new();

    for line in output.lines() {
        if let Some(idx) = line.find(']') {
            let candidate = line[idx + 1..].trim();
            if let Some(cleaned) = clean_transcript_fragment(candidate) {
                lines.push(cleaned);
            }
        }
    }

    if lines.is_empty() {
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Filter out whisper.cpp debug/system output lines (contain underscores)
            if trimmed.contains('_') {
                continue;
            }
            if let Some(cleaned) = clean_transcript_fragment(trimmed) {
                lines.push(cleaned);
            }
        }
    }

    lines.join(" ")
}

fn clean_transcript_fragment(text: &str) -> Option<String> {
    let mut cleaned = text.trim();
    while let Some(rest) = cleaned.strip_prefix(">>") {
        cleaned = rest.trim_start();
    }

    if cleaned.is_empty() || is_timestamp_only_line(cleaned) || is_non_speech_marker(cleaned) {
        return None;
    }

    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || is_low_information_fragment(&collapsed) {
        None
    } else {
        Some(collapsed)
    }
}

fn is_timestamp_only_line(text: &str) -> bool {
    let trimmed = text.trim();
    if !(trimmed.starts_with('[') && trimmed.ends_with(']')) {
        return false;
    }

    let inner = trimmed[1..trimmed.len() - 1].trim();
    if !inner.contains("-->") {
        return false;
    }

    inner
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, ':' | '.' | '-' | '>' | ' '))
}

fn is_non_speech_marker(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }

    if is_timestamp_only_line(trimmed) {
        return true;
    }

    let words = normalize_fragment_tokens(trimmed);

    if words.is_empty() {
        return true;
    }

    let phrase = words.join(" ");
    if matches!(
        phrase.as_str(),
        "blank_audio"
            | "blank audio"
            | "music"
            | "inaudible"
            | "speaking in a foreign language"
            | "foreign language"
    ) {
        return true;
    }

    words
        .iter()
        .all(|word| word == "inaudible" || word == "music")
}

fn is_low_information_fragment(text: &str) -> bool {
    let words = normalize_fragment_tokens(text);
    if words.is_empty() {
        return true;
    }

    if words.len() == 1 {
        return matches!(words[0].as_str(), "you");
    }

    words.len() <= 3 && words.iter().all(|word| word == "you")
}

fn normalize_fragment_tokens(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|token| {
            token
                .trim_matches(|c: char| {
                    c.is_whitespace()
                        || matches!(
                            c,
                            '[' | ']' | '(' | ')' | '{' | '}' | '.' | ',' | ';' | ':' | '!' | '?'
                        )
                })
                .trim_start_matches('>')
                .trim_start_matches('~')
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase()
        })
        .filter(|token| !token.is_empty())
        .collect()
}

#[cfg(test)]
mod transcript_tests {
    use super::{clean_transcript_fragment, extract_transcript, is_non_speech_marker};

    #[test]
    fn strips_non_speech_samples() {
        assert!(clean_transcript_fragment("[Music]").is_none());
        assert!(clean_transcript_fragment(">> [INAUDIBLE]").is_none());
        assert!(clean_transcript_fragment("[inaudible] [inaudible] [inaudible]").is_none());
        assert!(clean_transcript_fragment("[00:00:00.000 --> 00:00:08.000]").is_none());
    }

    #[test]
    fn preserves_real_speech() {
        let value = clean_transcript_fragment(">> This is a real sentence.")
            .expect("expected speech to survive");
        assert_eq!(value, "This is a real sentence.");
        assert!(!is_non_speech_marker(&value));
    }

    #[test]
    fn extract_transcript_drops_non_speech_lines() {
        let output = r#"
[00:00:00.000 --> 00:00:08.000] [Music]
>> [INAUDIBLE]
[inaudible] [inaudible] [inaudible]
[00:00:08.000 --> 00:00:16.000] We should find a cute cat.
"#;
        let transcript = extract_transcript(output);
        assert_eq!(transcript, "We should find a cute cat.");
    }

    #[test]
    fn drops_single_word_you_hallucinations() {
        assert!(clean_transcript_fragment("you").is_none());
        assert!(clean_transcript_fragment("You").is_none());
        assert!(clean_transcript_fragment("you you").is_none());
        assert!(clean_transcript_fragment("you you you").is_none());
        assert_eq!(
            clean_transcript_fragment("thank you").expect("expected phrase"),
            "thank you"
        );
    }
}

fn log_path() -> PathBuf {
    env::temp_dir().join("heyjamie.log")
}

fn truncate_for_log(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        return text.to_string();
    }
    format!("{}…", &text[..max_len])
}

fn log_line(message: &str) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let line = format!("[{}] {}\n", stamp, message);
    eprint!("{}", line);
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg(desktop)]
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let settings_item = MenuItem::with_id(
        app,
        "open_settings",
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let mut file_submenu = None;
    if let Ok(items) = menu.items() {
        for item in items {
            if let MenuItemKind::Submenu(submenu) = item {
                if submenu.text().unwrap_or_default() == "File" {
                    file_submenu = Some(submenu);
                    break;
                }
            }
        }
    }

    if let Some(submenu) = file_submenu {
        submenu.insert(&settings_item, 0)?;
    } else {
        let file_menu = Submenu::with_items(app, "File", true, &[&settings_item])?;
        menu.insert(&file_menu, 0)?;
    }

    Ok(menu)
}

#[cfg(desktop)]
fn open_settings_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("HeyJamie Settings")
        .inner_size(640.0, 720.0)
        .min_inner_size(520.0, 600.0)
        .disable_drag_drop_handler()
        .build()
        .map(|_| ())
}

#[cfg(desktop)]
#[tauri::command]
fn open_settings_window_command(app: tauri::AppHandle) -> Result<(), String> {
    open_settings_window(&app).map_err(|err| format!("failed to open settings window: {}", err))
}

#[cfg(not(desktop))]
#[tauri::command]
fn open_settings_window_command() -> Result<(), String> {
    Err("not supported".to_string())
}

#[cfg(desktop)]
fn open_dev_settings_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("dev-settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        "dev-settings",
        WebviewUrl::App("dev-settings.html".into()),
    )
    .title("Developer Settings")
    .inner_size(560.0, 520.0)
    .min_inner_size(480.0, 400.0)
    .disable_drag_drop_handler()
    .build()
    .map(|_| ())
}

#[tauri::command]
fn get_personas_dir() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let project_root = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap_or(std::path::Path::new(manifest_dir));
    project_root
        .join("src")
        .join("personas")
        .display()
        .to_string()
}

#[cfg(desktop)]
fn find_file_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<Submenu<R>> {
    let menu = app.menu()?;
    let items = menu.items().ok()?;
    for item in items {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text().unwrap_or_default() == "File" {
                return Some(submenu);
            }
        }
    }
    None
}

#[cfg(desktop)]
#[tauri::command]
fn set_dev_settings_menu_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let file_submenu = find_file_submenu(&app).ok_or("File submenu not found")?;
    let items = file_submenu.items().map_err(|e| e.to_string())?;
    let existing = items
        .iter()
        .any(|item| item.id().as_ref() == "open_dev_settings");

    if visible && !existing {
        let dev_settings_item = MenuItem::with_id(
            &app,
            "open_dev_settings",
            "Developer Settings...",
            true,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        file_submenu
            .insert(&dev_settings_item, 1)
            .map_err(|e| e.to_string())?;
    } else if !visible && existing {
        if let Some(item) = items
            .into_iter()
            .find(|item| item.id().as_ref() == "open_dev_settings")
        {
            file_submenu.remove(&item).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_dev_settings_menu_visible(_visible: bool) -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_line(&format!(
        "HeyJamie starting. Log file: {}",
        log_path().display()
    ));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(LlmAgentState::default())
        .manage(ExcalidrawServerState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            let child = start_excalidraw_server(app.handle());
            let state = app.state::<ExcalidrawServerState>();
            *state.child.lock().unwrap() = child;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            transcribe_audio,
            check_whisper,
            setup_whisper,
            log_frontend,
            browser_control,
            get_mcp_config,
            save_mcp_config,
            run_llm_agent,
            test_mcp_config,
            cancel_llm_agent,
            open_browser_window,
            focus_chrome_window,
            reload_chrome_tab,
            focus_chrome_tab,
            reset_test_log,
            append_test_log,
            fetch_url,
            get_personas_dir,
            open_settings_window_command,
            set_dev_settings_menu_visible
        ]);

    #[cfg(desktop)]
    let builder = builder
        .menu(|app| build_menu(app))
        .on_menu_event(|app, event| {
            if event.id() == "open_settings" {
                if let Err(err) = open_settings_window(app) {
                    log_line(&format!("Failed to open settings window: {}", err));
                }
            } else if event.id() == "open_dev_settings" {
                if let Err(err) = open_dev_settings_window(app) {
                    log_line(&format!("Failed to open dev settings window: {}", err));
                }
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let child = app_handle
                .state::<ExcalidrawServerState>()
                .child
                .lock()
                .unwrap()
                .take();
            if let Some(mut child) = child {
                log_line("[excalidraw] shutting down canvas server");
                graceful_kill(&mut child);
            }
        }
    });
}
