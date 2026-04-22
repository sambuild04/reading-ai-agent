use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read as _;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use crate::commands::read_config_internal;

/// Run a command with a hard timeout — kills the process if it exceeds `timeout_secs`.
/// Drains stdout/stderr in background threads to prevent pipe buffer deadlocks.
fn run_with_timeout(cmd: &mut Command, timeout_secs: u64) -> Result<Output, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;

    // Drain pipes in background threads so yt-dlp doesn't block on a full buffer
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);

    // Poll until exit or timeout
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() > deadline {
                    eprintln!("[teach] killing process after {timeout_secs}s timeout");
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Timed out after {timeout_secs}s"));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(e) => return Err(format!("try_wait: {e}")),
        }
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();

    Ok(Output { status, stdout, stderr })
}

// ── Unified content types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentLine {
    pub text: String,
    pub timestamp: Option<f64>,
    pub source_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocabAnnotation {
    pub word: String,
    pub reading: Option<String>,
    pub meaning: String,
    pub line_index: usize,
    pub level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrammarAnnotation {
    pub pattern: String,
    pub explanation: String,
    pub example: Option<String>,
    pub line_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotatedContent {
    pub content_type: String,
    pub title: Option<String>,
    pub lines: Vec<ContentLine>,
    pub vocabulary: Vec<VocabAnnotation>,
    pub grammar: Vec<GrammarAnnotation>,
    pub summary: Option<String>,
    /// Local path to downloaded audio (YouTube songs only, kept for playback)
    pub audio_file: Option<String>,
}

// ── Input classification ─────────────────────────────────────────────────────

fn classify_input(input: &str) -> &'static str {
    let trimmed = input.trim();

    if trimmed.contains("youtube.com/watch") || trimmed.contains("youtu.be/") {
        return "youtube";
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return "article";
    }
    // Base64 image data or file path to image
    if trimmed.starts_with("data:image/")
        || trimmed.ends_with(".png")
        || trimmed.ends_with(".jpg")
        || trimmed.ends_with(".jpeg")
        || trimmed.ends_with(".webp")
    {
        return "image";
    }
    if trimmed.ends_with(".pdf") {
        return "pdf";
    }
    "raw_text"
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn find_yt_dlp() -> Result<String, String> {
    // Tauri apps inherit a minimal PATH — check common install locations
    let candidates = [
        "yt-dlp",
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
    ];
    for path in &candidates {
        if Command::new(path)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return Ok(path.to_string());
        }
    }
    Err("yt-dlp not found — install with `brew install yt-dlp`".to_string())
}

/// Download audio from YouTube for playback (best-effort, returns None on failure).
fn download_youtube_audio(yt_dlp: &str, url: &str) -> Option<String> {
    let audio_file = "/tmp/samuel-teach-audio.m4a".to_string();
    let _ = fs::remove_file(&audio_file);
    let clean_url = strip_playlist_params(url);
    eprintln!("[teach] youtube: downloading audio for playback...");
    match run_with_timeout(
        Command::new(yt_dlp).args([
            "-x", "--audio-format", "m4a",
            "--audio-quality", "5",
            "--no-playlist",
            "--socket-timeout", "15",
            "--no-warnings",
            "-o", &audio_file,
            &clean_url,
        ]),
        90,
    ) {
        Ok(dl) if dl.status.success() => {
            let sz = fs::metadata(&audio_file).map(|m| m.len()).unwrap_or(0);
            eprintln!("[teach] youtube: audio downloaded for playback ({sz} bytes)");
            Some(audio_file)
        }
        _ => {
            eprintln!("[teach] youtube: audio download for playback failed (non-fatal)");
            None
        }
    }
}

/// Try to fetch lyrics from LRCLIB using the video title.
/// Returns parsed lines if found, None otherwise. Non-blocking fallback.
fn try_lrclib_lyrics(title: &str) -> Option<Vec<ContentLine>> {
    // Clean the title: strip common YouTube noise
    let clean = title
        .replace("【", " ").replace("】", " ")
        .replace("「", " ").replace("」", " ")
        .replace("（", " ").replace("）", " ");
    // Take a reasonable search query from the title
    let query: String = clean.split_whitespace().take(6).collect::<Vec<_>>().join(" ");
    if query.len() < 3 { return None; }

    eprintln!("[teach] trying LRCLIB search: {query}");
    let url = format!(
        "https://lrclib.net/api/search?q={}",
        crate::commands::urlencoding_str(&query)
    );

    let output = Command::new("/usr/bin/curl")
        .args(["-s", "--max-time", "5", "-L", &url])
        .output()
        .ok()?;

    if !output.status.success() { return None; }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let results = json.as_array()?;
    if results.is_empty() { return None; }

    // Prefer synced lyrics, fall back to plain
    let best = &results[0];
    if let Some(synced) = best["syncedLyrics"].as_str() {
        let lines = parse_lrc_synced(synced);
        if !lines.is_empty() {
            eprintln!("[teach] LRCLIB: found synced lyrics ({} lines)", lines.len());
            return Some(lines);
        }
    }
    if let Some(plain) = best["plainLyrics"].as_str() {
        let lines: Vec<ContentLine> = plain.lines()
            .filter(|l| !l.trim().is_empty())
            .enumerate()
            .map(|(i, l)| ContentLine { text: l.trim().to_string(), timestamp: None, source_index: i })
            .collect();
        if !lines.is_empty() {
            eprintln!("[teach] LRCLIB: found plain lyrics ({} lines)", lines.len());
            return Some(lines);
        }
    }

    None
}

/// Parse LRC synced format: [mm:ss.xx] text
fn parse_lrc_synced(lrc: &str) -> Vec<ContentLine> {
    let mut lines = Vec::new();
    let mut idx = 0;
    for raw in lrc.lines() {
        // Match [01:23.45] or [1:23.456]
        let text_start = match raw.find(']') {
            Some(p) => p + 1,
            None => continue,
        };
        let ts_str = &raw[1..text_start - 1];
        let text = raw[text_start..].trim();
        if text.is_empty() { continue; }

        let timestamp = parse_lrc_timestamp(ts_str);
        lines.push(ContentLine { text: text.to_string(), timestamp, source_index: idx });
        idx += 1;
    }
    lines
}

fn parse_lrc_timestamp(ts: &str) -> Option<f64> {
    let parts: Vec<&str> = ts.split(':').collect();
    if parts.len() == 2 {
        let mins: f64 = parts[0].parse().ok()?;
        let secs: f64 = parts[1].parse().ok()?;
        Some(mins * 60.0 + secs)
    } else {
        None
    }
}

/// Strip playlist/index params from a YouTube URL so yt-dlp fetches only the single video.
fn strip_playlist_params(url: &str) -> String {
    if let Some(q) = url.find('?') {
        let base = &url[..q];
        let params: Vec<&str> = url[q + 1..]
            .split('&')
            .filter(|p| {
                let key = p.split('=').next().unwrap_or("");
                key != "list" && key != "index" && key != "start_radio"
            })
            .collect();
        if params.is_empty() {
            base.to_string()
        } else {
            format!("{}?{}", base, params.join("&"))
        }
    } else {
        url.to_string()
    }
}

// ── Extractors ───────────────────────────────────────────────────────────────

/// Returns (lines, title, audio_path_if_downloaded)
fn extract_youtube(url: &str) -> Result<(Vec<ContentLine>, String, Option<String>), String> {
    let yt_dlp = find_yt_dlp()?;
    eprintln!("[teach] youtube: using {yt_dlp}, fetching subtitles for {url}");

    // Clean up previous files
    let _ = fs::remove_file("/tmp/samuel-teach-subs.ja.vtt");
    let _ = fs::remove_file("/tmp/samuel-teach-subs.ja-orig.vtt");
    let _ = fs::remove_file("/tmp/samuel-teach-subs.en.vtt");

    // Strip playlist params to avoid yt-dlp getting stuck resolving playlist metadata
    let clean_url = strip_playlist_params(url);

    let sub_output = run_with_timeout(
        Command::new(&yt_dlp).args([
            "--skip-download",
            "--no-playlist",
            "--write-auto-subs",
            "--sub-lang", "ja,en,ja-*",
            "--sub-format", "vtt",
            "--print", "title",
            "--socket-timeout", "15",
            "--no-warnings",
            "-o", "/tmp/samuel-teach-subs",
            &clean_url,
        ]),
        45,
    )
    .map_err(|e| format!("yt-dlp subtitle fetch failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&sub_output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&sub_output.stderr).to_string();
    eprintln!("[teach] youtube: yt-dlp subs exit={} stdout_len={} stderr_len={}", sub_output.status, stdout.len(), stderr.len());
    if !stderr.is_empty() {
        eprintln!("[teach] youtube: stderr: {}", &stderr[..stderr.len().min(300)]);
    }

    let title = stdout.lines().last().unwrap_or("").trim().to_string();

    // yt-dlp writes subs with various suffixes — scan /tmp for matches
    let sub_patterns = [
        "/tmp/samuel-teach-subs.ja.vtt",
        "/tmp/samuel-teach-subs.ja-orig.vtt",
        "/tmp/samuel-teach-subs.en.vtt",
    ];

    for path in &sub_patterns {
        if let Ok(vtt) = fs::read_to_string(path) {
            eprintln!("[teach] youtube: found subtitle file {path} ({} bytes)", vtt.len());
            let vtt_lines = parse_vtt(&vtt);
            for p in &sub_patterns {
                let _ = fs::remove_file(p);
            }
            if !vtt_lines.is_empty() {
                eprintln!("[teach] youtube: parsed {} subtitle lines from VTT", vtt_lines.len());

                // Auto-subs are often inaccurate for songs — try LRCLIB as a better source
                let lines = match try_lrclib_lyrics(&title) {
                    Some(better) => {
                        eprintln!("[teach] youtube: using LRCLIB lyrics ({} lines) instead of auto-subs", better.len());
                        better
                    }
                    None => vtt_lines,
                };

                let audio_path = download_youtube_audio(&yt_dlp, url);
                return Ok((lines, title, audio_path));
            }
        }
    }

    // No subs found — cleanup and fall back to audio transcription
    for p in &sub_patterns {
        let _ = fs::remove_file(p);
    }

    eprintln!("[teach] youtube: no subtitles found, downloading audio for transcription");
    let audio_file = "/tmp/samuel-teach-audio.m4a".to_string();
    let _ = fs::remove_file(&audio_file);

    let dl = run_with_timeout(
        Command::new(&yt_dlp).args([
            "-x", "--audio-format", "m4a",
            "--audio-quality", "5",
            "--socket-timeout", "15",
            "--no-warnings",
            "-o", &audio_file,
            url,
        ]),
        90,
    )
    .map_err(|e| format!("yt-dlp audio download failed: {e}"))?;

    if !dl.status.success() {
        let err = String::from_utf8_lossy(&dl.stderr);
        eprintln!("[teach] youtube: audio download failed: {}", &err[..err.len().min(300)]);
        return Err(format!("yt-dlp download error: {err}"));
    }

    let file_size = fs::metadata(&audio_file).map(|m| m.len()).unwrap_or(0);
    eprintln!("[teach] youtube: audio downloaded ({file_size} bytes)");

    // Try LRCLIB first — human-transcribed lyrics are far more accurate than Whisper for songs
    if let Some(lrc_lines) = try_lrclib_lyrics(&title) {
        eprintln!("[teach] youtube: using LRCLIB lyrics ({} lines) instead of Whisper", lrc_lines.len());
        return Ok((lrc_lines, title, Some(audio_file)));
    }

    eprintln!("[teach] youtube: no LRCLIB lyrics, transcribing with Whisper...");
    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;
    let lines = transcribe_file_segmented(&audio_file, &api_key, "ja")?;
    eprintln!("[teach] youtube: transcription done ({} segments)", lines.len());

    Ok((lines, title, Some(audio_file)))
}

fn parse_vtt(vtt: &str) -> Vec<ContentLine> {
    let mut lines = Vec::new();
    let mut idx = 0;

    for block in vtt.split("\n\n") {
        let parts: Vec<&str> = block.trim().lines().collect();
        if parts.len() < 2 {
            continue;
        }

        // Find timestamp line (contains "-->")
        let ts_line = parts.iter().find(|l| l.contains("-->"));
        if ts_line.is_none() {
            continue;
        }

        let timestamp = parse_vtt_timestamp(ts_line.unwrap());

        // Text is everything after the timestamp line
        let ts_idx = parts.iter().position(|l| l.contains("-->")).unwrap();
        let text: String = parts[ts_idx + 1..]
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !l.starts_with("WEBVTT") && !l.starts_with("Kind:"))
            // Strip VTT tags like <c>, </c>, <00:01:23.456>
            .map(|l| {
                let mut s = l.to_string();
                while let Some(start) = s.find('<') {
                    if let Some(end) = s[start..].find('>') {
                        s = format!("{}{}", &s[..start], &s[start + end + 1..]);
                    } else {
                        break;
                    }
                }
                s
            })
            .collect::<Vec<_>>()
            .join(" ");

        if text.trim().is_empty() {
            continue;
        }

        // Deduplicate consecutive identical lines
        if let Some(last) = lines.last() {
            let last: &ContentLine = last;
            if last.text == text.trim() {
                continue;
            }
        }

        lines.push(ContentLine {
            text: text.trim().to_string(),
            timestamp,
            source_index: idx,
        });
        idx += 1;
    }

    lines
}

fn parse_vtt_timestamp(line: &str) -> Option<f64> {
    // "00:01:23.456 --> 00:01:25.789"
    let start = line.split("-->").next()?.trim();
    let parts: Vec<&str> = start.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let s: f64 = parts[2].parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    } else if parts.len() == 2 {
        let m: f64 = parts[0].parse().ok()?;
        let s: f64 = parts[1].parse().ok()?;
        Some(m * 60.0 + s)
    } else {
        None
    }
}

fn extract_article(url: &str) -> Result<(Vec<ContentLine>, String), String> {
    // Use curl + simple HTML extraction
    let output = Command::new("/usr/bin/curl")
        .args(["-s", "--max-time", "15", "-L", url])
        .output()
        .map_err(|e| format!("curl failed: {e}"))?;

    if !output.status.success() {
        return Err("Failed to fetch article".to_string());
    }

    let html = String::from_utf8_lossy(&output.stdout).to_string();

    // Extract title
    let title = extract_html_tag(&html, "title")
        .unwrap_or_else(|| url.to_string());

    // Use GPT to extract readable content from HTML
    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    let truncated_html = if html.len() > 30_000 {
        &html[..30_000]
    } else {
        &html
    };

    let prompt = format!(
        "Extract the main article text from this HTML. Return ONLY the readable content text, \
         preserving paragraph breaks as blank lines. Strip all HTML tags, navigation, ads, \
         and boilerplate. Keep the original language intact (do NOT translate).\n\n{}",
        truncated_html
    );

    let text = call_gpt4o_mini(&api_key, &prompt)?;

    let lines: Vec<ContentLine> = text
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| ContentLine {
            text: l.trim().to_string(),
            timestamp: None,
            source_index: i,
        })
        .collect();

    Ok((lines, title))
}

pub fn extract_html_tag(html: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let start = html.find(&open)?;
    let content_start = html[start..].find('>')? + start + 1;
    let end = html[content_start..].find(&close)? + content_start;
    Some(html[content_start..end].trim().to_string())
}

fn extract_image(input: &str) -> Result<(Vec<ContentLine>, String), String> {
    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    let b64 = if input.starts_with("data:image/") {
        // Already base64
        input.split(',').nth(1).unwrap_or(input).to_string()
    } else {
        // File path — read and encode
        let bytes = fs::read(input).map_err(|e| format!("Read image: {e}"))?;
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
    };

    let request_body = serde_json::json!({
        "model": "gpt-4o",
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "OCR this image. Extract ALL text you can see, preserving the reading order. \
                             For manga/comics, read right-to-left, top-to-bottom. \
                             Output each speech bubble or text block on its own line. \
                             Return ONLY the extracted text, nothing else."
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:image/jpeg;base64,{b64}"),
                        "detail": "high"
                    }
                }
            ]
        }],
        "max_tokens": 4000
    });

    let body_str = serde_json::to_string(&request_body).map_err(|e| format!("JSON: {e}"))?;
    let resp = call_openai_chat(&api_key, &body_str)?;

    let lines: Vec<ContentLine> = resp
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| ContentLine {
            text: l.trim().to_string(),
            timestamp: None,
            source_index: i,
        })
        .collect();

    Ok((lines, "Image".to_string()))
}

fn extract_pdf(path: &str) -> Result<(Vec<ContentLine>, String), String> {
    // Try pdftotext first
    let output = Command::new("pdftotext")
        .args([path, "-"])
        .output()
        .map_err(|_| {
            "pdftotext not found — install with `brew install poppler`".to_string()
        })?;

    if !output.status.success() {
        return Err("pdftotext failed".to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let filename = std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "PDF".to_string());

    let lines: Vec<ContentLine> = text
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| ContentLine {
            text: l.trim().to_string(),
            timestamp: None,
            source_index: i,
        })
        .collect();

    Ok((lines, filename))
}

fn extract_raw_text(text: &str) -> (Vec<ContentLine>, String) {
    let lines: Vec<ContentLine> = text
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| ContentLine {
            text: l.trim().to_string(),
            timestamp: None,
            source_index: i,
        })
        .collect();

    let title = lines
        .first()
        .map(|l| {
            if l.text.len() > 40 {
                format!("{}…", &l.text[..40])
            } else {
                l.text.clone()
            }
        })
        .unwrap_or_else(|| "Text".to_string());

    (lines, title)
}

// ── Annotation via GPT-4o-mini ───────────────────────────────────────────────

fn annotate_content(
    lines: &[ContentLine],
    language: &str,
    api_key: &str,
) -> Result<(Vec<VocabAnnotation>, Vec<GrammarAnnotation>, String), String> {
    // Build numbered text for context
    let numbered: String = lines
        .iter()
        .enumerate()
        .map(|(i, l)| format!("[{}] {}", i, l.text))
        .collect::<Vec<_>>()
        .join("\n");

    // Truncate if too long (keep under ~12k chars for mini)
    let text_for_prompt = if numbered.len() > 12_000 {
        format!("{}...\n[TRUNCATED]", &numbered[..12_000])
    } else {
        numbered
    };

    let lang_label = if language.is_empty() { "foreign language" } else { language };
    let prompt = format!(
        r#"You are a {lang_label} language teaching assistant. Analyze this text and return a JSON object with:

1. "vocabulary": array of the most useful/interesting words to learn. Each entry:
   {{"word": "...", "reading": "...", "meaning": "...", "line_index": N, "level": "N5/N4/N3/N2/N1/..."}}
   - For Japanese: include furigana reading. For Chinese: include pinyin. For Korean: include romanization.
   - Pick 10-20 words max, prioritize words a learner would benefit from most.
   - line_index = the [N] number of the line where this word appears.
   - IMPORTANT: The source text may come from auto-generated subtitles or speech recognition,
     which can contain errors (wrong kanji, garbled words, incorrect word boundaries).
     Use the correct/standard form of each word in your annotations, not the transcription error.

2. "grammar": array of notable grammar patterns. Each entry:
   {{"pattern": "...", "explanation": "...", "example": "...", "line_index": N}}
   - Pick 3-8 patterns max.

3. "summary": a 1-2 sentence summary of what this text is about.

Text:
{text_for_prompt}

Return ONLY valid JSON, no markdown fences."#
    );

    let resp = call_gpt4o_mini(api_key, &prompt)?;

    // Parse JSON — be lenient about markdown fences
    let cleaned = resp
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value = serde_json::from_str(cleaned)
        .map_err(|e| format!("Annotation parse error: {e}\nRaw: {cleaned}"))?;

    let vocabulary: Vec<VocabAnnotation> = parsed
        .get("vocabulary")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let grammar: Vec<GrammarAnnotation> = parsed
        .get("grammar")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let summary = parsed
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok((vocabulary, grammar, summary))
}

// ── API helpers ──────────────────────────────────────────────────────────────

fn call_gpt4o_mini(api_key: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 4000
    });

    let body_str = serde_json::to_string(&body).map_err(|e| format!("JSON: {e}"))?;
    call_openai_chat(api_key, &body_str)
}

fn call_openai_chat(api_key: &str, body: &str) -> Result<String, String> {
    fs::write("/tmp/samuel-teach-req.json", body).ok();

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "60",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &format!("@/tmp/samuel-teach-req.json"),
        ])
        .output()
        .map_err(|e| format!("OpenAI call failed: {e}"))?;

    let resp_str = String::from_utf8_lossy(&output.stdout).to_string();
    let resp: serde_json::Value = serde_json::from_str(&resp_str)
        .map_err(|e| format!("Parse response: {e}"))?;

    if let Some(err) = resp.get("error") {
        return Err(format!("OpenAI error: {err}"));
    }

    resp["choices"][0]["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("No content in response: {resp_str}"))
}

fn transcribe_file(path: &str, api_key: &str, lang: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "120",
            "-X", "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-F", &format!("file=@{path}"),
            "-F", "model=gpt-4o-mini-transcribe",
            "-F", &format!("language={lang}"),
        ])
        .output()
        .map_err(|e| format!("Whisper call failed: {e}"))?;

    let resp_str = String::from_utf8_lossy(&output.stdout).to_string();
    let resp: serde_json::Value = serde_json::from_str(&resp_str)
        .map_err(|e| format!("Parse transcription: {e}"))?;

    resp["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("No text in transcription: {resp_str}"))
}

/// Transcribe with verbose_json to get timestamped segments (for songs).
/// Uses whisper-1 because gpt-4o-mini-transcribe doesn't return segments.
fn transcribe_file_segmented(path: &str, api_key: &str, lang: &str) -> Result<Vec<ContentLine>, String> {
    eprintln!("[teach] running segmented transcription...");
    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "120",
            "-X", "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-F", &format!("file=@{path}"),
            "-F", "model=whisper-1",
            "-F", &format!("language={lang}"),
            "-F", "response_format=verbose_json",
            "-F", "prompt=Transcribe the song lyrics accurately. This is a Japanese song. Pay close attention to each word and phrase.",
        ])
        .output()
        .map_err(|e| {
            eprintln!("[teach] segmented transcription curl failed: {e}");
            format!("Whisper segmented call failed: {e}")
        })?;

    let resp_str = String::from_utf8_lossy(&output.stdout).to_string();
    eprintln!("[teach] segmented transcription response: {} bytes", resp_str.len());

    let resp: serde_json::Value = serde_json::from_str(&resp_str)
        .map_err(|e| {
            eprintln!("[teach] segmented transcription parse error: {e}");
            eprintln!("[teach] raw response: {}", &resp_str[..resp_str.len().min(500)]);
            format!("Parse segmented transcription: {e}")
        })?;

    if let Some(err) = resp.get("error") {
        eprintln!("[teach] whisper error: {err}");
        return Err(format!("Whisper error: {err}"));
    }

    let segments = resp["segments"]
        .as_array()
        .ok_or_else(|| {
            eprintln!("[teach] no segments in response, keys: {:?}",
                resp.as_object().map(|o| o.keys().collect::<Vec<_>>()));
            format!("No segments in response")
        })?;

    let mut lines = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        let text = seg["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() { continue; }

        let start = seg["start"].as_f64();
        lines.push(ContentLine {
            text,
            timestamp: start,
            source_index: i,
        });
    }

    eprintln!("[teach] segmented transcription: {} segments", lines.len());
    Ok(lines)
}

// ── Main Tauri commands ──────────────────────────────────────────────────────

/// Read an audio file from disk and return it as base64 (for frontend playback via blob URL).
#[tauri::command]
pub fn read_audio_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read audio: {e}"))?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &bytes,
    ))
}

/// Download audio from a YouTube URL for playback. Returns the local file path.
#[tauri::command]
pub async fn download_song_audio(url: String) -> Result<String, String> {
    let yt_dlp = find_yt_dlp()?;
    download_youtube_audio(&yt_dlp, &url)
        .ok_or_else(|| "Failed to download audio".to_string())
}

/// Annotate pre-fetched content (lyrics from LRCLIB, etc.) — no extraction step.
#[tauri::command]
pub async fn annotate_lines(
    lines: Vec<ContentLine>,
    content_type: String,
    title: String,
    language: Option<String>,
) -> Result<AnnotatedContent, String> {
    let lang = language.unwrap_or_default();

    if lines.is_empty() {
        return Err("No content to annotate.".to_string());
    }

    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    eprintln!("[teach] annotating {} pre-fetched lines...", lines.len());
    let (vocabulary, grammar, summary) = annotate_content(&lines, &lang, &api_key)?;
    eprintln!("[teach] done: {} vocab, {} grammar", vocabulary.len(), grammar.len());

    Ok(AnnotatedContent {
        content_type,
        title: Some(title),
        lines,
        vocabulary,
        grammar,
        summary: Some(summary),
        audio_file: None,
    })
}

/// Full extraction + annotation for non-YouTube content (articles, images, PDFs, raw text).
#[tauri::command]
pub async fn teach_from_content(
    input: String,
    language: Option<String>,
) -> Result<AnnotatedContent, String> {
    let lang = language.unwrap_or_default();
    let content_type = classify_input(&input);

    eprintln!("[teach] classified input as: {content_type}");

    let (lines, title, audio_file) = match content_type {
        "youtube" => extract_youtube(&input)?,
        "article" => { let (l, t) = extract_article(&input)?; (l, t, None) }
        "image" => { let (l, t) = extract_image(&input)?; (l, t, None) }
        "pdf" => { let (l, t) = extract_pdf(&input)?; (l, t, None) }
        _ => { let (l, t) = extract_raw_text(&input); (l, t, None) }
    };

    eprintln!("[teach] extracted {} lines, title: {:?}", lines.len(), &title);

    if lines.is_empty() {
        return Err("No content could be extracted.".to_string());
    }

    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    eprintln!("[teach] annotating {} lines...", lines.len());
    let (vocabulary, grammar, summary) = annotate_content(&lines, &lang, &api_key)?;
    eprintln!("[teach] done: {} vocab, {} grammar", vocabulary.len(), grammar.len());

    Ok(AnnotatedContent {
        content_type: content_type.to_string(),
        title: Some(title),
        lines,
        vocabulary,
        grammar,
        summary: Some(summary),
        audio_file,
    })
}
