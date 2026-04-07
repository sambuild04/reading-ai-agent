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

/// Sanitize plugin name to prevent path traversal
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

    // Back up existing plugin before overwrite
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

/// Call GPT-4o-mini to generate plugin code from a natural language description.
#[tauri::command]
pub async fn generate_plugin_code(description: String) -> Result<String, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    let system_prompt = r#"You are a code generator for a Tauri desktop app plugin system.
Generate a JavaScript plugin file that will be executed via `new Function("secrets", code)(secretsHelper)`.

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
  execute: async (args) => {
    // Implementation here
    // Available APIs:
    //   fetch() — make HTTP requests
    //   secrets.get("key_name") — get a stored API key (returns Promise<string|null>)
    //   JSON.parse/stringify
    //   Date, Math, etc.
    // Return a string result
    return "result";
  }
};
```

Rules:
- ONLY output the raw JavaScript code, no markdown fences, no explanation
- The code runs inside new Function("secrets", code), so use `return { ... }` not `export default`
- The `secrets` parameter is available in scope — use `await secrets.get("key_name")` for API keys
- If an API key is needed and secrets.get() returns null, return a message asking the user to provide the key
- execute() must return a string (or something JSON.stringify-able)
- Use fetch() for any web API calls
- Keep it simple and self-contained
- No imports — everything must be inline"#;

    let body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": description }
        ],
        "temperature": 0.2,
        "max_tokens": 2000
    });

    let body_str = serde_json::to_string(&body).map_err(|e| format!("JSON: {e}"))?;
    let tmp = "/tmp/samuel-plugin-gen.json";
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
        return Err(format!("GPT-4o-mini call failed: {stderr}"));
    }

    let resp: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Parse response: {e}"))?;

    let code = resp["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("No content in GPT response")?
        .trim()
        .to_string();

    // Strip markdown fences if the model wrapped them
    let code = code
        .strip_prefix("```javascript")
        .or_else(|| code.strip_prefix("```js"))
        .or_else(|| code.strip_prefix("```"))
        .unwrap_or(&code);
    let code = code.strip_suffix("```").unwrap_or(code).trim().to_string();

    eprintln!("[plugins] generated code ({} bytes)", code.len());
    Ok(code)
}
