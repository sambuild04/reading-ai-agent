# Samuel — A Desktop AI That Writes Its Own Tools at Runtime

A voice-first AI agent that lives on your desktop, watches your screen, hears your audio, and can extend itself with new capabilities on demand — without a rebuild or restart.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange.svg)
![OpenAI Realtime API](https://img.shields.io/badge/OpenAI-Realtime%20Voice-412991.svg)

---

## The Core Idea

Most AI agents have a fixed tool set compiled in at build time. Samuel doesn't.

```
You:     "Hey Samuel, add a weather tool"
Samuel:  "I'll create a tool that fetches weather from wttr.in. [Approve] [Reject]"
You:     *clicks Approve*
Samuel:  *generates code via GPT-4o-mini → writes to disk → hot-loads into live session*
Samuel:  "Done, sir. The weather tool is ready."
You:     "What's the weather in Tokyo?"
Samuel:  "Currently 18°C and partly cloudy in Tokyo, sir."
```

No rebuild. No restart. The new tool is live in the same voice conversation.

If a plugin breaks, Samuel reads the error, proposes a fix, and rewrites it after your approval. Previous versions are backed up automatically.

---

## See It In Action

Samuel interprets Japanese news in realtime — watching the screen and listening to audio simultaneously:

https://github.com/user-attachments/assets/36fdd220-e1af-443a-99d3-31803160625c

Ambient teaching while watching anime — vocab cards, scene clip flashcards, and voice explanations:

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

https://github.com/user-attachments/assets/338f8194-49e6-496d-b218-715af4afa1ee

---

## How Self-Modification Works

1. **`propose_plugin`** — Samuel describes what he'll build. A card appears with Approve / Reject buttons.
2. **User approves** — via button click or by saying "yes" / "go ahead."
3. **`write_plugin`** — GPT-4o-mini generates the code → saved to `~/.samuel/plugins/` → executed via `new Function()` → agent hot-swapped with `session.updateAgent()`.
4. **Immediately usable** — the new tool is live in the current Realtime API session.

Plugins are JavaScript async functions. They can call any web API via `fetch()` and access stored credentials via `secrets.get("key_name")`. Anything expressible as an async function works: weather APIs, timers, RSS feeds, Wikipedia, currency conversion, translation services, push notifications, and more.

**Note on sandboxing:** Plugins run via `new Function()` — they are not sandboxed at the OS level. The user-approval flow (Approve / Reject card before any code is generated or run) is the current security model. Native macOS sandboxing for plugins is on the roadmap.

---

## Persistent Memory

Samuel stores three types of memory locally in `~/.samuel/memory.json`:

| Type | Example | Effect |
|---|---|---|
| **Preferences** | "Be more concise" | Applied every session |
| **Corrections** | "That explanation was wrong" | Never repeated |
| **Facts** | "I'm intermediate at Japanese" | Adjusts behavior permanently |

Say "I already know that word" — Samuel permanently suppresses it. Say "be more direct" — his communication style changes from that session forward. All memory is local, auditable, and editable.

---

## Always Watching, Always Listening

Samuel runs a continuous perception loop:

- **Screen** — captures via GPT-4o Vision every 20 seconds, with change detection (skips identical frames)
- **Audio** — transcribes system audio via ScreenCaptureKit with PID-level filtering, excluding Samuel's own voice output
- **Triage** — a three-way classifier (ignore / surface / act) decides whether each observation warrants interruption

He absorbs context silently. Ask "what did they just say?" or "what's on my screen?" at any point — he already knows.

---

## Language Teaching (The Original Use Case)

Samuel started as an ambient language tutor and it remains his strongest skill set.

### Ambient Voice Teaching

You're watching anime. Samuel sees the subtitles, hears the dialogue, and speaks: *"食べる — 'to eat', sir."* You don't press anything. You don't look away. He just tells you.

### "Teach Me From This" — Drop Anything

Drop content into Samuel's input envelope (the icon near his avatar):

- **YouTube link** → fetches synced lyrics via LRCLIB (no download), annotates vocabulary, embeds the player
- **Article URL** → extracts readable text, annotates interesting words
- **Image / manga screenshot** → OCR (right-to-left aware) + vocabulary breakdown
- **PDF** → text extraction + grammar highlights
- **Raw text** → immediate breakdown

One pipeline. Every content type produces the same annotated viewer — tappable words, grammar labels, and on-demand voice explanations.

### Scene Clip Flashcards

When Samuel spots a word, a vocab card appears. Tap "Save it" and he saves the actual 20-second audio clip from the video plus a screenshot of that moment. Flashcards aren't text — they're real scenes with the original voice actor's delivery. Review by replaying the exact moment you first heard the word.

### Any Language

Japanese, Chinese, Korean, Spanish, French, German, Portuguese, Arabic, Russian, Thai, Vietnamese, Hindi. Say "I'm learning [language]" and everything adapts.

---

## Voice-Controlled UI

Samuel is his own settings panel:

| Voice command | Effect |
|---|---|
| "Make yourself smaller" | Avatar shrinks |
| "Make the font bigger" | Speech bubble text grows |
| "Hide the romaji" | Furigana annotations hidden |
| "Show cards less often" | Vocab card frequency reduced |
| "Reset the UI" | All visual settings restored |

Changes persist across sessions. No menus, no preferences panel.

---

## Architecture

```
You speak → "Hey Samuel" wake word → OpenAI Realtime API → 20+ tools → Voice response
                                              ↕
               Screen capture (GPT-4o Vision, change detection, every 20s)
               System audio (ScreenCaptureKit, PID-level filtering)
               Triage engine: ignore / surface / act
               Plugin system: propose → approve → generate → hot-load
               Secrets store: ~/.samuel/secrets.json (local)
               Rolling context injection (replaces stale, not accumulating)
               Personality memory: preferences + corrections + facts
               Scene clip flashcards: audio + screenshot per word
               Content pipeline: YouTube / article / image / PDF → annotated viewer
```

### Models

| Model | Purpose | Latency |
|---|---|---|
| OpenAI Realtime API | Voice conversation, teaching | ~500ms |
| GPT-4o Vision | Screen scanning, ambient observation | ~3–5s |
| GPT-4o-mini | Triage, annotation, plugin code generation | ~1s |
| GPT-5.4 Computer Use | Visual UI navigation (Apple Books etc.) | ~5–10s/turn |
| gpt-4o-mini-transcribe | Wake word + ambient audio | ~1s |
| gpt-4o-transcribe | Recording mode (high-fidelity) | ~3–10s |

### File Structure

```
src/
├── hooks/
│   ├── useRealtime.ts        Voice session: heartbeat, reconnect, plugin loading
│   ├── useWakeWord.ts        "Hey Samuel" fuzzy wake word via Whisper
│   ├── useLearningMode.ts    Ambient loop: screen + audio + triage
│   ├── useTeachMode.ts       "Teach me from this" state machine
│   └── useUIPreferences.ts   Voice-controlled UI state
├── lib/
│   ├── samuel.ts             Agent: 20+ tools, self-modification, memory, persona
│   ├── plugin-loader.ts      Dynamic loader: new Function() + secrets injection
│   ├── session-bridge.ts     Bridges: image, context, plugins, UI, secrets
│   └── lyrics.ts             YouTube oEmbed + LRCLIB lyrics pipeline
└── components/
    ├── Character.tsx          Rive animation + speech bubbles + input envelope
    ├── PluginApproval.tsx     Approve / Reject card for proposed plugins
    ├── PassiveSuggestion.tsx  Vocab cards with voice dismiss
    ├── FlashcardDeck.tsx      Scene clip review panel
    └── TeachViewer.tsx        Annotated content viewer + YouTube embed

src-tauri/src/
├── commands.rs               Screen capture, Vision, triage, audio
├── plugins.rs                Plugin CRUD + GPT-4o-mini code generation
├── secrets.rs                Local secrets store
├── flashcards.rs             Scene clip persistence
├── memory.rs                 Persistent memory
├── teach.rs                  Content extraction + annotation pipeline
└── wake_word.rs              Whisper transcription
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | [Tauri v2](https://v2.tauri.app) (Rust + WebView) |
| Frontend | React 19 + Vite + TypeScript |
| Voice | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) (WebRTC) |
| Agent Framework | [@openai/agents](https://github.com/openai/openai-agents-js) |
| Vision | GPT-4o Vision |
| Computer Use | GPT-5.4 Responses API |
| Plugin Runtime | `new Function()` + secrets injection |
| Lyrics | [LRCLIB](https://lrclib.net) + YouTube oEmbed |
| Animation | [Rive](https://rive.app) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` |
| Audio Capture | ScreenCaptureKit (Swift), PID-level filtering |
| Window Transparency | Cocoa NSWindow via `macos-private-api` |

---

## Quick Start

### Prerequisites

- macOS 14+ (Sonoma or later)
- Node.js 20+ and Rust ([rustup.rs](https://rustup.rs))
- OpenAI API key with Realtime API + GPT-4o + GPT-5.4 access

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

| Mode | Approx. cost |
|---|---|
| Wake word (always listening) | ~$0.006/min |
| Ambient teaching (screen + audio + triage) | ~$0.02–0.05/min |
| Plugin code generation | ~$0.001/plugin |
| Voice conversation | Standard Realtime API pricing |

---

## Limitations

- **macOS only** — depends on ScreenCaptureKit, Peekaboo, and Apple Books integration
- **GPT-5.4 access required** for Computer Use (Apple Books navigation)
- **Plugins are not OS-sandboxed** — `new Function()` has full JS access; the approval flow is the current security boundary
- **Dynamic plugins are JS only** — new native macOS capabilities (Swift/Rust) still require a rebuild
- **LRCLIB coverage** — not all songs have synced lyrics; Whisper transcription is the fallback
- **Always-on costs** — ambient mode runs continuously; costs accumulate while active

---

## Roadmap

- [ ] Plugin marketplace — share and install community plugins
- [ ] Proactive bug detection — Samuel notices tool failures and proposes self-repairs unprompted
- [ ] OS-level sandboxing for dynamic plugins
- [ ] SRS scheduling for scene flashcards (spaced repetition on real clips)
- [ ] Anki export
- [ ] Local on-device wake word (zero API cost)
- [ ] Windows + Linux support via cross-platform screen capture
- [ ] iOS / Android companion app

---

## Contributing

Samuel is a solo project. The runtime self-modification pattern is underexplored — issues and PRs welcome, especially for plugin ideas, sandboxing approaches, and cross-platform support.

## License

MIT

---

**Built by [Sam Feng](https://github.com/sambuild04)**
