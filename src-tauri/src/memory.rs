use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;

const MEMORY_DIR: &str = ".samuel";
const MEMORY_FILE: &str = "memory.json";
const MAX_RECENT_OBSERVATIONS: usize = 10;
const MAX_RECENT_TRANSCRIPTS: usize = 5;
const VOCABULARY_COOLDOWN_SECS: u64 = 24 * 60 * 60;
const PERMANENT_KNOWN: u64 = u64::MAX;
const MAX_WATCH_ENTRIES: usize = 100;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Correction {
    pub timestamp: u64,
    pub what: String,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WatchEntry {
    pub content_hash: u64,
    pub title_hint: String,
    pub first_seen: u64,
    pub last_seen: u64,
    pub session_count: u32,
    pub total_minutes: u32,
}

/// An active trigger: something Samuel watches for in audio or on screen.
/// Triggers are first-class objects with their own evaluation logic,
/// separate from the conversation loop (ambient agent architecture).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WatchAlert {
    pub id: String,
    pub description: String,
    /// "keyword" = fast string match, "classifier" = GPT-4o-mini per event
    #[serde(default = "default_condition_type")]
    pub condition_type: String,
    /// For "keyword" type: specific words/phrases to match (lowercase)
    #[serde(default)]
    pub keywords: Vec<String>,
    /// "audio", "screen", or "both"
    #[serde(default = "default_watch_source")]
    pub source: String,
    /// Template for what Samuel says when trigger fires
    #[serde(default)]
    pub message_template: String,
    pub created_at: u64,
    /// How many times this alert has fired
    #[serde(default)]
    pub fire_count: u32,
    /// Seconds between repeated firings (prevents spam)
    #[serde(default = "default_cooldown")]
    pub cooldown_secs: u64,
    /// Unix timestamp of last fire (0 = never)
    #[serde(default)]
    pub last_fired_at: u64,
    pub enabled: bool,
}

fn default_watch_source() -> String {
    "both".to_string()
}

fn default_condition_type() -> String {
    "keyword".to_string()
}

fn default_cooldown() -> u64 {
    30
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SamuelMemory {
    #[serde(default)]
    pub vocabulary_seen: HashMap<String, u64>,
    #[serde(default)]
    pub recent_observations: Vec<String>,
    #[serde(default)]
    pub facts: HashMap<String, String>,
    #[serde(default)]
    pub recent_transcripts: Vec<String>,
    #[serde(default)]
    pub corrections: Vec<Correction>,
    #[serde(default)]
    pub watch_history: Vec<WatchEntry>,
    #[serde(default)]
    pub active_watches: Vec<WatchAlert>,
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

        // Permanently known words — user explicitly said they know these
        let known_forever: Vec<&str> = mem
            .vocabulary_seen
            .iter()
            .filter(|(_, &ts)| ts == PERMANENT_KNOWN)
            .map(|(w, _)| w.as_str())
            .take(30)
            .collect();
        if !known_forever.is_empty() {
            parts.push(format!(
                "User already knows (NEVER mention): {}",
                known_forever.join(", ")
            ));
        }

        // Recently taught — 24h cooldown
        let recent_vocab: Vec<&str> = mem
            .vocabulary_seen
            .iter()
            .filter(|(_, &ts)| ts != PERMANENT_KNOWN && now.saturating_sub(ts) < VOCABULARY_COOLDOWN_SECS)
            .map(|(w, _)| w.as_str())
            .take(15)
            .collect();
        if !recent_vocab.is_empty() {
            parts.push(format!(
                "Recently taught (don't repeat today): {}",
                recent_vocab.join(", ")
            ));
        }

        // Recent corrections — things Samuel got wrong or user behavioral feedback
        let corrections: Vec<&str> = mem
            .corrections
            .iter()
            .rev()
            .take(5)
            .map(|c| c.what.as_str())
            .collect();
        if !corrections.is_empty() {
            parts.push(format!(
                "User corrections (FOLLOW THESE): {}",
                corrections.join("; ")
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

/// Mark vocabulary as permanently known — will never be mentioned again
pub fn mark_known(words: &[String]) {
    with_memory(|mem| {
        for word in words {
            mem.vocabulary_seen.insert(word.clone(), PERMANENT_KNOWN);
        }
    });
}

pub fn set_fact(key: &str, value: &str) {
    with_memory(|mem| {
        mem.facts.insert(key.to_string(), value.to_string());
    });
}

// ── Watch history helpers ────────────────────────────────────────────────────

/// Hash a transcript window to detect repeat content
fn hash_content(text: &str) -> u64 {
    // Normalize: lowercase, strip punctuation, collapse whitespace
    let normalized: String = text
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    hasher.finish()
}

/// Record that the user is watching content. Returns (session_count, total_minutes) for this content.
pub fn record_watch(transcript_window: &str, title_hint: &str) -> (u32, u32) {
    let hash = hash_content(transcript_window);
    let now = now_secs();

    with_memory(|mem| {
        // Find existing entry with similar hash
        if let Some(entry) = mem.watch_history.iter_mut().find(|e| e.content_hash == hash) {
            // Same content seen before — bump if >30 min since last
            if now.saturating_sub(entry.last_seen) > 30 * 60 {
                entry.session_count += 1;
            }
            entry.total_minutes += 5; // each assessment = ~5 min window
            entry.last_seen = now;
            if !title_hint.is_empty() && entry.title_hint.is_empty() {
                entry.title_hint = title_hint.to_string();
            }
            (entry.session_count, entry.total_minutes)
        } else {
            // New content
            let entry = WatchEntry {
                content_hash: hash,
                title_hint: title_hint.to_string(),
                first_seen: now,
                last_seen: now,
                session_count: 1,
                total_minutes: 5,
            };
            let result = (entry.session_count, entry.total_minutes);
            mem.watch_history.push(entry);
            // Evict old entries
            if mem.watch_history.len() > MAX_WATCH_ENTRIES {
                mem.watch_history.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
                mem.watch_history.truncate(MAX_WATCH_ENTRIES);
            }
            result
        }
    })
}

/// Get watch stats for content matching a transcript window
pub fn get_watch_stats(transcript_window: &str) -> Option<(u32, u32, String)> {
    let hash = hash_content(transcript_window);
    with_memory(|mem| {
        mem.watch_history
            .iter()
            .find(|e| e.content_hash == hash)
            .map(|e| (e.session_count, e.total_minutes, e.title_hint.clone()))
    })
}

const MAX_CORRECTIONS: usize = 50;

pub fn add_correction(what: &str, source: &str) {
    with_memory(|mem| {
        mem.corrections.push(Correction {
            timestamp: now_secs(),
            what: what.to_string(),
            source: source.to_string(),
        });
        // Keep only the most recent corrections
        if mem.corrections.len() > MAX_CORRECTIONS {
            mem.corrections.drain(..mem.corrections.len() - MAX_CORRECTIONS);
        }
    });
}

/// Get recent corrections for prompt injection (last 10, newest first)
pub fn get_recent_corrections() -> Vec<String> {
    with_memory(|mem| {
        mem.corrections
            .iter()
            .rev()
            .take(10)
            .map(|c| c.what.clone())
            .collect()
    })
}

// ── Watch/alert helpers ──────────────────────────────────────────────────────

const MAX_WATCHES: usize = 20;

pub fn add_watch(
    description: &str,
    condition_type: &str,
    keywords: Vec<String>,
    source: &str,
    message_template: &str,
    cooldown_secs: u64,
) -> String {
    let id = format!("w_{}", now_secs());
    with_memory(|mem| {
        mem.active_watches.push(WatchAlert {
            id: id.clone(),
            description: description.to_string(),
            condition_type: condition_type.to_string(),
            keywords: keywords.iter().map(|k| k.to_lowercase()).collect(),
            source: source.to_string(),
            message_template: message_template.to_string(),
            created_at: now_secs(),
            fire_count: 0,
            cooldown_secs,
            last_fired_at: 0,
            enabled: true,
        });
        if mem.active_watches.len() > MAX_WATCHES {
            mem.active_watches.remove(0);
        }
    });
    id
}

pub fn remove_watch(id: &str) -> bool {
    with_memory(|mem| {
        let before = mem.active_watches.len();
        mem.active_watches.retain(|w| w.id != id);
        mem.active_watches.len() < before
    })
}

pub fn list_watches() -> Vec<WatchAlert> {
    with_memory(|mem| mem.active_watches.clone())
}

pub fn clear_watches() {
    with_memory(|mem| mem.active_watches.clear());
}

/// Check text against active keyword-type watches that are not in cooldown.
/// Returns list of (watch_id, description, message_template) for matches.
pub fn check_watches_keyword(text: &str, source: &str) -> Vec<(String, String, String)> {
    let lower = text.to_lowercase();
    let now = now_secs();
    with_memory(|mem| {
        let mut matches = Vec::new();
        for watch in &mut mem.active_watches {
            if !watch.enabled {
                continue;
            }
            if watch.source != "both" && watch.source != source {
                continue;
            }
            if watch.condition_type != "keyword" || watch.keywords.is_empty() {
                continue;
            }
            if watch.last_fired_at > 0 && now - watch.last_fired_at < watch.cooldown_secs {
                continue;
            }
            let hit = watch.keywords.iter().any(|kw| lower.contains(kw));
            if hit {
                watch.fire_count += 1;
                watch.last_fired_at = now;
                matches.push((watch.id.clone(), watch.description.clone(), watch.message_template.clone()));
            }
        }
        matches
    })
}

/// Get classifier-type watches that are eligible to fire (not in cooldown).
pub fn get_classifier_watches(source: &str) -> Vec<WatchAlert> {
    let now = now_secs();
    with_memory(|mem| {
        mem.active_watches
            .iter()
            .filter(|w| {
                w.enabled
                    && w.condition_type == "classifier"
                    && (w.source == "both" || w.source == source)
                    && (w.last_fired_at == 0 || now - w.last_fired_at >= w.cooldown_secs)
            })
            .cloned()
            .collect()
    })
}

/// Mark a watch as having just fired (updates last_fired_at and fire_count).
pub fn mark_watch_fired(id: &str) {
    with_memory(|mem| {
        if let Some(w) = mem.active_watches.iter_mut().find(|w| w.id == id) {
            w.fire_count += 1;
            w.last_fired_at = now_secs();
        }
    });
}

/// Get active watches formatted for LLM context injection.
pub fn get_watches_context() -> Option<String> {
    let watches = list_watches();
    let enabled: Vec<&WatchAlert> = watches.iter().filter(|w| w.enabled).collect();
    if enabled.is_empty() {
        return None;
    }
    let lines: Vec<String> = enabled
        .iter()
        .map(|w| {
            let cond = if w.condition_type == "keyword" {
                format!("keywords: {}", w.keywords.join(", "))
            } else {
                "classifier (LLM judgment)".to_string()
            };
            format!(
                "- [{}] {} ({}, source: {}, cooldown: {}s, fired: {}x)",
                w.id, w.description, cond, w.source, w.cooldown_secs, w.fire_count
            )
        })
        .collect();
    Some(format!("Active watches:\n{}", lines.join("\n")))
}

#[tauri::command]
pub async fn watch_add(
    description: String,
    condition_type: String,
    keywords: Vec<String>,
    source: String,
    message_template: String,
    cooldown_secs: u64,
) -> Result<String, String> {
    let id = add_watch(&description, &condition_type, keywords, &source, &message_template, cooldown_secs);
    eprintln!("[watch] added trigger: {id} — {description} (type={condition_type}, cooldown={cooldown_secs}s)");
    Ok(id)
}

#[tauri::command]
pub async fn watch_remove(id: String) -> Result<bool, String> {
    let removed = remove_watch(&id);
    eprintln!("[watch] removed {id}: {removed}");
    Ok(removed)
}

#[tauri::command]
pub async fn watch_list() -> Result<Vec<WatchAlert>, String> {
    Ok(list_watches())
}

#[tauri::command]
pub async fn watch_clear() -> Result<(), String> {
    clear_watches();
    eprintln!("[watch] cleared all watches");
    Ok(())
}

/// Keyword-check text against active keyword-type watches.
/// Returns matched (id, description, message_template) for each hit.
#[tauri::command]
pub async fn watch_check(text: String, source: String) -> Result<Vec<WatchCheckMatch>, String> {
    let matches = check_watches_keyword(&text, &source);
    Ok(matches
        .into_iter()
        .map(|(id, desc, template)| WatchCheckMatch { id, description: desc, message_template: template })
        .collect())
}

/// A single keyword-match result returned to the frontend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WatchCheckMatch {
    pub id: String,
    pub description: String,
    pub message_template: String,
}

/// Get classifier-type watches eligible to fire for this source.
#[tauri::command]
pub async fn watch_get_classifier(source: String) -> Result<Vec<WatchAlert>, String> {
    Ok(get_classifier_watches(&source))
}

/// Mark a watch as fired (called after successful synthetic turn injection).
#[tauri::command]
pub async fn watch_mark_fired(id: String) -> Result<(), String> {
    mark_watch_fired(&id);
    eprintln!("[watch] trigger fired: {id}");
    Ok(())
}

#[tauri::command]
pub async fn memory_clear() -> Result<(), String> {
    let path = memory_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete memory: {e}"))?;
    }
    let mut lock = MEMORY.lock().unwrap();
    *lock = Some(SamuelMemory::default());
    eprintln!("[memory] cleared all data");
    Ok(())
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

#[tauri::command]
pub async fn memory_mark_known(words: Vec<String>) -> Result<(), String> {
    eprintln!("[memory] marking as permanently known: {}", words.join(", "));
    mark_known(&words);
    Ok(())
}

#[tauri::command]
pub async fn memory_add_correction(what: String, source: String) -> Result<(), String> {
    eprintln!("[memory] correction from {source}: {what}");
    add_correction(&what, &source);
    Ok(())
}

/// Post-session feedback extraction: analyzes a conversation transcript
/// and extracts any implicit corrections/preferences the user gave.
#[tauri::command]
pub async fn extract_session_feedback(transcript: String) -> Result<Vec<String>, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    let prompt = format!(
        r#"Analyze this conversation between a user and their AI assistant "Samuel".
Extract any feedback, corrections, or behavioral preferences the user expressed.

Look for:
- Explicit corrections: "that's wrong", "no, it means...", "don't explain it that way"
- Behavioral feedback: "be more concise", "speak slower", "stop doing X"
- Implicit preferences: user seems frustrated by length, user cuts off Samuel, user repeats themselves

Return a JSON array of strings, each being one actionable correction.
If no feedback found, return an empty array [].
Return ONLY valid JSON, no markdown fences.

Transcript:
{transcript}"#
    );

    let body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1000
    });

    let body_str = serde_json::to_string(&body)
        .map_err(|e| format!("JSON: {e}"))?;

    std::fs::write("/tmp/samuel-feedback-req.json", &body_str).ok();

    let output = std::process::Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "30",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", "@/tmp/samuel-feedback-req.json",
        ])
        .output()
        .map_err(|e| format!("curl failed: {e}"))?;

    let resp_str = String::from_utf8_lossy(&output.stdout).to_string();
    let resp: serde_json::Value = serde_json::from_str(&resp_str)
        .map_err(|e| format!("Parse: {e}"))?;

    let content = resp["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("[]");

    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let corrections: Vec<String> = serde_json::from_str(cleaned).unwrap_or_default();

    // Store each correction
    for c in &corrections {
        add_correction(c, "voice");
        eprintln!("[memory] extracted correction: {c}");
    }

    Ok(corrections)
}
