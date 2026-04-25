use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::Command;

// ── Built-in OAuth credentials ───────────────────────────────────────────
// These are "Desktop app" type OAuth clients. Client IDs for desktop/native
// apps are NOT secret — they're visible in every request URL. PKCE provides
// the security instead of a client secret.
//
// To set up your own: Google Cloud Console → APIs & Services → Credentials
// → Create OAuth 2.0 Client ID → Application type: Desktop app.
// Then replace these constants or override via the user's secrets store.

const BUILTIN_GOOGLE_CLIENT_ID: &str = "REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
const BUILTIN_GITHUB_CLIENT_ID: &str = "REPLACE_WITH_YOUR_GITHUB_CLIENT_ID";
const BUILTIN_SPOTIFY_CLIENT_ID: &str = "REPLACE_WITH_YOUR_SPOTIFY_CLIENT_ID";

struct ProviderConfig {
    auth_url: &'static str,
    token_url: &'static str,
    builtin_client_id: &'static str,
    /// Secret store key users can set to override the built-in client ID
    override_client_id_key: &'static str,
    override_client_secret_key: &'static str,
    /// Whether this provider supports PKCE (most modern ones do)
    supports_pkce: bool,
}

fn known_provider(name: &str) -> Option<ProviderConfig> {
    match name {
        "google" => Some(ProviderConfig {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            builtin_client_id: BUILTIN_GOOGLE_CLIENT_ID,
            override_client_id_key: "GOOGLE_CLIENT_ID",
            override_client_secret_key: "GOOGLE_CLIENT_SECRET",
            supports_pkce: true,
        }),
        "github" => Some(ProviderConfig {
            auth_url: "https://github.com/login/oauth/authorize",
            token_url: "https://github.com/login/oauth/access_token",
            builtin_client_id: BUILTIN_GITHUB_CLIENT_ID,
            override_client_id_key: "GITHUB_CLIENT_ID",
            override_client_secret_key: "GITHUB_CLIENT_SECRET",
            supports_pkce: false,
        }),
        "spotify" => Some(ProviderConfig {
            auth_url: "https://accounts.spotify.com/authorize",
            token_url: "https://accounts.spotify.com/api/token",
            builtin_client_id: BUILTIN_SPOTIFY_CLIENT_ID,
            override_client_id_key: "SPOTIFY_CLIENT_ID",
            override_client_secret_key: "SPOTIFY_CLIENT_SECRET",
            supports_pkce: true,
        }),
        _ => None,
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OAuthResult {
    pub provider: String,
    pub token_key: String,
    pub success: bool,
    pub message: String,
}

/// Generate a cryptographically random code_verifier for PKCE (43-128 chars, URL-safe).
fn generate_code_verifier() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Build entropy from multiple sources
    let mut bytes = Vec::with_capacity(64);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    bytes.extend_from_slice(&nanos.to_le_bytes());
    bytes.extend_from_slice(&std::process::id().to_le_bytes());

    // Hash several times to spread entropy
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut result = String::with_capacity(64);
    for i in 0..64u64 {
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        i.hash(&mut hasher);
        result.push(alphabet[(hasher.finish() % alphabet.len() as u64) as usize] as char);
        bytes.extend_from_slice(&hasher.finish().to_le_bytes());
    }
    result
}

/// Compute S256 code_challenge from verifier: BASE64URL(SHA256(verifier))
/// Uses the system's openssl command since we don't have a sha2 crate.
fn compute_code_challenge(verifier: &str) -> Result<String, String> {
    let out = Command::new("openssl")
        .args(["dgst", "-sha256", "-binary"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(ref mut stdin) = child.stdin {
                std::io::Write::write_all(stdin, verifier.as_bytes()).ok();
            }
            child.wait_with_output()
        })
        .map_err(|e| format!("openssl sha256: {e}"))?;

    if !out.status.success() {
        return Err("SHA256 hash failed".into());
    }

    // Base64url encode (no padding)
    Ok(base64url_encode(&out.stdout))
}

fn base64url_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// Run a full OAuth 2.0 authorization code flow with PKCE:
/// 1. Generate PKCE code_verifier + code_challenge
/// 2. Bind a random localhost port
/// 3. Open the browser to the provider's consent screen (with PKCE params)
/// 4. Wait for the redirect callback with the auth code
/// 5. Exchange the code + code_verifier for tokens
/// 6. Store tokens in secrets
#[tauri::command]
pub async fn oauth_flow(
    provider: String,
    scopes: Option<String>,
    custom_auth_url: Option<String>,
    custom_token_url: Option<String>,
    custom_client_id: Option<String>,
    custom_client_secret: Option<String>,
) -> Result<OAuthResult, String> {
    let provider_lower = provider.to_lowercase();
    eprintln!("[oauth] starting flow for provider: {provider_lower}");

    // Resolve config: user overrides > built-in > custom
    let (auth_url, token_url, client_id, client_secret, use_pkce) =
        if let Some(cfg) = known_provider(&provider_lower) {
            let secrets = crate::secrets::load_secrets();
            let cid = secrets.entries.get(cfg.override_client_id_key)
                .cloned()
                .or(custom_client_id)
                .unwrap_or_else(|| cfg.builtin_client_id.to_string());
            let csec = secrets.entries.get(cfg.override_client_secret_key)
                .cloned()
                .or(custom_client_secret)
                .unwrap_or_default();
            (
                cfg.auth_url.to_string(),
                cfg.token_url.to_string(),
                cid,
                csec,
                cfg.supports_pkce,
            )
        } else {
            let cid = custom_client_id
                .ok_or("Need custom_client_id for unknown provider")?;
            let csec = custom_client_secret.unwrap_or_default();
            let auth = custom_auth_url
                .ok_or("Need custom_auth_url for unknown provider")?;
            let tok = custom_token_url
                .ok_or("Need custom_token_url for unknown provider")?;
            (auth, tok, cid, csec, true)
        };

    if cid_is_placeholder(&client_id) {
        return Err(format!(
            "Built-in client ID not configured for {provider_lower}. \
             The app developer needs to set up OAuth credentials, \
             or you can store your own: store_secret(name=\"{}_CLIENT_ID\", value=\"...\")",
            provider_lower.to_uppercase()
        ));
    }

    // Generate PKCE if supported
    let (code_verifier, code_challenge) = if use_pkce {
        let verifier = generate_code_verifier();
        let challenge = compute_code_challenge(&verifier)?;
        eprintln!("[oauth] using PKCE (S256)");
        (Some(verifier), Some(challenge))
    } else {
        (None, None)
    };

    // Bind to a random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind localhost: {e}"))?;
    let port = listener.local_addr()
        .map_err(|e| format!("Failed to get port: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    eprintln!("[oauth] redirect URI: {redirect_uri}");

    // Build the authorization URL
    let scopes_str = scopes.unwrap_or_default();
    let mut consent_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&access_type=offline&prompt=consent",
        auth_url,
        urlencoding(&client_id),
        urlencoding(&redirect_uri),
        urlencoding(&scopes_str),
    );

    if let Some(ref challenge) = code_challenge {
        consent_url.push_str(&format!(
            "&code_challenge={}&code_challenge_method=S256",
            urlencoding(challenge)
        ));
    }

    // Open the browser
    eprintln!("[oauth] opening browser...");
    Command::new("open")
        .arg(&consent_url)
        .spawn()
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    // Wait for the callback (with 120s timeout)
    let code = wait_for_callback(&listener, 120)?;
    eprintln!("[oauth] received auth code ({} chars)", code.len());

    // Exchange code for tokens (include code_verifier for PKCE)
    let mut token_body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}",
        urlencoding(&code),
        urlencoding(&redirect_uri),
        urlencoding(&client_id),
    );

    if let Some(ref verifier) = code_verifier {
        token_body.push_str(&format!("&code_verifier={}", urlencoding(verifier)));
    }

    if !client_secret.is_empty() {
        token_body.push_str(&format!("&client_secret={}", urlencoding(&client_secret)));
    }

    let tokens = exchange_token(&token_url, &token_body)?;
    store_tokens(&provider_lower, &tokens)?;

    let token_key = format!("{}_ACCESS_TOKEN", provider_lower.to_uppercase());
    eprintln!("[oauth] flow complete for {provider_lower}");

    Ok(OAuthResult {
        provider: provider_lower,
        token_key: token_key.clone(),
        success: true,
        message: format!("Connected to {provider}! Token stored as {token_key}."),
    })
}

/// Refresh an expired OAuth token using the stored refresh token.
#[tauri::command]
pub async fn oauth_refresh(
    provider: String,
    custom_token_url: Option<String>,
    custom_client_id: Option<String>,
    custom_client_secret: Option<String>,
) -> Result<OAuthResult, String> {
    let provider_lower = provider.to_lowercase();
    let token_prefix = provider_lower.to_uppercase();

    let secrets = crate::secrets::load_secrets();

    let refresh_key = format!("{token_prefix}_REFRESH_TOKEN");
    let refresh_token = secrets.entries.get(&refresh_key)
        .ok_or_else(|| format!("No refresh token found ({refresh_key}). Run oauth_flow first."))?
        .clone();

    let (token_url, client_id, client_secret) = if let Some(cfg) = known_provider(&provider_lower) {
        let cid = secrets.entries.get(cfg.override_client_id_key)
            .cloned()
            .or(custom_client_id)
            .unwrap_or_else(|| cfg.builtin_client_id.to_string());
        let csec = secrets.entries.get(cfg.override_client_secret_key)
            .cloned()
            .or(custom_client_secret)
            .unwrap_or_default();
        (cfg.token_url.to_string(), cid, csec)
    } else {
        let cid = custom_client_id.ok_or("Need custom_client_id")?;
        let csec = custom_client_secret.unwrap_or_default();
        let tok = custom_token_url.ok_or("Need custom_token_url")?;
        (tok, cid, csec)
    };

    let mut body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencoding(&refresh_token),
        urlencoding(&client_id),
    );
    if !client_secret.is_empty() {
        body.push_str(&format!("&client_secret={}", urlencoding(&client_secret)));
    }

    let tokens = exchange_token(&token_url, &body)?;
    store_tokens(&provider_lower, &tokens)?;

    let token_key = format!("{token_prefix}_ACCESS_TOKEN");
    eprintln!("[oauth] refreshed token for {provider_lower}");

    Ok(OAuthResult {
        provider: provider_lower,
        token_key: token_key.clone(),
        success: true,
        message: format!("Token refreshed. Stored as {token_key}."),
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn cid_is_placeholder(cid: &str) -> bool {
    cid.starts_with("REPLACE_WITH_")
}

fn wait_for_callback(listener: &TcpListener, timeout_secs: u64) -> Result<String, String> {
    let timeout = std::time::Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();

    loop {
        if start.elapsed() > timeout {
            return Err("OAuth timed out — no callback received. Please try again.".into());
        }

        listener.set_nonblocking(true).ok();
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut reader = BufReader::new(&stream);
                let mut request_line = String::new();
                reader.read_line(&mut request_line)
                    .map_err(|e| format!("Read request: {e}"))?;

                let extracted_code = request_line
                    .split_whitespace()
                    .nth(1)
                    .and_then(|path| {
                        path.split('?').nth(1).and_then(|qs| {
                            qs.split('&').find_map(|pair| {
                                let mut kv = pair.splitn(2, '=');
                                match (kv.next(), kv.next()) {
                                    (Some("code"), Some(v)) => Some(v.to_string()),
                                    _ => None,
                                }
                            })
                        })
                    });

                let html = if extracted_code.is_some() {
                    "<html><body style='font-family:system-ui;text-align:center;padding:60px;\
                     background:#0a0e1e;color:#e2e8f0'>\
                     <h1 style='color:#818cf8'>Connected!</h1>\
                     <p>You can close this tab and return to Samuel.</p></body></html>"
                } else {
                    "<html><body style='font-family:system-ui;text-align:center;padding:60px;\
                     background:#0a0e1e;color:#e2e8f0'>\
                     <h1 style='color:#f87171'>Something went wrong</h1>\
                     <p>No authorization code received. Please try again.</p></body></html>"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(), html
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();

                if let Some(c) = extracted_code {
                    return Ok(c);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(format!("Accept failed: {e}")),
        }
    }
}

fn exchange_token(token_url: &str, body: &str) -> Result<serde_json::Value, String> {
    let out = Command::new("/usr/bin/curl")
        .args([
            "-s", "--max-time", "15",
            "-X", "POST",
            "-H", "Content-Type: application/x-www-form-urlencoded",
            "-H", "Accept: application/json",
            "-d", body,
            token_url,
        ])
        .output()
        .map_err(|e| format!("Token exchange: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Token exchange failed: {stderr}"));
    }

    let resp = String::from_utf8_lossy(&out.stdout);
    let json: serde_json::Value = serde_json::from_str(&resp)
        .map_err(|e| format!("Token parse: {e}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        let desc = json.get("error_description").and_then(|v| v.as_str()).unwrap_or("unknown");
        return Err(format!("OAuth error: {err} — {desc}"));
    }

    Ok(json)
}

fn store_tokens(provider: &str, tokens: &serde_json::Value) -> Result<(), String> {
    let prefix = provider.to_uppercase();
    let mut store = crate::secrets::load_secrets();
    let mut stored = Vec::new();

    if let Some(v) = tokens.get("access_token").and_then(|v| v.as_str()) {
        let key = format!("{prefix}_ACCESS_TOKEN");
        store.entries.insert(key.clone(), v.to_string());
        stored.push(key);
    }
    if let Some(v) = tokens.get("refresh_token").and_then(|v| v.as_str()) {
        let key = format!("{prefix}_REFRESH_TOKEN");
        store.entries.insert(key.clone(), v.to_string());
        stored.push(key);
    }
    if let Some(v) = tokens.get("expires_in").and_then(|v| v.as_u64()) {
        let key = format!("{prefix}_TOKEN_EXPIRES_AT");
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() + v)
            .unwrap_or(0);
        store.entries.insert(key.clone(), at.to_string());
        stored.push(key);
    }

    let path = crate::secrets::secrets_path()?;
    let json = serde_json::to_string_pretty(&store).map_err(|e| format!("JSON: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write: {e}"))?;
    eprintln!("[oauth] stored: {}", stored.join(", "));
    Ok(())
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0x0F) as usize]));
            }
        }
    }
    out
}
