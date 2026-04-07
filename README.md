# Samuel — A Self-Evolving AI Desktop Agent That Writes Its Own Tools

> An AI assistant that lives on your desktop, speaks to you by voice, sees your screen, hears your audio — and can **add new capabilities to itself at runtime** when you ask. Say "Hey Samuel, add a weather tool" and he writes the code, loads it live, and it works in seconds. No rebuild. No restart. He learns your preferences, remembers your corrections, and gets better every session.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange.svg)
![OpenAI Realtime API](https://img.shields.io/badge/OpenAI-Realtime%20Voice-412991.svg)
![Stars](https://img.shields.io/github/stars/sambuild04/reading-ai-agent?style=social)

**Keywords:** self-modifying AI agent, runtime tool generation, AI desktop assistant, voice-first AI, OpenAI Realtime API, AI that writes its own code, dynamic plugin system, screen-aware AI, ambient AI agent, Tauri desktop app, AI language tutor, learn Japanese from anime, personality memory AI, self-evolving software

---

## The Headline Feature: Samuel Writes His Own Tools

Most AI agents have a fixed set of tools decided at compile time. Samuel doesn't.

```
You:     "Hey Samuel, add a weather tool"
Samuel:  "I'll create a tool that fetches weather from wttr.in. [Approve] [Reject]"
You:     *clicks Approve*
Samuel:  *generates code via GPT-4o-mini, writes it to disk, hot-loads it*
Samuel:  "Done, sir. The weather tool is ready."
You:     "What's the weather in Tokyo?"
Samuel:  "Currently 18°C and partly cloudy in Tokyo, sir."
```

**No rebuild. No restart. No deployment.** Samuel proposed the tool, you approved it, and it works — all within a single voice conversation.

If a plugin breaks, Samuel sees the error, proposes a fix, and rewrites it after your approval. Old versions are backed up automatically.

### How It Works Under the Hood

1. **`propose_plugin`** — Samuel describes what he'll build. An approval card appears with **Approve / Reject** buttons
2. **User approves** — via button click or voice ("yes", "go ahead")
3. **`write_plugin`** — GPT-4o-mini generates the code → saved to `~/.samuel/plugins/` → loaded via `new Function()` → agent hot-swapped via `session.updateAgent()`
4. **Immediately usable** — the new tool appears in the live Realtime API session

Plugins can call any web API via `fetch()`, access stored API keys via `secrets.get()`, and use standard JavaScript. Anything expressible as an async function works: weather, timers, RSS feeds, Wikipedia, currency conversion, translation services, notifications, and more.

### API Keys? Drop Them in the Envelope

Samuel has a **universal input** (envelope icon near his avatar). Drop anything in:

- **API key** → Samuel recognizes it and asks "What service is this for, sir?" → stores securely in `~/.samuel/secrets.json`
- **YouTube link** → "Shall I teach you from this song?"
- **Article URL** → "Want me to break this down?"
- **Any text** → Samuel decides what to do based on context

Plugins access stored keys at runtime via `secrets.get("openweathermap_key")` — no hardcoded credentials.

---

## See It In Action

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

https://github.com/user-attachments/assets/338f8194-49e6-496d-b218-715af4afa1ee

---

## Core Capabilities

### Always Watching, Always Listening

Samuel runs a continuous perception loop on your desktop:

- **Screen** — captures every 20 seconds via GPT-4o Vision (smart change detection — skips when nothing changed)
- **Audio** — transcribes system audio via ScreenCaptureKit with PID-level filtering (excludes Samuel's own voice)
- **Triage** — a three-way classifier (ignore / surface / act) decides whether each observation is worth mentioning

He absorbs context silently. Ask "what did they just say?" or "what's on my screen?" anytime — he already knows.

### Persistent Memory — He Learns From You

Samuel stores three types of memory, all local:

| Memory Type | Example | Storage |
|---|---|---|
| **Preferences** | "Be more concise" | Applied every session |
| **Corrections** | "That explanation was wrong" | Never repeated |
| **Facts** | "I'm intermediate at Japanese" | Adjusts behavior permanently |

Say "I already know that word" and Samuel permanently suppresses it. Say "be more direct" and he changes his communication style forever. Memory lives in `~/.samuel/memory.json` — fully auditable, no cloud dependency.

### Voice-Controlled Everything

Samuel **is** the settings panel:

| You say | What happens |
|---|---|
| "Make yourself smaller" | Avatar shrinks |
| "Make the font bigger" | Speech bubble text grows |
| "Hide the romaji" | Furigana annotations hidden |
| "Show cards less often" | Vocab card frequency reduced |
| "Close the card" | Current vocab card dismissed |
| "Reset the UI" | All visual settings restored |

Changes persist across sessions. No menus, no panels, no clicking through preferences.

### "Hey Samuel" Wake Word

Say "Hey Samuel" and he wakes up. Detected locally via Whisper — no cloud wake word service, no always-streaming audio to a server. After he responds and you go quiet, he returns to sleep mode automatically.

---

## Language Teaching (The Original Use Case)

Samuel started as a language tutor and it's still his strongest skill set.

### Ambient Voice Teaching

You're watching anime. Samuel sees the subtitles, hears the dialogue, and **speaks to you**: *"食べる — 'to eat', sir."* You don't press anything. You don't look away. He just tells you.

### "Teach Me From This" — Drop Anything

Drop any content into the envelope:

- **YouTube link** → instant lyrics via LRCLIB (no download), annotated vocabulary, embedded player
- **Article URL** → extracts text, annotates interesting words
- **Image / manga screenshot** → OCR + vocabulary breakdown
- **PDF** → text extraction + grammar highlights
- **Raw text** → immediate breakdown

One pipeline. Same annotated viewer every time — tappable words, grammar labels, voice explanations on demand.

### Scene Clip Flashcards

When Samuel spots a word, a vocab card pops up. Tap "Save it" and he saves the **actual 20-second audio clip** from the anime plus a screenshot. Your flashcards aren't text — they're real scenes. Review by replaying the exact moment you first heard the word.

### Proactive Difficulty Assessment

Samuel compares what you're watching against your proficiency level:

- *"Sir, this program seems rather advanced for your current level."*
- *"We've watched this one a few times already, sir."*

Conservative by default — speaks up only when genuinely confident.

### Any Language

Japanese, Chinese, Korean, Spanish, French, German, Portuguese, Arabic, Russian, Thai, Vietnamese, Hindi — say "I'm learning [language]" and everything adapts.

---

## What Makes Samuel Different

| | Traditional AI Assistants | Chatbots (ChatGPT/Gemini) | **Samuel** |
|---|---|---|---|
| **Voice-first** | Some | Text-first | **Real-time speech, always** |
| **Sees your screen** | No | No | **Continuous screen awareness** |
| **Hears your audio** | No | No | **System audio transcription** |
| **Self-modifying** | No | No | **Writes and loads its own tools** |
| **Persistent memory** | Limited | Per-session | **Local memory across all sessions** |
| **Hands-free** | Some | No | **"Hey Samuel" wake word** |
| **Voice-controlled UI** | No | No | **"Make the font bigger" — done** |
| **Plugin ecosystem** | Fixed tools | Fixed tools | **User-approved runtime plugins** |
| **Desktop-native** | Cloud-only | Browser tab | **Floats on desktop 24/7** |

---

## Architecture

```
You speak → "Hey Samuel" wake word → OpenAI Realtime API → 20+ tools → Voice response
                                              ↕
               Always watching screen (GPT-4o Vision, change detection)
               Always listening to audio (ScreenCaptureKit, PID filtering)
               Triage engine: ignore / vocab card / save flashcard
               Silent context injection (rolling — replaces stale, not accumulating)
               Self-modifying plugin system (propose → approve → generate → hot-load)
               Secrets store for API keys (local, encrypted-at-rest ready)
               Scene clips → replay audio + screenshot in flashcard deck
               YouTube → oEmbed + LRCLIB → annotated lyrics viewer
               Personality memory → corrections + preferences + proficiency
               Viewing assessment → difficulty / repetition / suggestion
```

| You say / do | What Samuel does |
|---|---|
| "Add a weather tool" | Proposes plugin → you approve → generates + loads live |
| "Fix that tool" | Reads error, proposes fix, rewrites after approval |
| *(drop API key in envelope)* | Asks what it's for, stores in secrets |
| "What plugins do I have?" | Lists all installed dynamic plugins |
| "Read this page" | Captures Apple Books page, reads it aloud |
| "Look at my Chrome" | Finds Chrome on any monitor, captures and describes |
| "Translate my screen" | Translates all visible foreign text with readings |
| "What did they just say?" | References ambient audio buffer |
| "I already know that" | Permanently suppresses that word |
| "Be more concise" | Stores preference, applied every session |
| "Make yourself smaller" | Adjusts UI in real-time |
| *(drop YouTube link in envelope)* | Fetches lyrics, annotates, embeds player |
| *(tap "Save it" on vocab card)* | Saves scene audio clip + screenshot |

### Models (6-model orchestration)

| Model | Purpose | Latency |
|---|---|---|
| **OpenAI Realtime API** | Voice conversation, teaching | ~500ms |
| **GPT-4o Vision** | Screen scanning, ambient observation | ~3-5s |
| **GPT-4o-mini** | Triage, annotation, plugin code generation | ~1s |
| **GPT-5.4 Computer Use** | Visual UI navigation | ~5-10s/turn |
| **gpt-4o-mini-transcribe** | Wake word + ambient audio | ~1s |
| **gpt-4o-transcribe** | Recording mode (high-fidelity) | ~3-10s |

### File Structure

```
src/                          React frontend (Vite + TypeScript)
├── hooks/
│   ├── useRealtime.ts        Realtime voice: heartbeat, reconnect, plugin loading
│   ├── useWakeWord.ts        "Hey Samuel" fuzzy wake word via Whisper
│   ├── useRecordMode.ts      System audio recording + analysis
│   ├── useLearningMode.ts    Ambient agent: screen+audio, triage, difficulty assessment
│   ├── useTeachMode.ts       "Teach me from this" state machine
│   └── useUIPreferences.ts   Voice-controlled UI preferences
├── lib/
│   ├── samuel.ts             Agent: 20+ tools, self-modification, memory, voice persona
│   ├── plugin-loader.ts      Dynamic plugin loader (new Function + secrets injection)
│   ├── session-bridge.ts     Bridges: image, context, recording, plugins, UI, secrets
│   ├── lyrics.ts             YouTube oEmbed + LRCLIB lyrics
│   └── sounds.ts             Synthesized sound effects
├── components/
│   ├── Character.tsx          Rive animation + speech bubbles + universal envelope
│   ├── PluginApproval.tsx     Plugin proposal card with Approve/Reject buttons
│   ├── PassiveSuggestion.tsx  Vocab cards: close button, voice dismiss, frequency control
│   ├── FlashcardDeck.tsx      Scene clip flashcard review panel
│   ├── TeachDrop.tsx          Universal envelope input (links, keys, text, images)
│   └── TeachViewer.tsx        Annotated content viewer + YouTube embed
└── styles/app.css             Transparent window, animations, approval card

src-tauri/                    Rust backend (Tauri v2)
├── helpers/
│   └── record-audio.swift    ScreenCaptureKit with PID-level process filtering
└── src/
    ├── commands.rs           Screen capture, Vision, Computer Use, triage, audio
    ├── plugins.rs            Plugin CRUD + GPT-4o-mini code generation
    ├── secrets.rs            Secure local secrets store (~/.samuel/secrets.json)
    ├── flashcards.rs         Scene clip flashcard persistence
    ├── memory.rs             Persistent memory: vocab, facts, corrections, history
    ├── teach.rs              Content pipeline: extract + annotate
    └── wake_word.rs          Whisper transcription
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | [Tauri v2](https://v2.tauri.app) (Rust + WebView) |
| Frontend | React 19 + Vite + TypeScript |
| Voice | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) (WebRTC) |
| Agent Framework | [`@openai/agents`](https://github.com/openai/openai-agents-js) |
| Vision | GPT-4o Vision |
| Computer Use | GPT-5.4 Responses API |
| Plugin Runtime | `new Function()` + secrets injection |
| Lyrics | [LRCLIB](https://lrclib.net) + YouTube oEmbed |
| Animation | [Rive](https://rive.app) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` |
| Audio Capture | ScreenCaptureKit (Swift) with process-level filtering |
| Window Transparency | Cocoa NSWindow via `macos-private-api` |

---

## Quick Start

### Prerequisites
- **macOS 14+** (Sonoma or later)
- **Node.js 20+** and **Rust** ([rustup.rs](https://rustup.rs))
- **OpenAI API key** with Realtime API + GPT-4o + GPT-5.4 access

### Install

```bash
brew install steipete/tap/peekaboo

git clone https://github.com/sambuild04/reading-ai-agent.git
cd reading-ai-agent
npm install

swiftc -o src-tauri/helpers/record-audio src-tauri/helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia

echo '{"apiKey": "sk-..."}' > ~/.books-reader.json

# Grant Screen Recording: System Settings → Privacy & Security → Screen Recording → add peekaboo + samuel

npm run tauri:dev
```

Say **"Hey Samuel"** and start talking.

---

## API Costs

| Mode | Cost |
|---|---|
| Wake word (always listening) | ~$0.006/min |
| Ambient teaching (screen + audio) | ~$0.02–0.05/min |
| Plugin code generation | ~$0.001/plugin |
| Voice conversation | Standard Realtime API pricing |

---

## Limitations

- **macOS only** — relies on ScreenCaptureKit, Apple Books integration, Peekaboo
- **GPT-5.4 access** — required for Computer Use navigation
- **Plugin scope** — dynamic plugins can call web APIs only; native macOS capabilities require a rebuild
- **LRCLIB coverage** — not all songs have lyrics; falls back to Whisper transcription

---

## Roadmap

- [ ] Plugin marketplace — share and install community-built plugins
- [ ] Proactive bug detection — Samuel notices tool failures and self-repairs without being asked
- [ ] SRS scheduling for scene flashcards (spaced repetition on real anime clips)
- [ ] Anki export from scene flashcard deck
- [ ] Local on-device wake word (zero-cost, instant activation)
- [ ] iOS / Android companion app
- [ ] Windows + Linux support via cross-platform screen capture
- [ ] Custom AI-generated companion characters via Rive

---

## Contributing

Samuel is a solo project, but the self-modifying agent pattern has unexplored potential. Issues and PRs welcome — especially for new plugin ideas, cross-platform support, and agent architecture improvements.

## License

MIT

---

**Built by [Sam Feng](https://github.com/sambuild04)** — if Samuel interests you, star the repo so others can find it.
