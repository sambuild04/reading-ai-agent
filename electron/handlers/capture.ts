import { execFileSync } from "node:child_process";
import {
	readFileSync,
	writeFileSync,
	unlinkSync,
	existsSync,
	statSync,
	copyFileSync,
} from "node:fs";

// ── State ────────────────────────────────────────────────────────────────────

let defaultDisplay = 1;
let autoScreenHash = 0;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CaptureResult {
	base64: string;
	app_name: string;
	display_context?: string;
}

export interface DisplayInfo {
	index: number;
	name: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findPeekaboo(): string {
	const paths = ["/opt/homebrew/bin/peekaboo", "/usr/local/bin/peekaboo"];
	for (const p of paths) {
		if (existsSync(p)) return p;
	}
	return "peekaboo";
}

function runPeekaboo(args: string[]): string {
	const bin = findPeekaboo();
	try {
		return execFileSync(bin, args, { encoding: "utf-8" });
	} catch (err) {
		throw new Error(
			`Failed to run peekaboo (${bin}): ${err instanceof Error ? err.message : err}`,
		);
	}
}

function hashBytes(data: Buffer | Uint8Array): number {
	let hash = 0;
	for (let i = 0; i < data.length; i += 64) {
		hash = (hash * 31 + data[i]) | 0;
	}
	return hash >>> 0;
}

function tryRemove(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// ignore
	}
}

function truncateStr(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max);
}

// ── AppleScript helpers ─────────────────────────────────────────────────────

const EXCLUDED_APPS = ["samuel", "cursor", "electron"];

function getUserFacingApp(): string | null {
	const script = `tell application "System Events"
  set appList to name of every application process whose visible is true
  return appList
end tell`;
	try {
		const raw = execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf-8",
		});
		for (const name of raw.split(",")) {
			const trimmed = name.trim();
			if (!trimmed) continue;
			const lower = trimmed.toLowerCase();
			if (EXCLUDED_APPS.some((ex) => lower.includes(ex))) continue;
			return trimmed;
		}
	} catch {
		// ignore
	}
	return null;
}

function getFrontmostAppName(): string {
	try {
		return execFileSync("/usr/bin/osascript", [
			"-e",
			'tell application "System Events" to get name of first application process whose frontmost is true',
		], { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

function findDisplayForApp(app: string): number | null {
	const posScript = `tell application "System Events"
  try
    set appProc to application process "${app}"
    set winPos to position of window 1 of appProc
    return ((item 1 of winPos) as text) & "," & ((item 2 of winPos) as text)
  on error
    return "none"
  end try
end tell`;
	let raw: string;
	try {
		raw = execFileSync("/usr/bin/osascript", ["-e", posScript], {
			encoding: "utf-8",
		}).trim();
	} catch {
		return null;
	}
	if (raw === "none" || !raw) return null;
	const [wxStr, wyStr] = raw.split(",");
	const wx = parseFloat(wxStr);
	const seWy = parseFloat(wyStr);
	if (Number.isNaN(wx) || Number.isNaN(seWy)) return null;

	// System Events uses top-left origin; NSScreen uses bottom-left (Cocoa).
	// Get all screen rects via NSStringFromRect to avoid the broken dot-access.
	const screenScript = `use framework "Foundation"
use framework "AppKit"
set screens to current application's NSScreen's screens()
set output to ""
repeat with i from 1 to count of screens
  set scr to item i of screens
  set rectStr to (current application's NSStringFromRect(scr's frame())) as text
  set output to output & i & "|" & rectStr & linefeed
end repeat
return output`;

	const rectRe = /\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{(-?[\d.]+),\s*(-?[\d.]+)\}\}/;
	try {
		const sRaw = execFileSync(
			"/usr/bin/osascript",
			["-l", "AppleScript", "-e", screenScript],
			{ encoding: "utf-8" },
		);
		const screens: { idx: number; ox: number; oy: number; sw: number; sh: number }[] = [];
		let mainH = 0;
		for (const line of sRaw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const pipeIdx = trimmed.indexOf("|");
			if (pipeIdx < 0) continue;
			const idx = parseInt(trimmed.slice(0, pipeIdx), 10);
			const m = rectRe.exec(trimmed.slice(pipeIdx + 1));
			if (!m) continue;
			const s = {
				idx,
				ox: parseFloat(m[1]),
				oy: parseFloat(m[2]),
				sw: parseFloat(m[3]),
				sh: parseFloat(m[4]),
			};
			screens.push(s);
			// Main screen (index 1) defines the coordinate reference height
			if (idx === 1) mainH = s.sh;
		}
		if (!mainH && screens.length) mainH = screens[0].sh;

		// Convert System Events y (top-left) to Cocoa y (bottom-left)
		const wy = mainH - seWy;

		for (const s of screens) {
			if (wx >= s.ox && wx < s.ox + s.sw && wy >= s.oy && wy < s.oy + s.sh) {
				return s.idx;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

function getDisplayLayoutSummary(): string | null {
	const script = `tell application "System Events"
  set appList to name of every application process whose visible is true
  set output to ""
  repeat with a in appList
    set output to output & a & linefeed
  end repeat
  return output
end tell`;

	let raw: string;
	try {
		raw = execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf-8",
		});
	} catch {
		return null;
	}

	const skip = [
		"samuel",
		"cursor",
		"electron",
		"windowserver",
		"dock",
		"systemiuserver",
		"finder",
	];
	const apps = raw
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(l) => l && !skip.some((s) => l.toLowerCase().includes(s)),
		);

	if (!apps.length) return null;

	const byDisplay = new Map<number, string[]>();
	const unplaced: string[] = [];
	for (const app of apps) {
		const d = findDisplayForApp(app);
		if (d != null) {
			const list = byDisplay.get(d) ?? [];
			list.push(app);
			byDisplay.set(d, list);
		} else {
			unplaced.push(app);
		}
	}

	const parts: string[] = [];
	const keys = [...byDisplay.keys()].sort((a, b) => a - b);
	for (const k of keys) {
		parts.push(`Display ${k}: ${byDisplay.get(k)!.join(", ")}`);
	}
	if (unplaced.length) {
		parts.push(`(also open: ${unplaced.join(", ")})`);
	}
	return parts.length ? parts.join(" | ") : null;
}

// ── Core capture functions ──────────────────────────────────────────────────

function captureFullDisplay(): CaptureResult {
	const tmpPng = "/tmp/samuel-autoscreen.png";
	const tmpJpg = "/tmp/samuel-autoscreen.jpg";

	tryRemove(tmpPng);

	const dFlag = `-D${defaultDisplay}`;
	try {
		execFileSync("/usr/sbin/screencapture", ["-x", dFlag, tmpPng]);
	} catch {
		throw new Error("screencapture failed");
	}

	const data = readFileSync(tmpPng);
	if (data.length < 1000) {
		tryRemove(tmpPng);
		throw new Error("Captured image too small");
	}

	let quality = 55;
	const width = 1440;

	// Re-encode to JPEG with size target <200KB
	while (true) {
		try {
			execFileSync("/usr/bin/sips", [
				"--resampleWidth", String(width),
				"--setProperty", "format", "jpeg",
				"--setProperty", "formatOptions", String(quality),
				tmpPng,
				"--out", tmpJpg,
			]);
		} catch {
			tryRemove(tmpPng);
			throw new Error("Failed to resize screenshot");
		}

		const size = statSync(tmpJpg).size;
		if (size <= 200_000 || quality <= 20) break;
		quality -= 10;
		console.error(
			`[capture] JPEG too large (${size}B), retrying at quality ${quality}`,
		);
	}

	tryRemove(tmpPng);

	const jpgData = readFileSync(tmpJpg);
	console.error(
		`[capture] full-display JPEG: ${jpgData.length} bytes (q=${quality}, w=${width})`,
	);
	tryRemove(tmpJpg);

	const layout = getDisplayLayoutSummary();
	const b64 = jpgData.toString("base64");

	return {
		base64: b64,
		app_name: `Display ${defaultDisplay}`,
		display_context: layout ?? undefined,
	};
}

function captureFocusedWindow(
	requestedApp?: string | null,
): CaptureResult {
	const tmpPng = "/tmp/samuel-screen.png";
	const tmpJpg = "/tmp/samuel-screen.jpg";
	const debugJpg = "/tmp/samuel-screen-debug.jpg";

	let targetApp: string | null = null;

	if (requestedApp !== undefined && requestedApp !== null) {
		if (!requestedApp) {
			targetApp = getUserFacingApp();
		} else {
			// Find a visible app matching the requested name
			const script = `tell application "System Events"
  set appList to name of every application process whose visible is true
  set output to ""
  repeat with a in appList
    set output to output & a & linefeed
  end repeat
  return output
end tell`;
			try {
				const raw = execFileSync("/usr/bin/osascript", ["-e", script], {
					encoding: "utf-8",
				});
				const needle = requestedApp.toLowerCase();
				targetApp =
					raw
						.split("\n")
						.map((l) => l.trim())
						.filter((l) => l.length > 0)
						.find((l) => l.toLowerCase().includes(needle)) ?? null;
			} catch {
				// ignore
			}
		}
	} else {
		targetApp = getUserFacingApp();
	}

	const appLabel = targetApp ?? requestedApp ?? "Desktop";
	console.error(
		`[capture] target: ${appLabel} (requested: ${requestedApp ?? "none"})`,
	);

	let usedFullScreen = false;

	// Try peekaboo window capture
	if (targetApp) {
		try {
			runPeekaboo([
				"image",
				"--app",
				targetApp,
				"--format",
				"png",
				"--path",
				tmpPng,
			]);
		} catch {
			// fall through
		}
	}

	const peekabooOk =
		existsSync(tmpPng) && statSync(tmpPng).size > 10_000;

	if (!peekabooOk) {
		tryRemove(tmpPng);

		const displayIdx = targetApp
			? findDisplayForApp(targetApp) ?? defaultDisplay
			: defaultDisplay;

		console.error(`[capture] falling back to display ${displayIdx}`);
		const dFlag = `-D${displayIdx}`;
		try {
			execFileSync("/usr/sbin/screencapture", ["-x", dFlag, tmpPng]);
		} catch {
			throw new Error("screencapture failed");
		}
		usedFullScreen = true;
	}

	const data = readFileSync(tmpPng);
	console.error(`[capture] raw PNG: ${data.length} bytes`);

	if (data.length < 1000) {
		tryRemove(tmpPng);
		throw new Error(
			"Captured image too small — check Screen Recording permissions.",
		);
	}

	try {
		execFileSync("/usr/bin/sips", [
			"--resampleWidth", "1024",
			"--setProperty", "format", "jpeg",
			"--setProperty", "formatOptions", "60",
			tmpPng,
			"--out", tmpJpg,
		]);
	} catch {
		tryRemove(tmpPng);
		throw new Error("Failed to resize screenshot");
	}

	tryRemove(tmpPng);

	const jpgData = readFileSync(tmpJpg);
	console.error(
		`[capture] final JPEG: ${jpgData.length} bytes (full_screen=${usedFullScreen})`,
	);

	try {
		copyFileSync(tmpJpg, debugJpg);
	} catch {
		// ignore
	}
	tryRemove(tmpJpg);

	let label: string;
	if (usedFullScreen) {
		const d = targetApp
			? findDisplayForApp(targetApp)
				? `Display ${findDisplayForApp(targetApp)}`
				: `Display ${defaultDisplay}`
			: `Display ${defaultDisplay}`;
		label = `${d} (${appLabel})`;
	} else {
		label = appLabel;
	}

	const b64 = jpgData.toString("base64");
	return { base64: b64, app_name: label };
}

/**
 * Auto-detect which display the frontmost app is on and capture that display.
 * Falls back to defaultDisplay if detection fails.
 */
function captureSmartDisplay(): CaptureResult {
	const frontApp = getFrontmostAppName();
	const lower = frontApp.toLowerCase();
	// If Samuel/Cursor/Electron is frontmost, find the next user-facing app
	const actualApp = EXCLUDED_APPS.some((ex) => lower.includes(ex))
		? getUserFacingApp()
		: frontApp;

	let targetDisplay = defaultDisplay;
	if (actualApp) {
		const detected = findDisplayForApp(actualApp);
		if (detected != null) {
			targetDisplay = detected;
			console.error(
				`[capture] smart display: ${actualApp} on Display ${detected}`,
			);
		}
	}

	const prev = defaultDisplay;
	defaultDisplay = targetDisplay;
	try {
		return captureFullDisplay();
	} finally {
		defaultDisplay = prev;
	}
}

// ── Exported commands ───────────────────────────────────────────────────────

export async function capture_active_window(args: {
	app_name?: string;
	display?: number;
}): Promise<CaptureResult> {
	if (args.display != null) {
		const prev = defaultDisplay;
		defaultDisplay = args.display;
		try {
			return captureFullDisplay();
		} finally {
			defaultDisplay = prev;
		}
	}
	if (args.app_name !== undefined) {
		return captureFocusedWindow(args.app_name);
	}
	return captureFullDisplay();
}

export async function capture_if_changed(): Promise<CaptureResult | null> {
	const capture = captureSmartDisplay();
	const currentHash = hashBytes(Buffer.from(capture.base64));
	if (autoScreenHash === currentHash) return null;
	autoScreenHash = currentHash;
	return capture;
}

export async function capture_screen_now(): Promise<CaptureResult> {
	return captureSmartDisplay();
}

export async function native_screenshot(): Promise<string> {
	const tmpPng = "/tmp/samuel-cua-native.png";
	const tmpJpg = "/tmp/samuel-cua-native.jpg";

	tryRemove(tmpPng);

	// Smart display detection for CUA screenshots
	let targetDisplay = defaultDisplay;
	const frontApp = getFrontmostAppName();
	if (frontApp) {
		const detected = findDisplayForApp(frontApp);
		if (detected != null) targetDisplay = detected;
	}
	const dFlag = `-D${targetDisplay}`;
	try {
		execFileSync("/usr/sbin/screencapture", ["-x", dFlag, tmpPng]);
	} catch {
		throw new Error("screencapture failed");
	}

	const data = readFileSync(tmpPng);
	if (data.length < 1000) {
		tryRemove(tmpPng);
		throw new Error("Captured image too small");
	}

	const width = 1280;
	const quality = 50;
	try {
		execFileSync("/usr/bin/sips", [
			"--resampleWidth", String(width),
			"--setProperty", "format", "jpeg",
			"--setProperty", "formatOptions", String(quality),
			tmpPng,
			"--out", tmpJpg,
		]);
	} catch {
		tryRemove(tmpPng);
		throw new Error("Failed to resize screenshot");
	}

	tryRemove(tmpPng);

	const jpgData = readFileSync(tmpJpg);
	tryRemove(tmpJpg);

	console.error(
		`[native-screenshot] ${jpgData.length} bytes (${width}x, q=${quality})`,
	);
	return jpgData.toString("base64");
}

export async function list_displays(): Promise<DisplayInfo[]> {
	const script = `use framework "AppKit"
set screens to current application's NSScreen's screens()
set output to ""
repeat with i from 1 to count of screens
  set scr to item i of screens
  set nm to (scr's localizedName()) as text
  set output to output & i & "|" & nm & linefeed
end repeat
return output`;

	let raw: string;
	try {
		raw = execFileSync(
			"/usr/bin/osascript",
			["-l", "AppleScript", "-e", script],
			{ encoding: "utf-8" },
		);
	} catch (err) {
		throw new Error(`list_displays: ${err}`);
	}

	const displays: DisplayInfo[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const sep = trimmed.indexOf("|");
		if (sep === -1) continue;
		const idx = parseInt(trimmed.slice(0, sep), 10);
		const name = trimmed.slice(sep + 1).trim();
		if (!Number.isNaN(idx)) {
			displays.push({ index: idx, name });
		}
	}

	if (!displays.length) {
		displays.push({ index: 1, name: "Main Display" });
	}

	console.error(`[displays] found: ${JSON.stringify(displays)}`);
	return displays;
}

export async function set_default_display(args: {
	index: number;
}): Promise<void> {
	defaultDisplay = args.index;
	console.error(`[displays] default set to ${args.index}`);
}

export function get_default_display(): number {
	return defaultDisplay;
}

export async function get_selected_text(): Promise<string> {
	// 1. Save current clipboard
	let prev: string;
	try {
		prev = execFileSync("pbpaste", { encoding: "utf-8" });
	} catch {
		prev = "";
	}

	// 2. Clear clipboard
	try {
		execFileSync("pbcopy", { input: "", encoding: "utf-8" });
	} catch {
		// ignore
	}

	// 3. Simulate Cmd+C on user-facing app
	const target = getUserFacingApp() ?? "";
	console.error(`[selected-text] copying from: ${target || "(global)"}`);

	const copyScript = target
		? `tell application "${target}" to activate
delay 0.1
tell application "System Events" to keystroke "c" using command down`
		: 'tell application "System Events" to keystroke "c" using command down';

	try {
		execFileSync("/usr/bin/osascript", ["-e", copyScript]);
	} catch {
		// ignore
	}

	// 4. Brief pause for clipboard to update
	execFileSync("sleep", ["0.2"]);

	// 5. Read new clipboard
	let selected: string;
	try {
		selected = execFileSync("pbpaste", { encoding: "utf-8" }).trim();
	} catch {
		selected = "";
	}

	// 6. Restore original clipboard
	try {
		execFileSync("pbcopy", { input: prev, encoding: "utf-8" });
	} catch {
		// ignore
	}

	console.error(`[selected-text] got: "${truncateStr(selected, 80)}"`);
	return selected;
}

export async function set_system_volume(args: {
	volume: number;
}): Promise<void> {
	const vol = Math.min(Math.max(args.volume, 0), 100);
	const script = `set volume output volume ${vol}`;
	try {
		execFileSync("/usr/bin/osascript", ["-e", script]);
	} catch (err) {
		throw new Error(`osascript: ${err}`);
	}
	console.error(`[volume] system volume set to ${vol}%`);
}
