//! Computer Use Agent (CUA) bridge.
//!
//! Implements the GPT-5.5 computer tool loop via the Responses API:
//! 1. Send task + screenshot to GPT-5.5 with `tools: [{ type: "computer" }]`
//! 2. Receive `computer_call` with `actions[]`
//! 3. Execute each action on the ISOLATED CUA browser (separate from user's Chrome)
//! 4. Capture updated screenshot → send as `computer_call_output`
//! 5. Repeat until the model stops returning `computer_call`
//!
//! Uses cua_browser.rs (isolated Chrome profile) so computer_use never
//! steals the user's cursor or disrupts their active browser tabs.

use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;

/// Maximum loop iterations to prevent runaway sessions
const MAX_TURNS: usize = 30;
/// Viewport dimensions (must match browser-agent.ts)
const VIEWPORT_W: u32 = 1280;
const VIEWPORT_H: u32 = 900;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CuaProgress {
    pub turn: usize,
    pub action_count: usize,
    pub status: String,
    pub summary: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CuaResult {
    pub ok: bool,
    pub turns_used: usize,
    pub summary: String,
    pub final_screenshot_base64: Option<String>,
}

/// Run a full CUA session: model plans + acts via the Playwright browser.
///
/// Called from the frontend. Uses `browser_command` (from browser.rs)
/// to execute actions and capture screenshots.
#[tauri::command]
pub async fn cua_run(task: String, url: Option<String>) -> Result<CuaResult, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    // Ensure isolated CUA browser is open; navigate if URL given
    if let Some(ref u) = url {
        crate::cua_browser::cua_browser_command("open".into(), serde_json::json!({ "url": u })).await?;
    }

    // Take initial screenshot
    let init_ss = take_screenshot().await?;

    // First Responses API call
    let first_body = serde_json::json!({
        "model": "gpt-5.5",
        "tools": [{
            "type": "computer",
            "computer": {
                "display_width": VIEWPORT_W,
                "display_height": VIEWPORT_H,
                "environment": "browser"
            }
        }],
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": task },
                    {
                        "type": "input_image",
                        "image_url": format!("data:image/png;base64,{}", init_ss.base64),
                        "detail": "original"
                    }
                ]
            }
        ],
        "reasoning": { "effort": "medium" },
        "max_output_tokens": 2048
    });

    let mut resp = call_responses_api(&api_key, &first_body)?;
    let mut prev_resp_id = extract_response_id(&resp);
    let mut turns: usize = 0;
    let mut last_screenshot_b64: Option<String> = Some(init_ss.base64);

    loop {
        turns += 1;
        if turns > MAX_TURNS {
            return Ok(CuaResult {
                ok: true,
                turns_used: turns,
                summary: "Reached maximum turns. Task may be partially complete.".into(),
                final_screenshot_base64: last_screenshot_b64,
            });
        }

        // Look for computer_call in the output
        let computer_call = find_computer_call(&resp);
        if computer_call.is_none() {
            // Model is done — extract its text summary
            let summary = extract_text_output(&resp);
            return Ok(CuaResult {
                ok: true,
                turns_used: turns,
                summary,
                final_screenshot_base64: last_screenshot_b64,
            });
        }

        let cc = computer_call.unwrap();
        let call_id = cc.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let actions = cc.get("actions").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        eprintln!("[cua] turn {turns}: executing {} actions", actions.len());

        // Execute each action via the Playwright sidecar
        for action in &actions {
            execute_cua_action(action).await?;
        }

        // Capture updated screenshot
        let ss = take_screenshot().await?;
        last_screenshot_b64 = Some(ss.base64.clone());

        // Build follow-up request with previous_response_id
        let follow_body = serde_json::json!({
            "model": "gpt-5.5",
            "tools": [{
                "type": "computer",
                "computer": {
                    "display_width": VIEWPORT_W,
                    "display_height": VIEWPORT_H,
                    "environment": "browser"
                }
            }],
            "previous_response_id": prev_resp_id,
            "input": [{
                "type": "computer_call_output",
                "call_id": call_id,
                "output": {
                    "type": "input_image",
                    "image_url": format!("data:image/png;base64,{}", ss.base64),
                    "detail": "original"
                }
            }],
            "reasoning": { "effort": "medium" },
            "max_output_tokens": 2048
        });

        resp = call_responses_api(&api_key, &follow_body)?;
        prev_resp_id = extract_response_id(&resp);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

struct Screenshot {
    base64: String,
}

async fn take_screenshot() -> Result<Screenshot, String> {
    let result = crate::cua_browser::cua_browser_command(
        "cua_screenshot".into(),
        serde_json::Value::Object(serde_json::Map::new()),
    )
    .await?;

    if !result.ok {
        return Err("Screenshot failed".into());
    }

    let b64 = result
        .data
        .get("base64")
        .and_then(|v| v.as_str())
        .ok_or("No base64 in screenshot response")?
        .to_string();

    Ok(Screenshot { base64: b64 })
}

/// Execute a single CUA action from the GPT-5.5 computer_call
async fn execute_cua_action(action: &serde_json::Value) -> Result<(), String> {
    let action_type = action
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    match action_type {
        "click" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let button = action
                .get("button")
                .and_then(|v| v.as_str())
                .unwrap_or("left");
            let keys = action
                .get("keys")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect::<Vec<_>>())
                .unwrap_or_default();

            let params = serde_json::json!({
                "x": x as i32,
                "y": y as i32,
                "button": button,
                "keys": keys,
            });
            crate::cua_browser::cua_browser_command("cua_click".into(), params).await?;
        }
        "double_click" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let params = serde_json::json!({ "x": x as i32, "y": y as i32 });
            crate::cua_browser::cua_browser_command("cua_double_click".into(), params).await?;
        }
        "type" => {
            let text = action
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let params = serde_json::json!({ "text": text });
            crate::cua_browser::cua_browser_command("cua_type".into(), params).await?;
        }
        "keypress" => {
            let keys = action
                .get("keys")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect::<Vec<_>>())
                .unwrap_or_default();
            let params = serde_json::json!({ "keys": keys });
            crate::cua_browser::cua_browser_command("cua_keypress".into(), params).await?;
        }
        "scroll" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(640.0);
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(450.0);
            let sx = action
                .get("scroll_x")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let sy = action
                .get("scroll_y")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let params =
                serde_json::json!({ "x": x as i32, "y": y as i32, "scroll_x": sx as i32, "scroll_y": sy as i32 });
            crate::cua_browser::cua_browser_command("cua_scroll".into(), params).await?;
        }
        "drag" => {
            let path = action
                .get("path")
                .cloned()
                .unwrap_or(serde_json::Value::Array(vec![]));
            let params = serde_json::json!({ "path": path });
            crate::cua_browser::cua_browser_command("cua_drag".into(), params).await?;
        }
        "move" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let params = serde_json::json!({ "x": x as i32, "y": y as i32 });
            crate::cua_browser::cua_browser_command("cua_move".into(), params).await?;
        }
        "wait" => {
            let ms = action.get("ms").and_then(|v| v.as_u64()).unwrap_or(2000);
            let params = serde_json::json!({ "ms": ms });
            crate::cua_browser::cua_browser_command("cua_wait".into(), params).await?;
        }
        "screenshot" => {
            // Model just wants a screenshot; we always send one after the batch
        }
        other => {
            eprintln!("[cua] unknown action type: {other}");
        }
    }

    Ok(())
}

/// Call the OpenAI Responses API
fn call_responses_api(
    api_key: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let body_str = serde_json::to_string(body).map_err(|e| format!("JSON: {e}"))?;
    let tmp = "/tmp/samuel-cua-request.json";
    fs::write(tmp, &body_str).map_err(|e| format!("Write tmp: {e}"))?;

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "-X",
            "POST",
            "https://api.openai.com/v1/responses",
            "-H",
            &format!("Authorization: Bearer {api_key}"),
            "-H",
            "Content-Type: application/json",
            "-d",
            &format!("@{tmp}"),
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("CUA API error: {stderr} {stdout}"));
    }

    let resp: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Parse CUA response: {e}"))?;

    if let Some(err) = resp.get("error") {
        return Err(format!("CUA API error: {err}"));
    }

    Ok(resp)
}

fn extract_response_id(resp: &serde_json::Value) -> String {
    resp.get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Find a `computer_call` item in the response output array
fn find_computer_call(resp: &serde_json::Value) -> Option<serde_json::Value> {
    let output = resp.get("output")?.as_array()?;
    for item in output {
        if item.get("type").and_then(|v| v.as_str()) == Some("computer_call") {
            return Some(item.clone());
        }
    }
    None
}

/// Extract text output from the response (model's final answer)
fn extract_text_output(resp: &serde_json::Value) -> String {
    let output = match resp.get("output").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return "Task completed.".to_string(),
    };

    let mut texts = Vec::new();
    for item in output {
        match item.get("type").and_then(|v| v.as_str()) {
            Some("message") => {
                if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                    for c in content {
                        if c.get("type").and_then(|v| v.as_str()) == Some("output_text") {
                            if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                texts.push(t.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if texts.is_empty() {
        "Task completed.".to_string()
    } else {
        texts.join("\n")
    }
}

// ── Native CUA ──────────────────────────────────────────────────────────────
// Same GPT-5.5 computer tool loop but operates on the REAL desktop via
// screencapture + CGEvent (native-input.swift). Can interact with ANY app.

/// Screenshot width sent to GPT-5.5 (resized from actual display resolution)
const NATIVE_W: u32 = 1280;

/// Query actual display point-space dimensions via NSScreen (for coordinate scaling).
/// Returns (width_points, height_points) for the currently selected display.
fn get_display_point_dimensions() -> (f64, f64) {
    let display_idx = crate::commands::get_default_display();
    let script = format!(
        r#"use framework "AppKit"
set screens to current application's NSScreen's screens()
set idx to {}
if idx > (count of screens) then set idx to 1
set s to item idx of screens
set f to s's frame()
set w to item 1 of item 2 of f
set h to item 2 of item 2 of f
return (w as text) & "x" & (h as text)"#,
        display_idx
    );
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output();
    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if let Some((w, h)) = s.split_once('x') {
            if let (Ok(wf), Ok(hf)) = (w.parse::<f64>(), h.parse::<f64>()) {
                eprintln!("[cua-native] display {} point dims: {wf}x{hf}", display_idx);
                return (wf, hf);
            }
        }
    }
    eprintln!("[cua-native] could not query display dims, using 1440x900 fallback");
    (1440.0, 900.0)
}

/// Run a CUA session against the NATIVE macOS desktop.
/// GPT-5.5 sees the real screen and clicks/types on whatever app is visible.
#[tauri::command]
pub async fn cua_run_native(task: String, app: Option<String>) -> Result<CuaResult, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    // Query actual display dimensions for coordinate scaling.
    // Screenshot is resized to NATIVE_W wide — GPT-5.5 returns coords in that space.
    // We must scale back to actual screen point-space for CGEvent.
    let (screen_w, screen_h) = get_display_point_dimensions();
    let screenshot_h = (NATIVE_W as f64 * screen_h / screen_w).round() as u32;
    let scale_x = screen_w / NATIVE_W as f64;
    let scale_y = screen_h / screenshot_h as f64;
    eprintln!("[cua-native] screenshot: {NATIVE_W}x{screenshot_h}, screen: {screen_w}x{screen_h}, scale: {scale_x:.2}x{scale_y:.2}");

    // Optionally bring the target app to front
    if let Some(ref app_name) = app {
        let script = format!(r#"tell application "{}" to activate"#, app_name);
        let _ = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .output();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // Take initial native screenshot
    let init_ss = native_screenshot_b64()?;

    let first_body = serde_json::json!({
        "model": "gpt-5.5",
        "tools": [{
            "type": "computer",
            "computer": {
                "display_width": NATIVE_W,
                "display_height": screenshot_h,
                "environment": "mac"
            }
        }],
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": task },
                    {
                        "type": "input_image",
                        "image_url": format!("data:image/jpeg;base64,{}", init_ss),
                        "detail": "original"
                    }
                ]
            }
        ],
        "reasoning": { "effort": "medium" },
        "max_output_tokens": 2048
    });

    let mut resp = call_responses_api(&api_key, &first_body)?;
    let mut prev_resp_id = extract_response_id(&resp);
    let mut turns: usize = 0;
    let mut last_screenshot_b64: Option<String> = Some(init_ss);

    loop {
        turns += 1;
        if turns > MAX_TURNS {
            return Ok(CuaResult {
                ok: true,
                turns_used: turns,
                summary: "Reached maximum turns. Task may be partially complete.".into(),
                final_screenshot_base64: last_screenshot_b64,
            });
        }

        let computer_call = find_computer_call(&resp);
        if computer_call.is_none() {
            let summary = extract_text_output(&resp);
            return Ok(CuaResult {
                ok: true,
                turns_used: turns,
                summary,
                final_screenshot_base64: last_screenshot_b64,
            });
        }

        let cc = computer_call.unwrap();
        let call_id = cc.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let actions = cc.get("actions").and_then(|v| v.as_array()).cloned().unwrap_or_default();

        eprintln!("[cua-native] turn {turns}: executing {} actions", actions.len());

        for action in &actions {
            execute_native_action(action, scale_x, scale_y)?;
        }

        // Brief pause for UI to update after actions
        std::thread::sleep(std::time::Duration::from_millis(300));

        let ss = native_screenshot_b64()?;
        last_screenshot_b64 = Some(ss.clone());

        let follow_body = serde_json::json!({
            "model": "gpt-5.5",
            "tools": [{
                "type": "computer",
                "computer": {
                    "display_width": NATIVE_W,
                    "display_height": screenshot_h,
                    "environment": "mac"
                }
            }],
            "previous_response_id": prev_resp_id,
            "input": [{
                "type": "computer_call_output",
                "call_id": call_id,
                "output": {
                    "type": "input_image",
                    "image_url": format!("data:image/jpeg;base64,{}", ss),
                    "detail": "original"
                }
            }],
            "reasoning": { "effort": "medium" },
            "max_output_tokens": 2048
        });

        resp = call_responses_api(&api_key, &follow_body)?;
        prev_resp_id = extract_response_id(&resp);
    }
}

/// Take a native screenshot at CUA resolution (1280px wide JPEG)
fn native_screenshot_b64() -> Result<String, String> {
    let tmp_png = "/tmp/samuel-cua-native-ss.png";
    let tmp_jpg = "/tmp/samuel-cua-native-ss.jpg";
    let _ = fs::remove_file(tmp_png);

    let display_idx = crate::commands::get_default_display();
    let d_flag = format!("-D{display_idx}");

    let sc = Command::new("/usr/sbin/screencapture")
        .args(["-x", &d_flag, tmp_png])
        .output()
        .map_err(|e| format!("screencapture: {e}"))?;

    if !sc.status.success() {
        return Err("screencapture failed".into());
    }

    let w_str = NATIVE_W.to_string();
    let q_str = "50".to_string();

    let sips = Command::new("/usr/bin/sips")
        .args([
            "--resampleWidth", &w_str,
            "--setProperty", "format", "jpeg",
            "--setProperty", "formatOptions", &q_str,
            tmp_png, "--out", tmp_jpg,
        ])
        .output();

    let _ = fs::remove_file(tmp_png);
    match sips {
        Ok(o) if o.status.success() => {}
        _ => return Err("Failed to resize native screenshot".into()),
    }

    let data = fs::read(tmp_jpg).map_err(|e| format!("Read: {e}"))?;
    let _ = fs::remove_file(tmp_jpg);
    eprintln!("[cua-native] screenshot: {} bytes", data.len());
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data))
}

/// Execute a single CUA action natively via CGEvent (native-input.swift).
/// Coordinates from GPT-5.5 are in screenshot-space (NATIVE_W wide) and must
/// be scaled to actual screen point-space via (scale_x, scale_y).
fn execute_native_action(action: &serde_json::Value, scale_x: f64, scale_y: f64) -> Result<(), String> {
    let action_type = action.get("type").and_then(|v| v.as_str()).unwrap_or("unknown");

    let helper = find_native_input_helper();

    match action_type {
        "click" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) * scale_x;
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) * scale_y;
            let button = action.get("button").and_then(|v| v.as_str()).unwrap_or("left");
            eprintln!("[cua-native] click ({x:.0}, {y:.0}) [{button}]");
            run_native_input(&helper, &["click", &x.to_string(), &y.to_string(), button])?;
        }
        "double_click" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) * scale_x;
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) * scale_y;
            eprintln!("[cua-native] double_click ({x:.0}, {y:.0})");
            run_native_input(&helper, &["double_click", &x.to_string(), &y.to_string()])?;
        }
        "type" => {
            let text = action.get("text").and_then(|v| v.as_str()).unwrap_or("");
            run_native_input(&helper, &["type", text])?;
        }
        "keypress" => {
            let keys: Vec<String> = action.get("keys")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let mut args = vec!["keypress".to_string()];
            args.extend(keys);
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            run_native_input(&helper, &refs)?;
        }
        "scroll" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(640.0) * scale_x;
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(450.0) * scale_y;
            let sx = action.get("scroll_x").and_then(|v| v.as_i64()).unwrap_or(0);
            let sy = action.get("scroll_y").and_then(|v| v.as_i64()).unwrap_or(0);
            run_native_input(&helper, &[
                "scroll", &x.to_string(), &y.to_string(),
                &sx.to_string(), &sy.to_string()
            ])?;
        }
        "drag" => {
            let path = action.get("path").and_then(|v| v.as_array());
            if let Some(pts) = path {
                let mut args = vec!["drag".to_string()];
                for pt in pts {
                    if let Some(arr) = pt.as_array() {
                        if arr.len() >= 2 {
                            args.push((arr[0].as_f64().unwrap_or(0.0) * scale_x).to_string());
                            args.push((arr[1].as_f64().unwrap_or(0.0) * scale_y).to_string());
                        }
                    }
                }
                let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                run_native_input(&helper, &refs)?;
            }
        }
        "move" => {
            let x = action.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) * scale_x;
            let y = action.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) * scale_y;
            run_native_input(&helper, &["move", &x.to_string(), &y.to_string()])?;
        }
        "wait" => {
            let ms = action.get("ms").and_then(|v| v.as_u64()).unwrap_or(2000);
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        "screenshot" => {
            // Model just wants a fresh screenshot; we always capture after the batch
        }
        other => {
            eprintln!("[cua-native] unknown action: {other}");
        }
    }

    Ok(())
}

fn find_native_input_helper() -> String {
    let cwd = std::env::current_dir().unwrap_or_default().join("helpers").join("native-input.swift");
    if cwd.exists() {
        return cwd.to_str().unwrap_or("helpers/native-input.swift").to_string();
    }
    let alt = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("helpers").join("native-input.swift");
    if alt.exists() {
        return alt.to_str().unwrap_or("helpers/native-input.swift").to_string();
    }
    "helpers/native-input.swift".to_string()
}

fn run_native_input(helper: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new("/usr/bin/swift")
        .arg(helper)
        .args(args)
        .output()
        .map_err(|e| format!("native-input: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("native-input failed: {stderr}"));
    }
    Ok(())
}
