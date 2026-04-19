# Screen Voice Agent — open-source desktop AI agent that watches your screen, listens to audio, and teaches languages by voice

An always-on voice AI assistant for macOS that uses GPT-4o Vision to see your screen, OpenAI Realtime API for natural voice conversation, and writes its own tools at runtime. Built with Tauri v2, React, and TypeScript. MIT licensed.

**Use cases:** ambient language learning (Japanese, Korean, Spanish), live meeting interpretation, real-time anime/video translation, hands-free desktop assistance, AI tutoring while watching content.

Internally, the agent answers to **"Hey Samuel."**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange.svg)
![OpenAI Realtime API](https://img.shields.io/badge/OpenAI-Realtime%20Voice-412991.svg)

> **TL;DR:** Say "Hey Samuel" and talk. He sees your screen, hears your audio, remembers everything, and writes his own tools when he needs new capabilities.

---

## See It In Action

Samuel interprets Japanese news in realtime — watching the screen and listening to audio simultaneously:

https://github.com/user-attachments/assets/36fdd220-e1af-443a-99d3-31803160625c

Ambient teaching while watching anime — vocab cards, scene clip flashcards, and voice explanations:

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

https://github.com/user-attachments/assets/338f8194-49e6-496d-b218-715af4afa1ee

---

## What Makes Samuel Different

### Self-Modifying — Writes Its Own Tools at Runtime

Most AI agents have a fixed tool set. Samuel doesn't.

```
You:     "Hey Samuel, add a weather tool"
Samuel:  "I'll create a tool that fetches weather from wttr.in. [Approve] [Reject]"
You:     *clicks Approve*
Samuel:  *generates code → writes to disk → hot-loads into live session*
Samuel:  "Done. What's the weather in Tokyo?"
```

No rebuild. No restart. The new tool is live in the same voice conversation. If a plugin breaks, Samuel reads the error, proposes a fix, and rewrites it — with your approval.

### Always Watching, Always Listening

Samuel runs a continuous perception loop in the background:

- **Screen** — captures via GPT-4o Vision every 20s with smart change detection
- **Audio** — transcribes system audio via ScreenCaptureKit with PID-level filtering (excludes his own voice)
- **Context injection** — feeds observations silently into the conversation so he always knows what's happening

Ask "what did they just say?" or "what's on my screen?" at any point — he already knows.

### Remembers Everything

Three types of persistent local memory:

| Type | Example | Effect |
|---|---|---|
| **Preferences** | "Be more concise" | Applied every session |
| **Corrections** | "That explanation was wrong" | Never repeated |
| **Facts** | "I'm intermediate at Japanese" | Adjusts behavior permanently |

Say "I already know that word" — permanently suppressed. Say "be more direct" — communication style changes from that session forward. All memory is local, auditable, and editable.

### Voice-Controlled Everything

Samuel is his own settings panel. No menus, no preferences screen:

| You say | What happens |
|---|---|
| "Make yourself smaller" | Avatar shrinks |
| "Make the font bigger" | Speech bubble text grows |
| "Show me word cards while I watch" | Switches to auto vocab card mode |
| "Cards every 20 seconds" | Adjusts card frequency |
| "Only show cards when I ask" | Switches back to manual mode |
| "Hide the romaji" | Annotations hidden |
| "Reset the UI" | All visual settings restored |

---

## Core Features

### Recording Mode — Your AI Audience

Record any audio (meetings, lectures, videos) and ask Samuel anything about the transcript:

```
You:     "Hey Samuel, start recording"
         *attends a meeting*
You:     "Stop recording"
Samuel:  "Transcript ready. What would you like me to do with it?"
You:     "Summarize the key decisions"
         or "Find anything about pricing"
         or "Did anyone say something incorrect about our API?"
         or "Break down the Japanese grammar"
         or "What were the action items?"
```

One recording. Any question. Samuel holds the full transcript and applies his reasoning to whatever you ask — no hardcoded analysis pipeline.

### Web Browsing — Search and Read Like a Human

Samuel can search the internet and read web pages on his own:

```
You:     "Search for the lyrics of 冷たく暗い by Aimer"
Samuel:  *searches DuckDuckGo → finds lyrics page → reads it → shows lyrics in floating panel*

You:     "Look up the N3 grammar point ～ようにする"
Samuel:  *searches → reads a grammar explanation site → teaches you with examples*

You:     "What's the weather API endpoint for wttr.in?"
Samuel:  *searches → reads the docs → tells you*
```

Not limited to language learning — Samuel can find anything a human can Google. Lyrics, documentation, articles, definitions.

### Song Teaching Mode

Drop a YouTube link into the chat box and Samuel becomes a music tutor:

1. Downloads audio via `yt-dlp`, searches the internet for lyrics (lyrics.ovh + LRCLIB + Genius, falls back to Whisper)
2. You say "play the first 3 lines" — original audio plays, mic auto-mutes
3. Audio finishes → mic unmutes → Samuel explains the vocabulary and grammar
4. Lyrics display in a floating HUD panel — tap any line to play that segment
5. Fully conversational — ask "what does that word mean?", "play it again", "skip to the chorus"

### Chat Box — Drop Anything, Ask Anything

Tap the chat icon below Samuel's avatar to type or paste content with your own question:

- **Text + question** → paste `冷たく暗い 光を湛えた眼` and type "what is this?" → Samuel explains
- **YouTube link** → song teaching mode with audio playback + lyrics
- **Article URL** → extracts text, annotates vocabulary and grammar
- **Image / manga** → OCR + breakdown
- **API key** → Samuel asks what it's for and stores it securely
- **Any message** → just chat via text instead of voice

### Privacy Controls

Settings button (top-right corner) lets you directly toggle:
- **Screen watching** — whether Samuel observes your screen for language hints
- **Audio listening** — whether Samuel hears ambient audio for learning

### Ambient Language Assistance

Set your learning language once ("I'm learning Japanese") and Samuel assists in the background — forever:

- **Manual mode** (default) — ask Samuel to explain any word; he shows a vocabulary card via `show_word_card`
- **Auto mode** — say "show me cards while I watch" and Samuel periodically reviews what he hears/sees, picking out interesting words based on your proficiency level
- **Cross-language hints** — say "tell me the Japanese for any English words you hear" and he does that too
- **Frequency control** — "cards every 30 seconds" / "less often" / "stop auto cards"

All driven by Samuel's own judgment, not rigid rules. He knows your level, what you've already learned, and what's worth highlighting.

### Scene Clip Flashcards

When Samuel spots a word, a vocab card appears. Tap "Save it" — he saves the actual 20-second audio clip plus a screenshot. Flashcards aren't text — they're real scenes with the original voice actor's delivery.

---

## Architecture

```
"Hey Samuel" → Wake word → OpenAI Realtime API → 20+ tools → Voice response
                                    ↕
         Screen capture (GPT-4o Vision, change detection, every 20s)
         System audio (ScreenCaptureKit, PID-level filtering)
         Ambient context → silent injection OR periodic Samuel review
         Plugin system: propose → approve → generate → hot-load
         Song playback: yt-dlp → local audio → HTML5 <audio> with seek
         Recording: Whisper transcribe → raw transcript → user-directed analysis
         Secrets store: ~/.samuel/secrets.json (local)
         Personality memory: preferences + corrections + facts
         Scene clip flashcards: audio + screenshot per word
```

### Models

| Model | Purpose | Latency |
|---|---|---|
| OpenAI Realtime API | Voice conversation, all interactive features | ~500ms |
| GPT-4o Vision | Screen scanning, ambient observation | ~3–5s |
| GPT-4o-mini | Annotation, plugin code generation | ~1s |
| gpt-4o-transcribe | Recording transcription (high-fidelity) | ~3–10s |
| whisper-1 | Song segmentation with timestamps | ~3–5s |

### Key Tools Samuel Has

| Tool | What it does |
|---|---|
| `observe_screen` | Captures and analyzes what's on screen |
| `start/stop_recording` | System audio capture + transcription |
| `teach_from_content` | Analyzes any dropped content for learning |
| `play_song_lines` / `pause_song` | Controls song audio playback |
| `show_word_card` | Displays a vocabulary card on demand |
| `set_card_mode` | Toggles manual/auto vocab card behavior |
| `remember_preference` | Stores persistent user preferences |
| `record_correction` | Stores behavioral corrections |
| `mark_vocabulary_known` | Permanently suppresses known words |
| `update_ui` | Changes visual settings by voice |
| `web_search` / `web_read` | Searches the internet and reads web pages |
| `show_lyrics` | Displays lyrics/text in the floating HUD panel |
| `propose_plugin` / `write_plugin` | Self-modification pipeline |
| `store_secret` | Saves API keys for plugins |
| `pronounce` | Speaks correct pronunciation |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | [Tauri v2](https://v2.tauri.app) (Rust + WebView) |
| Frontend | React 19 + Vite + TypeScript |
| Voice | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) (WebRTC) |
| Agent Framework | [@openai/agents](https://github.com/openai/openai-agents-js) |
| Vision | GPT-4o Vision |
| Plugin Runtime | `new Function()` + secrets injection |
| Song Audio | [yt-dlp](https://github.com/yt-dlp/yt-dlp) + HTML5 Audio |
| Lyrics | [lyrics.ovh](https://lyrics.ovh) + [LRCLIB](https://lrclib.net) + [Genius](https://genius.com) |
| Web Browsing | DuckDuckGo (search) + curl (page reading) |
| Animation | [Rive](https://rive.app) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` |
| Audio Capture | ScreenCaptureKit (Swift), PID-level filtering |

---

## Quick Start

### Prerequisites

- macOS 14+ (Sonoma or later)
- Node.js 20+ and Rust ([rustup.rs](https://rustup.rs))
- OpenAI API key with Realtime API + GPT-4o access
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp`) for song features

### Install

```bash
brew install steipete/tap/peekaboo yt-dlp
git clone https://github.com/sambuild04/reading-ai-agent.git
cd reading-ai-agent
npm install
swiftc -o src-tauri/helpers/record-audio src-tauri/helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia
echo '{"apiKey": "sk-..."}' > ~/.books-reader.json
```

Grant Screen Recording permission: **System Settings → Privacy & Security → Screen Recording** → add Peekaboo + Samuel.

```bash
npm run tauri:dev
```

Say **"Hey Samuel"** and start talking.

---

## API Costs

| Mode | Approx. cost |
|---|---|
| Wake word (always listening) | ~$0.006/min |
| Ambient assistance (screen + audio) | ~$0.02–0.05/min |
| Auto card mode (Samuel review) | ~$0.01/review cycle |
| Plugin code generation | ~$0.001/plugin |
| Voice conversation | Standard Realtime API pricing |

---

## Limitations

- **macOS only** — depends on ScreenCaptureKit, Peekaboo, and macOS APIs
- **Plugins are not OS-sandboxed** — `new Function()` has full JS access; the approval flow is the current security boundary
- **Dynamic plugins are JS only** — new native capabilities (Swift/Rust) still require a rebuild
- **Lyrics coverage** — Genius provides accurate text for most songs; LRCLIB adds timestamps; Whisper is the final fallback
- **Always-on costs** — ambient mode runs continuously; costs accumulate while active

---

## Roadmap

- [ ] Plugin marketplace — share and install community plugins
- [ ] General monitoring mode — "watch this meeting and flag errors" as a first-class feature
- [ ] SRS scheduling for scene flashcards (spaced repetition on real clips)
- [ ] Anki export
- [ ] OS-level sandboxing for dynamic plugins
- [ ] Local on-device wake word (zero API cost)
- [ ] Windows + Linux support
- [ ] iOS / Android companion app

---

## How It Compares

| Tool | Voice | Screen Vision | Audio Listening | Self-Modifying | Open Source |
|---|---|---|---|---|---|
| **Screen Voice Agent** | Yes | Yes | Yes | Yes | Yes (MIT) |
| Granola | No | No | Yes | No | No |
| Cluely | No | Yes | Yes | No | No |
| Otter.ai | No | No | Yes | No | No |
| ChatGPT Voice | Yes | Partial | No | No | No |

---

## FAQ

**What is this project?**
Screen Voice Agent is an open-source macOS desktop AI agent that continuously sees your screen and hears your audio, lets you talk to it via voice, and can write its own new tools at runtime without rebuilding.

**What can I use it for?**
Common uses include learning a language while watching anime or YouTube, having an AI explain what's happening in a meeting in real time, asking questions about content on your screen without screenshotting, searching the web for lyrics or information by voice, and having a hands-free coding or writing assistant.

**How is this different from Granola, Cluely, or Otter?**
Granola and Otter are meeting-transcription tools. Cluely is an exam/interview overlay. This agent is an always-on companion that combines screen vision, audio listening, voice conversation, persistent memory, and runtime self-modification — designed for ambient assistance, not single-purpose tasks.

**What models does it use?**
OpenAI Realtime API for voice, GPT-4o Vision for screen capture analysis, GPT-4o-mini for annotations, Whisper for transcription.

**Is it free?**
The code is MIT-licensed and free. You pay OpenAI API costs directly — typically $0.02-0.05/min when ambient features are active.

**Does it work on Windows or Linux?**
Currently macOS only. Windows and Linux are on the roadmap.

**What does "self-modifying" mean?**
You can ask the agent to add a new capability ("add a weather tool") and it generates the code, asks for your approval, and hot-loads it into the running session. No rebuild required.

**Is my data private?**
Screen captures and audio are sent to OpenAI's APIs for processing. Memory, preferences, and secrets are stored locally in `~/.samuel/`. Nothing is sent to third-party servers besides OpenAI.

---

## Contributing

Issues and PRs welcome — especially for plugin ideas, new tool capabilities, and cross-platform support.

## License

MIT

---

**Built by [Sam Feng](https://github.com/sambuild04)**
