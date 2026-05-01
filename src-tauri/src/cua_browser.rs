//! Isolated CUA browser sidecar management.
//!
//! Spawns `browser-cua-agent.ts` which runs Chrome in its own profile,
//! separate from the user's real Chrome. This ensures computer_use never
//! steals the user's cursor or disrupts their active tabs.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};

struct CuaBrowserAgent {
    stdin_tx: mpsc::Sender<String>,
    response_rx: Arc<Mutex<mpsc::Receiver<(String, bool, serde_json::Value)>>>,
    _child_pid: u32,
}

static CUA_AGENT: Mutex<Option<CuaBrowserAgent>> = Mutex::new(None);

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserResult {
    pub ok: bool,
    pub data: serde_json::Value,
}

fn ensure_running() -> Result<(), String> {
    let mut guard = CUA_AGENT.lock().map_err(|e| format!("Lock: {e}"))?;
    if guard.is_some() {
        return Ok(());
    }

    eprintln!("[cua-browser] spawning isolated browser-cua-agent...");

    let project_root = std::env::current_dir()
        .map(|d| {
            if d.ends_with("src-tauri") {
                d.parent().unwrap_or(&d).to_path_buf()
            } else {
                d
            }
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let mut child = Command::new("npx")
        .args(["tsx", "src/lib/browser-cua-agent.ts"])
        .current_dir(&project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn CUA browser: {e}"))?;

    let pid = child.id();

    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    let (stdin_tx, stdin_rx) = mpsc::channel::<String>();
    let (resp_tx, resp_rx) = mpsc::channel::<(String, bool, serde_json::Value)>();
    let resp_rx = Arc::new(Mutex::new(resp_rx));

    // Stdin writer thread
    std::thread::spawn(move || {
        for line in stdin_rx {
            if writeln!(stdin, "{}", line).is_err() {
                break;
            }
            if stdin.flush().is_err() {
                break;
            }
        }
    });

    // Stdout reader thread
    let resp_tx_clone = resp_tx.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(resp) = serde_json::from_str::<serde_json::Value>(&line) {
                let id = resp.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                let data = resp.get("data").cloned().unwrap_or(serde_json::Value::Null);
                if resp_tx_clone.send((id, ok, data)).is_err() {
                    break;
                }
            }
        }
        eprintln!("[cua-browser] stdout reader exited");
    });

    // Stderr logger thread
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                eprintln!("[cua-browser] {}", l);
            }
        }
    });

    // Reap child in background
    std::thread::spawn(move || {
        let _ = child.wait();
        eprintln!("[cua-browser] child process exited");
    });

    // Wait for agent startup
    std::thread::sleep(std::time::Duration::from_millis(2000));

    *guard = Some(CuaBrowserAgent {
        stdin_tx,
        response_rx: resp_rx,
        _child_pid: pid,
    });

    eprintln!("[cua-browser] isolated browser started (pid={})", pid);
    Ok(())
}

/// Send a command to the isolated CUA browser and wait for a response.
pub async fn cua_browser_command(action: String, params: serde_json::Value) -> Result<BrowserResult, String> {
    ensure_running()?;

    let guard = CUA_AGENT.lock().map_err(|e| format!("Lock: {e}"))?;
    let agent = guard.as_ref().ok_or("CUA browser not running")?;

    let id = format!(
        "cua_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    let mut cmd = if let Some(obj) = params.as_object() {
        obj.clone()
    } else {
        serde_json::Map::new()
    };
    cmd.insert("id".into(), serde_json::Value::String(id.clone()));
    cmd.insert("action".into(), serde_json::Value::String(action));

    let cmd_str = serde_json::to_string(&serde_json::Value::Object(cmd))
        .map_err(|e| format!("JSON: {e}"))?;

    agent.stdin_tx.send(cmd_str).map_err(|e| format!("Send: {e}"))?;

    let rx = agent.response_rx.clone();
    drop(guard);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let rx_guard = rx.lock().map_err(|e| format!("RX lock: {e}"))?;

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("CUA browser command timed out after 60s".into());
        }

        match rx_guard.recv_timeout(remaining) {
            Ok((resp_id, ok, data)) => {
                if resp_id == id {
                    return Ok(BrowserResult { ok, data });
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err("CUA browser command timed out after 60s".into());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("CUA browser process exited".into());
            }
        }
    }
}

/// Stop the isolated CUA browser.
pub async fn cua_browser_close() -> Result<(), String> {
    let mut guard = CUA_AGENT.lock().map_err(|e| format!("Lock: {e}"))?;
    if let Some(agent) = guard.take() {
        let _ = agent.stdin_tx.send(r#"{"id":"_close","action":"close"}"#.to_string());
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Ok(())
}
