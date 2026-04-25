use std::fs;
use std::path::PathBuf;
use std::process::Command;

const SAMUEL_DIR: &str = ".samuel";
const PLUGINS_DIR: &str = "plugins";

fn plugins_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(SAMUEL_DIR).join(PLUGINS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Create plugins dir: {e}"))?;
    }
    Ok(dir)
}

fn safe_name(name: &str) -> Result<String, String> {
    let clean = name
        .trim()
        .replace(['/', '\\'], "")
        .replace("..", "")
        .replace(' ', "_");
    if clean.is_empty() || clean.starts_with('.') {
        return Err("Invalid plugin name".to_string());
    }
    Ok(clean)
}

#[tauri::command]
pub async fn get_plugin_dir() -> Result<String, String> {
    let dir = plugins_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_plugins() -> Result<Vec<String>, String> {
    let dir = plugins_dir()?;
    let mut names = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| format!("Read plugins dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "js") {
            if let Some(stem) = path.file_stem() {
                names.push(stem.to_string_lossy().to_string());
            }
        }
    }

    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn read_plugin(name: String) -> Result<String, String> {
    let clean = safe_name(&name)?;
    let path = plugins_dir()?.join(format!("{clean}.js"));
    fs::read_to_string(&path).map_err(|e| format!("Read plugin '{clean}': {e}"))
}

#[tauri::command]
pub async fn write_plugin(name: String, code: String) -> Result<String, String> {
    let clean = safe_name(&name)?;
    let dir = plugins_dir()?;
    let path = dir.join(format!("{clean}.js"));

    if path.exists() {
        let backup = dir.join(format!("{clean}.js.backup"));
        let _ = fs::copy(&path, &backup);
        eprintln!("[plugins] backed up {clean}.js → {clean}.js.backup");
    }

    fs::write(&path, &code).map_err(|e| format!("Write plugin '{clean}': {e}"))?;
    eprintln!("[plugins] wrote {clean}.js ({} bytes)", code.len());
    Ok(format!("Plugin '{clean}' saved."))
}

#[tauri::command]
pub async fn delete_plugin(name: String) -> Result<String, String> {
    let clean = safe_name(&name)?;
    let path = plugins_dir()?.join(format!("{clean}.js"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Delete plugin '{clean}': {e}"))?;
        eprintln!("[plugins] deleted {clean}.js");
        Ok(format!("Plugin '{clean}' removed."))
    } else {
        Err(format!("Plugin '{clean}' not found."))
    }
}

// ── LLM helpers ──────────────────────────────────────────────────────────

/// Call OpenAI chat completions (standard non-reasoning models).
fn call_openai(api_key: &str, model: &str, system: &str, user: &str, temp: f64, max_tokens: u32) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": temp,
        "max_tokens": max_tokens
    });

    call_openai_raw(api_key, &body)
}

/// Call OpenAI Responses API with reasoning support (for GPT-5.5).
fn call_openai_reasoning(
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    reasoning_effort: &str,
    max_output_tokens: u32,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "input": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "reasoning": { "effort": reasoning_effort },
        "max_output_tokens": max_output_tokens
    });

    let body_str = serde_json::to_string(&body).map_err(|e| format!("JSON: {e}"))?;
    let tmp = "/tmp/samuel-plugin-reasoning.json";
    fs::write(tmp, &body_str).map_err(|e| format!("Write tmp: {e}"))?;

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s", "-f",
            "-X", "POST",
            "https://api.openai.com/v1/responses",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &format!("@{tmp}"),
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        eprintln!("[plugins] reasoning API error: {stderr} {stdout}");
        // Fallback to chat completions if Responses API fails
        return call_openai(api_key, model, system, user, 0.2, max_output_tokens);
    }

    let resp: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Parse response: {e}"))?;

    // Responses API returns output[] array with message items
    if let Some(output_arr) = resp["output"].as_array() {
        for item in output_arr {
            if item["type"].as_str() == Some("message") {
                if let Some(content_arr) = item["content"].as_array() {
                    for c in content_arr {
                        if c["type"].as_str() == Some("output_text") {
                            if let Some(text) = c["text"].as_str() {
                                return Ok(text.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback: try chat completions format
    if let Some(text) = resp["choices"][0]["message"]["content"].as_str() {
        return Ok(text.trim().to_string());
    }

    Err("No content in reasoning response".to_string())
}

fn call_openai_raw(api_key: &str, body: &serde_json::Value) -> Result<String, String> {
    let body_str = serde_json::to_string(body).map_err(|e| format!("JSON: {e}"))?;
    let tmp = "/tmp/samuel-plugin-llm.json";
    fs::write(tmp, &body_str).map_err(|e| format!("Write tmp: {e}"))?;

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s", "-f",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &format!("@{tmp}"),
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("LLM call failed: {stderr}"));
    }

    let resp: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Parse response: {e}"))?;

    resp["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No content in LLM response".to_string())
}

fn strip_fences(code: &str) -> String {
    let s = code
        .strip_prefix("```javascript")
        .or_else(|| code.strip_prefix("```js"))
        .or_else(|| code.strip_prefix("```json"))
        .or_else(|| code.strip_prefix("```"))
        .unwrap_or(code);
    s.strip_suffix("```").unwrap_or(s).trim().to_string()
}

// ── Code generation (GPT-5.5 with reasoning) ─────────────────────────────

const PLUGIN_SYSTEM_PROMPT: &str = r#"You are a code generator for a Tauri desktop app plugin system.
Generate a JavaScript plugin file that will be executed via `new Function("secrets", "invoke", "sleep", "ui", code)(...)`.

The plugin MUST follow this exact shape — use `return { ... }` at the top level:

```
return {
  name: "tool_name",
  description: "What this tool does",
  parameters: {
    type: "object",
    properties: {
      param1: { type: "string", description: "..." }
    },
    required: ["param1"]
  },
  // REQUIRED: validation function that checks if output looks correct
  validates: (result) => {
    // Return true if the result looks right, false otherwise
    // Example: result != null && typeof result === "string" && result.length > 0
    return result != null;
  },
  execute: async (args) => {
    // Implementation here
    // Available APIs:
    //
    // ── Data / network ──
    //   fetch() — make HTTP requests to any URL
    //   fetch("https://r.jina.ai/" + url) — read any URL as clean LLM-friendly text (free, no key)
    //   fetch("https://s.jina.ai/" + encodeURIComponent(query)) — search the web (free, no key)
    //   secrets.get("key_name") — get a stored API key (returns Promise<string|null>)
    //   invoke(command, args) — call Tauri backend commands (returns Promise<unknown>)
    //     invoke("web_search", { query: "...", page: 1 }) — search the web
    //     invoke("web_read", { url: "..." }) — fetch and read a web page
    //     invoke("browser_command", { action: "open", params: { url: "..." } }) — control browser
    //   sleep(ms) — wait for a duration (returns Promise<void>)
    //
    // ── UI modification ──
    //   ui.set(component, property, value) — change any UI property
    //   ui.injectCSS(id, cssString) — add or replace a custom <style> block
    //   ui.removeCSS(id) — remove an injected style block
    //   ui.showPanel(id, html, opts?) — create a floating HTML overlay panel
    //     opts: { position: "right"|"left"|"center"|"bottom", width: "300px" }
    //   ui.hidePanel(id) — remove a custom panel
    //
    //   JSON.parse/stringify, Date, Math, etc.
    // Return a string result (or JSON.stringify-able)
    return "result";
  }
};
```

WRAPPING EXISTING TOOLS (optional — use when extending, not replacing):
```
return {
  name: "enhanced_web_browse",
  wraps: "web_browse",   // declares this wraps the existing web_browse tool
  description: "Enhanced web browse with caching",
  parameters: { ... },   // same or extended parameters
  validates: (result) => result != null,
  execute: async (args, original) => {
    // `original` is the wrapped tool's execute function
    const result = await original(args);
    // modify or enhance the result
    return result;
  }
};
```

Rules:
- ONLY output the raw JavaScript code, no markdown fences, no explanation
- The code runs inside new Function("secrets", "invoke", "sleep", "ui", code)
- ALWAYS include a `validates` function that checks the output is correct
- execute() must return a string (or something JSON.stringify-able)
- If an API key is needed and secrets.get() returns null, return a clear message asking for the key
- Use fetch() for any web API calls
- Prefer well-documented stable APIs with free tiers
- When creating visual panels (ui.showPanel), use clean semantic HTML with inline styles matching the dark glass theme
- Keep it simple and self-contained — no imports
- Handle errors gracefully — catch and return descriptive messages, don't let errors crash silently"#;

#[tauri::command]
pub async fn generate_plugin_code(description: String) -> Result<String, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    // Use GPT-5.5 with medium reasoning for code generation
    let raw = call_openai_reasoning(
        &api_key,
        "gpt-5.5",
        PLUGIN_SYSTEM_PROMPT,
        &description,
        "medium",
        4000,
    )?;
    let code = strip_fences(&raw);
    eprintln!("[plugins] generated code ({} bytes) via gpt-5.5", code.len());
    Ok(code)
}

/// Semantic quality check — GPT-4o-mini is sufficient for review.
#[tauri::command]
pub async fn judge_plugin_code(description: String, code: String) -> Result<String, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    let system_prompt = r#"You are a code reviewer for an AI assistant's plugin system.
Given a user's request and the generated JavaScript plugin code, determine if the code
correctly implements what was requested.

Check for:
- Does the code actually do what the user asked? (not a different feature)
- Are API endpoints plausible and correctly used?
- Does the execute() function return a meaningful result?
- Does it include a validates() function?
- Are there obvious logic errors?
- Does it handle errors gracefully?

Reply ONLY with valid JSON, no other text:
- If the code is correct: { "ok": true }
- If there's an issue: { "ok": false, "reason": "brief description of the problem" }"#;

    let user_msg = format!("REQUEST: {description}\n\nCODE:\n```\n{code}\n```");

    let raw = call_openai(&api_key, "gpt-4o-mini", system_prompt, &user_msg, 0.1, 500)?;

    let clean = strip_fences(&raw);
    match serde_json::from_str::<serde_json::Value>(&clean) {
        Ok(v) => {
            if v["ok"].as_bool() == Some(true) {
                eprintln!("[plugins] judge: ok");
                Ok("ok".to_string())
            } else {
                let reason = v["reason"].as_str().unwrap_or("Unknown issue").to_string();
                eprintln!("[plugins] judge flagged: {reason}");
                Ok(reason)
            }
        }
        Err(_) => {
            eprintln!("[plugins] judge: unparseable response, treating as ok");
            Ok("ok".to_string())
        }
    }
}

// ── Diagnosis (GPT-5.5 with high reasoning) ──────────────────────────────

#[tauri::command]
pub async fn diagnose_plugin_failure(
    plugin_name: String,
    plugin_source: String,
    input_args: String,
    error_message: String,
    actual_output: String,
    signal: String,
) -> Result<String, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    let system_prompt = r#"You are diagnosing an AI-generated plugin failure. Output ONLY valid JSON.

Categorize the failure as ONE of:
- "syntax_logic"       → wrong code, fixable by patching
- "wrong_assumption"   → code assumed something untrue about the API/data
- "external_change"    → API/page/service changed since plugin was written
- "wrong_input"        → code is correct, input is malformed or unexpected
- "structural"         → overall approach is wrong, needs full rewrite
- "environmental"      → sandbox/permission/network issue
- "unknown"            → can't determine from available info

Then specify next_step as ONE of:
- "patch"              → apply a targeted fix to the existing code
- "rewrite"            → regenerate from scratch with a new approach
- "ask_user"           → need user input/clarification to proceed
- "give_up"            → not fixable autonomously, explain why

Output this exact JSON shape:
{
  "category": "...",
  "evidence": "1-sentence explanation of why this category",
  "next_step": "...",
  "user_facing_summary": "1-sentence plain-language explanation for the user"
}"#;

    let user_msg = format!(
        "PLUGIN: {plugin_name}\nSIGNAL: {signal}\n\
         ERROR: {error_message}\n\
         OUTPUT: {actual_output}\n\
         INPUT: {input_args}\n\n\
         SOURCE:\n```\n{plugin_source}\n```"
    );

    // Use GPT-5.5 with high reasoning for diagnosis — this is the hard part
    let raw = call_openai_reasoning(
        &api_key,
        "gpt-5.5",
        system_prompt,
        &user_msg,
        "high",
        1000,
    )?;

    let clean = strip_fences(&raw);

    // Validate it's proper JSON
    match serde_json::from_str::<serde_json::Value>(&clean) {
        Ok(v) => {
            if v.get("category").is_some() && v.get("next_step").is_some() {
                Ok(clean)
            } else {
                Ok(serde_json::json!({
                    "category": "unknown",
                    "evidence": "Diagnosis response missing required fields",
                    "next_step": "patch",
                    "user_facing_summary": format!("The plugin '{}' had an issue. Let me try to fix it.", plugin_name)
                }).to_string())
            }
        }
        Err(_) => {
            Ok(serde_json::json!({
                "category": "unknown",
                "evidence": "Could not parse diagnosis",
                "next_step": "patch",
                "user_facing_summary": format!("The plugin '{}' had an issue. Let me try to fix it.", plugin_name)
            }).to_string())
        }
    }
}
