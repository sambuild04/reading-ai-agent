import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	readdirSync,
	unlinkSync,
	rmSync,
	copyFileSync,
} from "node:fs";
import { join } from "node:path";

const FLASHCARD_DIR = "/tmp/samuel-flashcards";
const FLASHCARD_DB = "/tmp/samuel-flashcards/deck.json";

export interface Flashcard {
	id: string;
	word: string;
	hint: string;
	transcript: string;
	audio_path: string | null;
	source: string;
	created_at: number;
	review_count: number;
}

interface FlashcardDeck {
	cards: Flashcard[];
}

function nowEpoch(): number {
	return Math.floor(Date.now() / 1000);
}

function ensureDir(): void {
	if (!existsSync(FLASHCARD_DIR)) {
		mkdirSync(FLASHCARD_DIR, { recursive: true });
	}
}

function loadDeck(): FlashcardDeck {
	ensureDir();
	try {
		if (!existsSync(FLASHCARD_DB)) return { cards: [] };
		const data = readFileSync(FLASHCARD_DB, "utf-8");
		return JSON.parse(data) as FlashcardDeck;
	} catch {
		return { cards: [] };
	}
}

function saveDeck(deck: FlashcardDeck): void {
	ensureDir();
	writeFileSync(FLASHCARD_DB, JSON.stringify(deck, null, 2));
}

export function saveAudioClip(sourcePath: string): string | null {
	if (!existsSync(sourcePath)) return null;
	ensureDir();
	const ts = nowEpoch();
	const dest = join(FLASHCARD_DIR, `clip-${ts}.m4a`);
	copyFileSync(sourcePath, dest);
	console.error(`[flashcards] saved audio clip: ${dest}`);
	return dest;
}

function addCard(
	word: string,
	hint: string,
	transcript: string,
	audioPath: string | null,
	source: string,
): Flashcard {
	const deck = loadDeck();
	const card: Flashcard = {
		id: `fc-${nowEpoch()}`,
		word,
		hint,
		transcript,
		audio_path: audioPath,
		source,
		created_at: nowEpoch(),
		review_count: 0,
	};
	deck.cards.push(card);
	saveDeck(deck);
	console.error(
		`[flashcards] added card: ${card.id} (deck size: ${deck.cards.length})`,
	);
	return card;
}

export function cleanup(): void {
	if (existsSync(FLASHCARD_DIR)) {
		try {
			const count = readdirSync(FLASHCARD_DIR).length;
			rmSync(FLASHCARD_DIR, { recursive: true, force: true });
			console.error(
				`[flashcards] cleaned up ${count} files from previous session`,
			);
		} catch {
			// ignore
		}
	}
}

export async function get_flashcard_deck(): Promise<Flashcard[]> {
	return loadDeck().cards;
}

export async function save_flashcard(args: {
	word: string;
	hint: string;
	transcript: string;
	audio_clip_path?: string | null;
	source: string;
}): Promise<Flashcard> {
	let audio: string | null = null;
	if (args.audio_clip_path && existsSync(args.audio_clip_path)) {
		audio = args.audio_clip_path;
	}
	return addCard(args.word, args.hint, args.transcript, audio, args.source);
}

export async function delete_flashcard(args: {
	card_id: string;
}): Promise<void> {
	const deck = loadDeck();
	const idx = deck.cards.findIndex((c) => c.id === args.card_id);
	if (idx !== -1) {
		const card = deck.cards.splice(idx, 1)[0];
		if (card.audio_path) {
			try {
				unlinkSync(card.audio_path);
			} catch {
				// ignore
			}
		}
		saveDeck(deck);
	}
}

export async function read_flashcard_file(args: {
	file_path: string;
}): Promise<string> {
	const data = readFileSync(args.file_path);
	return data.toString("base64");
}

export async function increment_flashcard_review(args: {
	card_id: string;
}): Promise<void> {
	const deck = loadDeck();
	const card = deck.cards.find((c) => c.id === args.card_id);
	if (card) {
		card.review_count += 1;
		saveDeck(deck);
	}
}
