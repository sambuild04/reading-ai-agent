use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const SAMUEL_DIR: &str = ".samuel";
const SECRETS_FILE: &str = "secrets.json";

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SecretsStore {
    #[serde(flatten)]
    pub entries: HashMap<String, String>,
}

pub fn secrets_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(SAMUEL_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Create ~/.samuel: {e}"))?;
    }
    Ok(dir.join(SECRETS_FILE))
}

pub fn load_secrets() -> SecretsStore {
    let Ok(path) = secrets_path() else {
        return SecretsStore::default();
    };
    let Ok(data) = fs::read_to_string(&path) else {
        return SecretsStore::default();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_secrets(store: &SecretsStore) -> Result<(), String> {
    let path = secrets_path()?;
    let json = serde_json::to_string_pretty(store).map_err(|e| format!("JSON: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Write secrets: {e}"))
}

#[tauri::command]
pub async fn get_secret(name: String) -> Result<Option<String>, String> {
    let store = load_secrets();
    Ok(store.entries.get(&name).cloned())
}

#[tauri::command]
pub async fn set_secret(name: String, value: String) -> Result<String, String> {
    let mut store = load_secrets();
    store.entries.insert(name.clone(), value);
    save_secrets(&store)?;
    eprintln!("[secrets] stored '{name}'");
    Ok(format!("Secret '{name}' saved."))
}

#[tauri::command]
pub async fn delete_secret(name: String) -> Result<String, String> {
    let mut store = load_secrets();
    if store.entries.remove(&name).is_some() {
        save_secrets(&store)?;
        eprintln!("[secrets] deleted '{name}'");
        Ok(format!("Secret '{name}' removed."))
    } else {
        Err(format!("Secret '{name}' not found."))
    }
}

#[tauri::command]
pub async fn list_secrets() -> Result<Vec<String>, String> {
    let store = load_secrets();
    let mut names: Vec<String> = store.entries.keys().cloned().collect();
    names.sort();
    Ok(names)
}
