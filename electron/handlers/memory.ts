import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readConfigInternal } from "./config.js";

const MEMORY_DIR = ".samuel";
const MEMORY_FILE = "memory.json";
const MAX_RECENT_OBSERVATIONS = 10;
const MAX_RECENT_TRANSCRIPTS = 5;
const VOCABULARY_COOLDOWN_SECS = 24 * 60 * 60;
const PERMANENT_KNOWN = Number.MAX_SAFE_INTEGER;
const MAX_WATCH_ENTRIES = 100;
const MAX_CORRECTIONS = 50;
const MAX_WATCHES = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export interface Correction {
	timestamp: number;
	what: string;
	source: string;
}

export interface WatchEntry {
	content_hash: number;
	title_hint: string;
	first_seen: number;
	last_seen: number;
	session_count: number;
	total_minutes: number;
}

export interface WatchAlert {
	id: string;
	description: string;
	condition_type: string;
	keywords: string[];
	source: string;
	message_template: string;
	created_at: number;
	fire_count: number;
	cooldown_secs: number;
	last_fired_at: number;
	enabled: boolean;
}

export interface WatchCheckMatch {
	id: string;
	description: string;
	message_template: string;
}

export interface ClassifierMatch {
	watch_id: string;
	description: string;
	message_template: string;
	detail: string;
}

export interface SamuelMemory {
	vocabulary_seen: Record<string, number>;
	recent_observations: string[];
	facts: Record<string, string>;
	recent_transcripts: string[];
	corrections: Correction[];
	watch_history: WatchEntry[];
	active_watches: WatchAlert[];
}

// ── Module-level cache (analogous to Rust's static Mutex) ────────────────────

let memory: SamuelMemory | null = null;

function defaultMemory(): SamuelMemory {
	return {
		vocabulary_seen: {},
		recent_observations: [],
		facts: {},
		recent_transcripts: [],
		corrections: [],
		watch_history: [],
		active_watches: [],
	};
}

function memoryPath(): string {
	const dir = join(homedir(), MEMORY_DIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return join(dir, MEMORY_FILE);
}

function loadMemory(): SamuelMemory {
	try {
		const path = memoryPath();
		if (!existsSync(path)) return defaultMemory();
		const data = readFileSync(path, "utf-8");
		const parsed = JSON.parse(data) as Partial<SamuelMemory>;
		return { ...defaultMemory(), ...parsed };
	} catch {
		return defaultMemory();
	}
}

function saveMemory(mem: SamuelMemory): void {
	try {
		const path = memoryPath();
		writeFileSync(path, JSON.stringify(mem, null, 2));
	} catch {
		// silently ignore write errors, matching Rust behavior
	}
}

function withMemory<R>(fn: (mem: SamuelMemory) => R): R {
	if (memory === null) {
		memory = loadMemory();
	}
	const result = fn(memory);
	saveMemory(memory);
	return result;
}

function nowSecs(): number {
	return Math.floor(Date.now() / 1000);
}

// ── Simple hash for content dedup (mirrors Rust's DefaultHasher on normalized text) ──

function hashContent(text: string): number {
	const normalized = text
		.toLowerCase()
		.replace(/[^\w\s]/g, "")
		.split(/\s+/)
		.join(" ");
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized.charCodeAt(i);
		hash = ((hash << 5) - hash + ch) | 0;
	}
	return Math.abs(hash);
}

// ── Internal helpers (exported for use by other modules) ─────────────────────

export function get_context(): string {
	return withMemory((mem) => {
		const parts: string[] = [];

		for (const [k, v] of Object.entries(mem.facts)) {
			parts.push(`${k}: ${v}`);
		}

		const recent = mem.recent_observations.slice().reverse().slice(0, 3);
		if (recent.length > 0) {
			parts.push(`Recent: ${recent.join("; ")}`);
		}

		const now = nowSecs();

		const knownForever = Object.entries(mem.vocabulary_seen)
			.filter(([, ts]) => ts === PERMANENT_KNOWN)
			.map(([w]) => w)
			.slice(0, 30);
		if (knownForever.length > 0) {
			parts.push(`User already knows (NEVER mention): ${knownForever.join(", ")}`);
		}

		const recentVocab = Object.entries(mem.vocabulary_seen)
			.filter(([, ts]) => ts !== PERMANENT_KNOWN && now - ts < VOCABULARY_COOLDOWN_SECS)
			.map(([w]) => w)
			.slice(0, 15);
		if (recentVocab.length > 0) {
			parts.push(`Recently taught (don't repeat today): ${recentVocab.join(", ")}`);
		}

		const corrections = mem.corrections
			.slice()
			.reverse()
			.slice(0, 5)
			.map((c) => c.what);
		if (corrections.length > 0) {
			parts.push(`User corrections (FOLLOW THESE): ${corrections.join("; ")}`);
		}

		return parts.length === 0 ? "No prior context." : parts.join(". ");
	});
}

export function record_observation(summary: string): void {
	withMemory((mem) => {
		mem.recent_observations.push(summary);
		if (mem.recent_observations.length > MAX_RECENT_OBSERVATIONS) {
			mem.recent_observations.shift();
		}
	});
}

export function record_transcript(text: string): void {
	withMemory((mem) => {
		mem.recent_transcripts.push(text);
		if (mem.recent_transcripts.length > MAX_RECENT_TRANSCRIPTS) {
			mem.recent_transcripts.shift();
		}
	});
}

export function get_recent_transcripts(): string[] {
	return withMemory((mem) => [...mem.recent_transcripts]);
}

export function record_vocabulary(words: string[]): void {
	const now = nowSecs();
	withMemory((mem) => {
		for (const word of words) {
			mem.vocabulary_seen[word] = now;
		}
	});
}

export function get_watches_context(): string | null {
	const watches = listWatchesInternal();
	const enabled = watches.filter((w) => w.enabled);
	if (enabled.length === 0) return null;

	const lines = enabled.map((w) => {
		const cond =
			w.condition_type === "keyword"
				? `keywords: ${w.keywords.join(", ")}`
				: "classifier (LLM judgment)";
		return `- [${w.id}] ${w.description} (${cond}, source: ${w.source}, cooldown: ${w.cooldown_secs}s, fired: ${w.fire_count}x)`;
	});
	return `Active watches:\n${lines.join("\n")}`;
}

// ── Watch/alert internal helpers ─────────────────────────────────────────────

function addWatchInternal(
	description: string,
	conditionType: string,
	keywords: string[],
	source: string,
	messageTemplate: string,
	cooldownSecs: number,
): string {
	const id = `w_${nowSecs()}`;
	withMemory((mem) => {
		mem.active_watches.push({
			id,
			description,
			condition_type: conditionType,
			keywords: keywords.map((k) => k.toLowerCase()),
			source,
			message_template: messageTemplate,
			created_at: nowSecs(),
			fire_count: 0,
			cooldown_secs: cooldownSecs,
			last_fired_at: 0,
			enabled: true,
		});
		if (mem.active_watches.length > MAX_WATCHES) {
			mem.active_watches.shift();
		}
	});
	return id;
}

function removeWatchInternal(id: string): boolean {
	return withMemory((mem) => {
		const before = mem.active_watches.length;
		mem.active_watches = mem.active_watches.filter((w) => w.id !== id);
		return mem.active_watches.length < before;
	});
}

function listWatchesInternal(): WatchAlert[] {
	return withMemory((mem) => [...mem.active_watches]);
}

function clearWatchesInternal(): void {
	withMemory((mem) => {
		mem.active_watches = [];
	});
}

function checkWatchesKeyword(text: string, source: string): Array<[string, string, string]> {
	const lower = text.toLowerCase();
	const now = nowSecs();
	return withMemory((mem) => {
		const matches: Array<[string, string, string]> = [];
		for (const watch of mem.active_watches) {
			if (!watch.enabled) continue;
			if (watch.source !== "both" && watch.source !== source) continue;
			if (watch.condition_type !== "keyword" || watch.keywords.length === 0) continue;
			if (watch.last_fired_at > 0 && now - watch.last_fired_at < watch.cooldown_secs) continue;

			const hit = watch.keywords.some((kw) => lower.includes(kw));
			if (hit) {
				watch.fire_count += 1;
				watch.last_fired_at = now;
				matches.push([watch.id, watch.description, watch.message_template]);
			}
		}
		return matches;
	});
}

function getClassifierWatchesInternal(source: string): WatchAlert[] {
	const now = nowSecs();
	return withMemory((mem) =>
		mem.active_watches.filter(
			(w) =>
				w.enabled &&
				w.condition_type === "classifier" &&
				(w.source === "both" || w.source === source) &&
				(w.last_fired_at === 0 || now - w.last_fired_at >= w.cooldown_secs),
		),
	);
}

function markWatchFiredInternal(id: string): void {
	withMemory((mem) => {
		const w = mem.active_watches.find((w) => w.id === id);
		if (w) {
			w.fire_count += 1;
			w.last_fired_at = nowSecs();
		}
	});
}

function addCorrectionInternal(what: string, source: string): void {
	withMemory((mem) => {
		mem.corrections.push({ timestamp: nowSecs(), what, source });
		if (mem.corrections.length > MAX_CORRECTIONS) {
			mem.corrections.splice(0, mem.corrections.length - MAX_CORRECTIONS);
		}
	});
}

function markKnownInternal(words: string[]): void {
	withMemory((mem) => {
		for (const word of words) {
			mem.vocabulary_seen[word] = PERMANENT_KNOWN;
		}
	});
}

// ── Exported Tauri command handlers ──────────────────────────────────────────

export async function memory_clear(): Promise<void> {
	const path = memoryPath();
	if (existsSync(path)) {
		unlinkSync(path);
	}
	memory = defaultMemory();
	console.error("[memory] cleared all data");
}

export async function memory_get_context(): Promise<string> {
	let ctx = get_context();
	const watchesCtx = get_watches_context();
	if (watchesCtx) {
		ctx += "\n\nActive watches (you are monitoring these):\n" + watchesCtx;
	}
	return ctx;
}

export async function memory_set_fact(args: { key: string; value: string }): Promise<void> {
	withMemory((mem) => {
		mem.facts[args.key] = args.value;
	});
	console.error(`[memory] fact: ${args.key} = ${args.value}`);
}

export async function memory_mark_known(args: { words: string[] }): Promise<void> {
	console.error(`[memory] marking as permanently known: ${args.words.join(", ")}`);
	markKnownInternal(args.words);
}

export async function memory_add_correction(args: { what: string; source: string }): Promise<void> {
	console.error(`[memory] correction from ${args.source}: ${args.what}`);
	addCorrectionInternal(args.what, args.source);
}

export async function extract_session_feedback(args: { transcript: string }): Promise<string[]> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key");

	const prompt = `Analyze this conversation between a user and their AI assistant "Samuel".
Extract any feedback, corrections, or behavioral preferences the user expressed.

Look for:
- Explicit corrections: "that's wrong", "no, it means...", "don't explain it that way"
- Behavioral feedback: "be more concise", "speak slower", "stop doing X"
- Implicit preferences: user seems frustrated by length, user cuts off Samuel, user repeats themselves

Return a JSON array of strings, each being one actionable correction.
If no feedback found, return an empty array [].
Return ONLY valid JSON, no markdown fences.

Transcript:
${args.transcript}`;

	const body = {
		model: "gpt-4o-mini",
		messages: [{ role: "user", content: prompt }],
		max_tokens: 1000,
	};

	const resp = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const data = await resp.json();
	const content: string = data?.choices?.[0]?.message?.content ?? "[]";

	const cleaned = content
		.trim()
		.replace(/^```json\s*/, "")
		.replace(/^```\s*/, "")
		.replace(/```$/, "")
		.trim();

	let corrections: string[];
	try {
		corrections = JSON.parse(cleaned);
	} catch {
		corrections = [];
	}

	for (const c of corrections) {
		addCorrectionInternal(c, "voice");
		console.error(`[memory] extracted correction: ${c}`);
	}

	return corrections;
}

// ── Watch command handlers ───────────────────────────────────────────────────

export async function watch_add(args: {
	description: string;
	condition_type: string;
	keywords: string[];
	source: string;
	message_template: string;
	cooldown_secs: number;
}): Promise<string> {
	const id = addWatchInternal(
		args.description,
		args.condition_type,
		args.keywords,
		args.source,
		args.message_template,
		args.cooldown_secs,
	);
	console.error(
		`[watch] added trigger: ${id} — ${args.description} (type=${args.condition_type}, cooldown=${args.cooldown_secs}s)`,
	);
	return id;
}

export async function watch_remove(args: { id: string }): Promise<boolean> {
	const removed = removeWatchInternal(args.id);
	console.error(`[watch] removed ${args.id}: ${removed}`);
	return removed;
}

export async function watch_list(): Promise<WatchAlert[]> {
	return listWatchesInternal();
}

export async function watch_clear(): Promise<void> {
	clearWatchesInternal();
	console.error("[watch] cleared all watches");
}

export async function watch_check(args: { text: string; source: string }): Promise<WatchCheckMatch[]> {
	const matches = checkWatchesKeyword(args.text, args.source);
	return matches.map(([id, description, message_template]) => ({
		id,
		description,
		message_template,
	}));
}

export async function watch_get_classifier(args: { source: string }): Promise<WatchAlert[]> {
	return getClassifierWatchesInternal(args.source);
}

export async function watch_mark_fired(args: { id: string }): Promise<void> {
	markWatchFiredInternal(args.id);
	console.error(`[watch] trigger fired: ${args.id}`);
}

export async function watch_evaluate_classifier(args: {
	content: string;
	source: string;
}): Promise<ClassifierMatch[]> {
	const watches = getClassifierWatchesInternal(args.source);
	if (watches.length === 0) return [];

	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key");

	const watchSpecs = watches
		.map((w, i) => `  ${i + 1}. [id=${w.id}] ${w.description}`)
		.join("\n");

	const systemPrompt =
		`You are a trigger evaluator. Given content from ${args.source}, decide which triggers fire.\n` +
		`Active triggers:\n${watchSpecs}\n\n` +
		`For each trigger that matches the content, output ONE JSON object per line:\n` +
		`{"id": "<watch_id>", "detail": "<brief explanation of what matched>"}\n\n` +
		`If NO trigger matches, output exactly: NONE\n` +
		`Be conservative — only fire when there's a clear match. Do not explain further.`;

	const body = {
		model: "gpt-4o-mini",
		max_tokens: 300,
		temperature: 0.0,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: args.content },
		],
	};

	const resp = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(8000),
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		console.error(`[watch-classifier] error: ${errText}`);
		return [];
	}

	const data = await resp.json();
	const text = (data?.choices?.[0]?.message?.content ?? "NONE").trim();
	console.error(`[watch-classifier] raw response: ${text}`);

	if (text === "NONE" || text === "") return [];

	const watchMap = new Map(watches.map((w) => [w.id, w]));
	const results: ClassifierMatch[] = [];

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "NONE") continue;
		try {
			const val = JSON.parse(trimmed);
			const id = val.id as string;
			const detail = val.detail as string;
			if (id && detail) {
				const watch = watchMap.get(id);
				if (watch) {
					markWatchFiredInternal(id);
					results.push({
						watch_id: id,
						description: watch.description,
						message_template: watch.message_template,
						detail,
					});
				}
			}
		} catch {
			// skip unparseable lines
		}
	}

	console.error(`[watch-classifier] ${results.length} triggers fired`);
	return results;
}
