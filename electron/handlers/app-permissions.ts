import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PERMS_DIR = join(homedir(), ".samuel");
const PERMS_FILE = join(PERMS_DIR, "app-permissions.json");

interface AppPermissions {
	always_allowed: string[];
	always_denied: string[];
}

function ensureDir(): void {
	if (!existsSync(PERMS_DIR)) mkdirSync(PERMS_DIR, { recursive: true });
}

function load(): AppPermissions {
	try {
		if (existsSync(PERMS_FILE)) {
			return JSON.parse(readFileSync(PERMS_FILE, "utf-8")) as AppPermissions;
		}
	} catch {
		// corrupted file — reset
	}
	return { always_allowed: [], always_denied: [] };
}

function save(perms: AppPermissions): void {
	ensureDir();
	writeFileSync(PERMS_FILE, JSON.stringify(perms, null, 2), "utf-8");
}

function normalize(name: string): string {
	return name.toLowerCase().trim();
}

export async function check_app_permission(args: {
	app_name: string;
}): Promise<"allowed" | "denied" | "ask"> {
	const perms = load();
	const norm = normalize(args.app_name);
	if (perms.always_allowed.some((a) => normalize(a) === norm)) return "allowed";
	if (perms.always_denied.some((a) => normalize(a) === norm)) return "denied";
	return "ask";
}

export async function set_app_permission(args: {
	app_name: string;
	permission: "always_allow" | "always_deny" | "remove";
}): Promise<string> {
	const perms = load();
	const norm = normalize(args.app_name);

	// Remove from both lists first
	perms.always_allowed = perms.always_allowed.filter((a) => normalize(a) !== norm);
	perms.always_denied = perms.always_denied.filter((a) => normalize(a) !== norm);

	if (args.permission === "always_allow") {
		perms.always_allowed.push(args.app_name);
	} else if (args.permission === "always_deny") {
		perms.always_denied.push(args.app_name);
	}

	save(perms);
	console.error(`[app-perms] ${args.app_name} → ${args.permission}`);
	return `${args.app_name}: ${args.permission}`;
}

export async function list_app_permissions(): Promise<AppPermissions> {
	return load();
}

export async function clear_app_permissions(): Promise<string> {
	save({ always_allowed: [], always_denied: [] });
	return "All app permissions cleared.";
}
