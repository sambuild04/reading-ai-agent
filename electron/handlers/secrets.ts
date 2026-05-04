import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SAMUEL_DIR = ".samuel";
const SECRETS_FILE = "secrets.json";

type SecretsStore = Record<string, string>;

function secretsPath(): string {
	const dir = join(homedir(), SAMUEL_DIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return join(dir, SECRETS_FILE);
}

function loadSecrets(): SecretsStore {
	try {
		const path = secretsPath();
		if (!existsSync(path)) return {};
		const data = readFileSync(path, "utf-8");
		return JSON.parse(data) as SecretsStore;
	} catch {
		return {};
	}
}

function saveSecrets(store: SecretsStore): void {
	const path = secretsPath();
	writeFileSync(path, JSON.stringify(store, null, 2));
}

export async function get_secret(args: { name: string }): Promise<string | null> {
	const store = loadSecrets();
	return store[args.name] ?? null;
}

export async function set_secret(args: { name: string; value: string }): Promise<string> {
	const store = loadSecrets();
	store[args.name] = args.value;
	saveSecrets(store);
	console.error(`[secrets] stored '${args.name}'`);
	return `Secret '${args.name}' saved.`;
}

export async function delete_secret(args: { name: string }): Promise<string> {
	const store = loadSecrets();
	if (!(args.name in store)) {
		throw new Error(`Secret '${args.name}' not found.`);
	}
	delete store[args.name];
	saveSecrets(store);
	console.error(`[secrets] deleted '${args.name}'`);
	return `Secret '${args.name}' removed.`;
}

export async function list_secrets(): Promise<string[]> {
	const store = loadSecrets();
	return Object.keys(store).sort();
}
