import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import * as secrets from "./secrets.js";

// ── Built-in OAuth credentials ──────────────────────────────────────────
// Desktop/native OAuth client IDs are NOT secret — PKCE provides the
// security. Replace these placeholders or override via secrets store.

const BUILTIN_GOOGLE_CLIENT_ID = "REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
const BUILTIN_GITHUB_CLIENT_ID = "REPLACE_WITH_YOUR_GITHUB_CLIENT_ID";
const BUILTIN_SPOTIFY_CLIENT_ID = "REPLACE_WITH_YOUR_SPOTIFY_CLIENT_ID";

// ── Types ───────────────────────────────────────────────────────────────

interface ProviderConfig {
	authUrl: string;
	tokenUrl: string;
	builtinClientId: string;
	overrideClientIdKey: string;
	overrideClientSecretKey: string;
	supportsPkce: boolean;
}

export interface OAuthResult {
	provider: string;
	token_key: string;
	success: boolean;
	message: string;
}

interface OAuthFlowArgs {
	provider: string;
	scopes?: string;
	custom_auth_url?: string;
	custom_token_url?: string;
	custom_client_id?: string;
	custom_client_secret?: string;
}

interface OAuthRefreshArgs {
	provider: string;
	custom_token_url?: string;
	custom_client_id?: string;
	custom_client_secret?: string;
}

// ── Provider registry ───────────────────────────────────────────────────

function knownProvider(name: string): ProviderConfig | null {
	switch (name) {
		case "google":
			return {
				authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: "https://oauth2.googleapis.com/token",
				builtinClientId: BUILTIN_GOOGLE_CLIENT_ID,
				overrideClientIdKey: "GOOGLE_CLIENT_ID",
				overrideClientSecretKey: "GOOGLE_CLIENT_SECRET",
				supportsPkce: true,
			};
		case "github":
			return {
				authUrl: "https://github.com/login/oauth/authorize",
				tokenUrl: "https://github.com/login/oauth/access_token",
				builtinClientId: BUILTIN_GITHUB_CLIENT_ID,
				overrideClientIdKey: "GITHUB_CLIENT_ID",
				overrideClientSecretKey: "GITHUB_CLIENT_SECRET",
				supportsPkce: false,
			};
		case "spotify":
			return {
				authUrl: "https://accounts.spotify.com/authorize",
				tokenUrl: "https://accounts.spotify.com/api/token",
				builtinClientId: BUILTIN_SPOTIFY_CLIENT_ID,
				overrideClientIdKey: "SPOTIFY_CLIENT_ID",
				overrideClientSecretKey: "SPOTIFY_CLIENT_SECRET",
				supportsPkce: true,
			};
		default:
			return null;
	}
}

// ── PKCE helpers ────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	const bytes = randomBytes(64);
	let result = "";
	for (let i = 0; i < 64; i++) {
		result += alphabet[bytes[i] % alphabet.length];
	}
	return result;
}

function computeCodeChallenge(verifier: string): string {
	const hash = createHash("sha256").update(verifier).digest();
	return hash.toString("base64url");
}

// ── Public API ──────────────────────────────────────────────────────────

export async function oauth_flow(args: OAuthFlowArgs): Promise<OAuthResult> {
	const providerLower = args.provider.toLowerCase();
	console.error(`[oauth] starting flow for provider: ${providerLower}`);

	const cfg = knownProvider(providerLower);
	let authUrl: string;
	let tokenUrl: string;
	let clientId: string;
	let clientSecret: string;
	let usePkce: boolean;

	if (cfg) {
		const store = await loadSecretsMap();
		clientId = store[cfg.overrideClientIdKey] ?? args.custom_client_id ?? cfg.builtinClientId;
		clientSecret = store[cfg.overrideClientSecretKey] ?? args.custom_client_secret ?? "";
		authUrl = cfg.authUrl;
		tokenUrl = cfg.tokenUrl;
		usePkce = cfg.supportsPkce;
	} else {
		clientId = args.custom_client_id ?? "";
		if (!clientId) throw new Error("Need custom_client_id for unknown provider");
		clientSecret = args.custom_client_secret ?? "";
		authUrl = args.custom_auth_url ?? "";
		if (!authUrl) throw new Error("Need custom_auth_url for unknown provider");
		tokenUrl = args.custom_token_url ?? "";
		if (!tokenUrl) throw new Error("Need custom_token_url for unknown provider");
		usePkce = true;
	}

	if (clientId.startsWith("REPLACE_WITH_")) {
		throw new Error(
			`Built-in client ID not configured for ${providerLower}. ` +
				`The app developer needs to set up OAuth credentials, ` +
				`or you can store your own: store_secret(name="${providerLower.toUpperCase()}_CLIENT_ID", value="...")`,
		);
	}

	// Generate PKCE code verifier + challenge
	let codeVerifier: string | null = null;
	let codeChallenge: string | null = null;
	if (usePkce) {
		codeVerifier = generateCodeVerifier();
		codeChallenge = computeCodeChallenge(codeVerifier);
		console.error("[oauth] using PKCE (S256)");
	}

	// Bind random localhost port
	const { server, port } = await bindLocalhost();
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	console.error(`[oauth] redirect URI: ${redirectUri}`);

	// Build consent URL
	const scopesStr = args.scopes ?? "";
	let consentUrl =
		`${authUrl}?response_type=code` +
		`&client_id=${encodeURIComponent(clientId)}` +
		`&redirect_uri=${encodeURIComponent(redirectUri)}` +
		`&scope=${encodeURIComponent(scopesStr)}` +
		`&access_type=offline&prompt=consent`;

	if (codeChallenge) {
		consentUrl += `&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
	}

	// Open browser
	console.error("[oauth] opening browser...");
	await openBrowser(consentUrl);

	// Wait for callback
	const code = await waitForCallback(server, 120_000);
	console.error(`[oauth] received auth code (${code.length} chars)`);
	server.close();

	// Exchange code for tokens
	let tokenBody =
		`grant_type=authorization_code` +
		`&code=${encodeURIComponent(code)}` +
		`&redirect_uri=${encodeURIComponent(redirectUri)}` +
		`&client_id=${encodeURIComponent(clientId)}`;

	if (codeVerifier) {
		tokenBody += `&code_verifier=${encodeURIComponent(codeVerifier)}`;
	}
	if (clientSecret) {
		tokenBody += `&client_secret=${encodeURIComponent(clientSecret)}`;
	}

	const tokens = await exchangeToken(tokenUrl, tokenBody);
	await storeTokens(providerLower, tokens);

	const tokenKey = `${providerLower.toUpperCase()}_ACCESS_TOKEN`;
	console.error(`[oauth] flow complete for ${providerLower}`);

	return {
		provider: providerLower,
		token_key: tokenKey,
		success: true,
		message: `Connected to ${args.provider}! Token stored as ${tokenKey}.`,
	};
}

export async function oauth_refresh(args: OAuthRefreshArgs): Promise<OAuthResult> {
	const providerLower = args.provider.toLowerCase();
	const tokenPrefix = providerLower.toUpperCase();

	const store = await loadSecretsMap();
	const refreshKey = `${tokenPrefix}_REFRESH_TOKEN`;
	const refreshToken = store[refreshKey];
	if (!refreshToken) {
		throw new Error(`No refresh token found (${refreshKey}). Run oauth_flow first.`);
	}

	const cfg = knownProvider(providerLower);
	let tokenUrl: string;
	let clientId: string;
	let clientSecret: string;

	if (cfg) {
		clientId = store[cfg.overrideClientIdKey] ?? args.custom_client_id ?? cfg.builtinClientId;
		clientSecret = store[cfg.overrideClientSecretKey] ?? args.custom_client_secret ?? "";
		tokenUrl = cfg.tokenUrl;
	} else {
		clientId = args.custom_client_id ?? "";
		if (!clientId) throw new Error("Need custom_client_id");
		clientSecret = args.custom_client_secret ?? "";
		tokenUrl = args.custom_token_url ?? "";
		if (!tokenUrl) throw new Error("Need custom_token_url");
	}

	let body =
		`grant_type=refresh_token` +
		`&refresh_token=${encodeURIComponent(refreshToken)}` +
		`&client_id=${encodeURIComponent(clientId)}`;

	if (clientSecret) {
		body += `&client_secret=${encodeURIComponent(clientSecret)}`;
	}

	const tokens = await exchangeToken(tokenUrl, body);
	await storeTokens(providerLower, tokens);

	const tokenKey = `${tokenPrefix}_ACCESS_TOKEN`;
	console.error(`[oauth] refreshed token for ${providerLower}`);

	return {
		provider: providerLower,
		token_key: tokenKey,
		success: true,
		message: `Token refreshed. Stored as ${tokenKey}.`,
	};
}

// ── Internal helpers ────────────────────────────────────────────────────

async function loadSecretsMap(): Promise<Record<string, string>> {
	const keys = await secrets.list_secrets();
	const store: Record<string, string> = {};
	for (const key of keys) {
		const val = await secrets.get_secret({ name: key });
		if (val !== null) store[key] = val;
	}
	return store;
}

function bindLocalhost(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				server.close();
				reject(new Error("Failed to bind localhost"));
				return;
			}
			resolve({ server, port: addr.port });
		});
		server.on("error", reject);
	});
}

function waitForCallback(
	server: ReturnType<typeof createServer>,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			server.close();
			reject(new Error("OAuth timed out — no callback received. Please try again."));
		}, timeoutMs);

		server.on("request", (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", `http://127.0.0.1`);
			const code = url.searchParams.get("code");

			if (code) {
				res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
				res.end(
					`<html><body style="font-family:system-ui;text-align:center;padding:60px;` +
						`background:#0a0e1e;color:#e2e8f0">` +
						`<h1 style="color:#818cf8">Connected!</h1>` +
						`<p>You can close this tab and return to Samuel.</p></body></html>`,
				);
				clearTimeout(timer);
				resolve(code);
			} else {
				res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
				res.end(
					`<html><body style="font-family:system-ui;text-align:center;padding:60px;` +
						`background:#0a0e1e;color:#e2e8f0">` +
						`<h1 style="color:#f87171">Something went wrong</h1>` +
						`<p>No authorization code received. Please try again.</p></body></html>`,
				);
			}
		});
	});
}

async function exchangeToken(
	tokenUrl: string,
	body: string,
): Promise<Record<string, unknown>> {
	const resp = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`Token exchange failed: ${errText}`);
	}

	const json = (await resp.json()) as Record<string, unknown>;

	if (typeof json.error === "string") {
		const desc = (json.error_description as string) ?? "unknown";
		throw new Error(`OAuth error: ${json.error} — ${desc}`);
	}

	return json;
}

async function storeTokens(
	provider: string,
	tokens: Record<string, unknown>,
): Promise<void> {
	const prefix = provider.toUpperCase();
	const stored: string[] = [];

	if (typeof tokens.access_token === "string") {
		const key = `${prefix}_ACCESS_TOKEN`;
		await secrets.set_secret({ name: key, value: tokens.access_token });
		stored.push(key);
	}

	if (typeof tokens.refresh_token === "string") {
		const key = `${prefix}_REFRESH_TOKEN`;
		await secrets.set_secret({ name: key, value: tokens.refresh_token });
		stored.push(key);
	}

	if (typeof tokens.expires_in === "number") {
		const key = `${prefix}_TOKEN_EXPIRES_AT`;
		const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
		await secrets.set_secret({ name: key, value: String(expiresAt) });
		stored.push(key);
	}

	console.error(`[oauth] stored: ${stored.join(", ")}`);
}

function openBrowser(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("open", [url], (err) => {
			if (err) reject(new Error(`Failed to open browser: ${err.message}`));
			else resolve();
		});
	});
}
