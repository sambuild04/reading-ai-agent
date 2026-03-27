use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

const MEMORY_DIR: &str = ".samuel";
const MEMORY_FILE: &str = "memory.json";
const MAX_RECENT_OBSERVATIONS: usize = 10;
const MAX_RECENT_TRANSCRIPTS: usize = 5;
const VOCABULARY_COOLDOWN_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SamuelMemory {
    #[serde(default)]
    pub vocabulary_seen: HashMap<String, u64>,
    #[serde(default)]
    pub recent_observations: Vec<String>,
    #[serde(default)]
    pub facts: HashMap<String, String>,
    /// Raw audio transcripts from ambient listening — Samuel can reference these when asked
    #[serde(default)]
    pub recent_transcripts: Vec<String>,
}

static MEMORY: Mutex<Option<SamuelMemory>> = Mutex::new(None);

fn memory_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(MEMORY_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Create ~/.samuel: {e}"))?;
    }
    Ok(dir.join(MEMORY_FILE))
}

fn load_memory() -> SamuelMemory {
    if let Ok(path) = memory_path() {
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(mem) = serde_json::from_str(&data) {
                return mem;
            }
        }
    }
    SamuelMemory::default()
}

fn save_memory(mem: &SamuelMemory) {
    if let Ok(path) = memory_path() {
        if let Ok(json) = serde_json::to_string_pretty(mem) {
            let _ = fs::write(path, json);
        }
    }
}

fn with_memory<F, R>(f: F) -> R
where
    F: FnOnce(&mut SamuelMemory) -> R,
{
    let mut guard = MEMORY.lock().unwrap();
    if guard.is_none() {
        *guard = Some(load_memory());
    }
    let mem = guard.as_mut().unwrap();
    let result = f(mem);
    save_memory(mem);
    result
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Build a context string for injection into triage/analysis prompts.
pub fn get_context() -> String {
    with_memory(|mem| {
        let mut parts = Vec::new();

        for (k, v) in &mem.facts {
            parts.push(format!("{k}: {v}"));
        }

        let recent: Vec<&str> = mem
            .recent_observations
            .iter()
            .rev()
            .take(3)
            .map(|s| s.as_str())
            .collect();
        if !recent.is_empty() {
            parts.push(format!("Recent: {}", recent.join("; ")));
        }

        let now = now_secs();
        let recent_vocab: Vec<&str> = mem
            .vocabulary_seen
            .iter()
            .filter(|(_, &ts)| now.saturating_sub(ts) < VOCABULARY_COOLDOWN_SECS)
            .map(|(w, _)| w.as_str())
            .take(15)
            .collect();
        if !recent_vocab.is_empty() {
            parts.push(format!(
                "Already taught (don't repeat): {}",
                recent_vocab.join(", ")
            ));
        }

        if parts.is_empty() {
            "No prior context.".to_string()
        } else {
            parts.join(". ")
        }
    })
}

pub fn record_observation(summary: &str) {
    with_memory(|mem| {
        mem.recent_observations.push(summary.to_string());
        if mem.recent_observations.len() > MAX_RECENT_OBSERVATIONS {
            mem.recent_observations.remove(0);
        }
    });
}

pub fn record_transcript(text: &str) {
    with_memory(|mem| {
        mem.recent_transcripts.push(text.to_string());
        if mem.recent_transcripts.len() > MAX_RECENT_TRANSCRIPTS {
            mem.recent_transcripts.remove(0);
        }
    });
}

pub fn get_recent_transcripts() -> Vec<String> {
    with_memory(|mem| mem.recent_transcripts.clone())
}

pub fn record_vocabulary(words: &[String]) {
    let now = now_secs();
    with_memory(|mem| {
        for word in words {
            mem.vocabulary_seen.insert(word.clone(), now);
        }
    });
}

pub fn set_fact(key: &str, value: &str) {
    with_memory(|mem| {
        mem.facts.insert(key.to_string(), value.to_string());
    });
}

#[tauri::command]
pub async fn memory_get_context() -> Result<String, String> {
    Ok(get_context())
}

#[tauri::command]
pub async fn memory_set_fact(key: String, value: String) -> Result<(), String> {
    set_fact(&key, &value);
    eprintln!("[memory] fact: {key} = {value}");
    Ok(())
}
