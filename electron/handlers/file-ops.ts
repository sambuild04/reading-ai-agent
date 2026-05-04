import {
	readFileSync,
	writeFileSync,
	readdirSync,
	mkdirSync,
	existsSync,
	statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

function resolvePath(raw: string): string {
	if (raw.startsWith("~/")) {
		return join(homedir(), raw.slice(2));
	}
	return raw;
}

function samuelDocsDir(): string {
	const dir = join(homedir(), "Documents", "Samuel");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

export async function agent_write_file(args: {
	path: string;
	content: string;
}): Promise<string> {
	let target: string;
	if (!args.path || args.path === "auto") {
		const dir = samuelDocsDir();
		const ts = Math.floor(Date.now() / 1000);
		target = join(dir, `note-${ts}.md`);
	} else {
		target = resolvePath(args.path);
	}

	const parent = dirname(target);
	if (!existsSync(parent)) {
		mkdirSync(parent, { recursive: true });
	}

	writeFileSync(target, args.content);
	const size = Buffer.byteLength(args.content);
	console.error(`[fs] wrote ${size} bytes to ${target}`);
	return `Saved to ${target} (${size} bytes)`;
}

export async function agent_read_file(args: { path: string }): Promise<string> {
	const target = resolvePath(args.path);
	if (!existsSync(target)) {
		throw new Error(`File not found: ${target}`);
	}

	const stat = statSync(target);
	if (stat.size > 512_000) {
		throw new Error(
			`File too large (${Math.floor(stat.size / 1024)} KB). Maximum is 500 KB for reading.`,
		);
	}

	const content = readFileSync(target, "utf-8");
	console.error(`[fs] read ${content.length} bytes from ${target}`);
	return content;
}

export async function agent_list_directory(args: {
	path: string;
}): Promise<string[]> {
	const target = !args.path ? samuelDocsDir() : resolvePath(args.path);

	if (!existsSync(target)) {
		throw new Error(`Directory not found: ${target}`);
	}

	const stat = statSync(target);
	if (!stat.isDirectory()) {
		throw new Error(`Not a directory: ${target}`);
	}

	const entries = readdirSync(target, { withFileTypes: true })
		.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
		.sort();

	console.error(`[fs] listed ${entries.length} entries in ${target}`);
	return entries;
}
