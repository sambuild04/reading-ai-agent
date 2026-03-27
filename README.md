# Samuel — AI Desktop Pet That Watches Anime With You and Teaches You Japanese

> An always-listening, always-watching AI companion that sits on your desktop like a virtual pet. Say "Hey Samuel" and he reads your books aloud, watches anime with you, and teaches you Japanese vocabulary in real time — all by voice conversation. Built with Tauri v2 + OpenAI Realtime API.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange.svg)
![OpenAI](https://img.shields.io/badge/OpenAI-Realtime%20API-412991.svg)

## Demo

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

### Watch Anime, Learn Japanese — Automatically

![Samuel ambient learning — watches anime, teaches Japanese vocabulary from subtitles and audio](docs/samuel-learning-mode.gif)

Samuel floats on your desktop as a transparent animated character. While you watch anime, he **listens to the dialogue and reads the subtitles simultaneously**, then teaches you interesting vocabulary and grammar — without you pressing a single button.

Ask him "what did they just say?" and he answers instantly because he was listening the whole time, just like a tutor sitting next to you.

---

## Why Samuel?

Most language learning apps make you stop what you're doing to study. Samuel is the opposite — he learns **with** you while you do things you already enjoy:

- **Watching anime?** Samuel hears the Japanese dialogue, reads the subtitles, and teaches you new words
- **Browsing the web in English?** Samuel notices interesting words on screen and teaches you how to say them in Japanese
- **Reading a book?** Samuel reads it aloud to you and answers questions about what you just read
- **Just hanging out?** Samuel sits quietly on your desktop until you need him — say "Hey Samuel" anytime

He's not a chatbot in a browser tab. He's a **desktop companion** — always visible, always listening, always ready.

---

## Key Features

### Always-Listening Ambient Agent
Samuel continuously monitors your screen and system audio in the background. Every 20 seconds, he captures what's on screen and transcribes nearby audio — anime dialogue, YouTube videos, podcasts — and silently absorbs it as context. He won't interrupt you unless he spots something genuinely interesting. But when you ask "what was that word?", he knows exactly what you're talking about.

- **Parallel screen + audio monitoring** — both checked every 20 seconds
- **Smart triage engine** — GPT-4o-mini classifies every observation as ignore/notify/act
- **Attention-aware** — stays silent when you're coding in VS Code, Xcode, or Terminal
- **Cross-language teaching** — even English content triggers "do you know how to say X in Japanese?" moments
- **Persistent memory** — tracks vocabulary already taught, avoids repeating itself for 24 hours
- **Process-filtered audio** — captures system audio but excludes Samuel's own voice via ScreenCaptureKit

### Voice-First Desktop Companion
- **"Hey Samuel" wake word** — hands-free activation, just like Siri or Alexa
- **Real-time voice conversation** — OpenAI Realtime API with natural speech-to-speech
- **British butler persona** — polished, helpful, slightly formal ("Yes, sir")
- **Always-on session** — no idle timeout; heartbeat keepalive + auto-reconnect with context preservation
- **Transparent floating window** — sits on top of all apps like a desktop pet (QQ Pet / Bonzi Buddy, but actually useful)
- **Rive character animation** — animated states: idle, listening, thinking, speaking
- **Manga-style speech bubbles** — frosted-glass aesthetic with backdrop blur

### Smart Book Reading (Apple Books)
- **Read any page aloud** — captures the page as an image, reads it via Realtime API
- **Full chapter reading** — automatically turns pages and reads until the next chapter heading
- **Visual navigation** — GPT-5.4 Computer Use sees your screen and clicks through Apple Books UI
- **Follow-up questions** — "What did that paragraph mean?" — answers from memory

### Language Learning Tools
- **Real-time screen translation** — captures your screen, translates all visible foreign text
- **Grammar breakdown** — sentence structure, particles, conjugation, politeness levels
- **Pronunciation coach** — speaks words slowly then naturally, with pitch accent tips
- **Recording mode** — captures system audio from anime/video, then provides full vocabulary + grammar analysis
- **Auto-detect language** — Japanese, Chinese, Korean, Spanish, or any language on screen

### Session Resilience
- **Heartbeat keepalive** — pings every 30s to prevent server-side idle timeout
- **Session rotation** — auto-reconnects every 25 min before the 60-min hard cap
- **Context preservation** — last 6 conversation turns replayed on reconnect
- **Auto-reconnect on drop** — detects unexpected disconnects and recovers in 2 seconds

---

## How It Works

```
You speak → "Hey Samuel" wake word → OpenAI Realtime API → Samuel picks tools → Action executes → Voice response
         ↕                                                    ↕
   Always listening                                  Always watching screen
   (system audio via                                 (GPT-4o Vision every
    ScreenCaptureKit)                                 20s, change detection)
```

Samuel is a voice agent built on OpenAI's Agents SDK (`@openai/agents/realtime`). He listens through your microphone and responds with natural speech. When you ask him to do something, he picks the right tool:

| What you say | What happens |
|---|---|
| "Read this page" | Captures Apple Books page, reads it aloud |
| "Summarize chapter 9" | Reads every page via Vision API until next chapter |
| "Go to chapter 6" | GPT-5.4 Computer Use navigates the app visually |
| "Look at my Chrome" | Captures Chrome window on any monitor |
| "Translate my screen" | Translates all visible foreign text |
| "Explain this grammar" | Breaks down Japanese/Korean/Chinese grammar |
| "How do you say 'cat'?" | Pronounces it in target language |
| "Start recording" | Captures system audio for deep analysis |
| "I'm learning Japanese" | Activates ambient learning mode |
| "What did they just say?" | References ambient audio transcripts to answer |

---

## Architecture

```
src/                          React frontend (Vite + TypeScript)
├── App.tsx                   Main app + wake word flow
├── hooks/
│   ├── useRealtime.ts        Realtime API: heartbeat, reconnect, context replay
│   ├── useWakeWord.ts        "Hey Samuel" detection (Whisper + cross-clip matching)
│   ├── useRecordMode.ts      System audio recording + analysis pipeline
│   └── useLearningMode.ts    Ambient agent: parallel audio+screen, triage, silent context
├── lib/
│   ├── samuel.ts             Agent persona, 15 tools, ambient awareness instructions
│   ├── session-bridge.ts     Bridges: image, text, silent context, recording, learning
│   └── sounds.ts             Audio cues (chime on wake, tone on idle)
├── components/
│   ├── Character.tsx          Rive animation + manga speech bubbles
│   ├── PassiveSuggestion.tsx  Frosted-glass hint card for ambient observations
│   ├── ScreenPicker.tsx       Multi-monitor display selector
│   └── StatusBar.tsx          Connection state display
└── styles/app.css             Transparent window, animations

src-tauri/                    Rust backend (Tauri v2)
├── helpers/
│   └── record-audio.swift    ScreenCaptureKit audio capture with PID filtering
└── src/
    ├── lib.rs                Tauri setup + macOS window transparency (Cocoa)
    ├── commands.rs           Screen capture, Vision API, Computer Use, audio pipeline,
    │                         triage engine, ephemeral keys, display detection
    ├── memory.rs             Persistent memory: vocabulary, transcripts, observations
    └── wake_word.rs          Whisper-based wake word with cross-clip matching
```

### Multi-Model Strategy

| Model | Used for | Speed |
|---|---|---|
| **OpenAI Realtime API** | Voice conversation, page reading, translation, grammar | ~2s |
| **GPT-4o Vision** | Chapter reading, screen scanning, ambient observation | ~3-5s |
| **GPT-4o-mini** | Triage engine (ignore/notify/act classification) | ~1s |
| **GPT-5.4 Computer Use** | Visual navigation (click, scroll, type in Apple Books) | ~5-10s/turn |
| **gpt-4o-mini-transcribe** | Wake word detection, ambient audio transcription | ~1s |
| **gpt-4o-transcribe** | Recording mode (high-quality transcription) | ~3-10s |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Framework | [Tauri v2](https://v2.tauri.app) (Rust + WebView) |
| Frontend | React 19 + Vite + TypeScript |
| Voice AI | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) |
| Agent Framework | [`@openai/agents`](https://github.com/openai/openai-agents-js) (Agents SDK) |
| Vision AI | OpenAI GPT-4o Vision |
| Computer Use | OpenAI GPT-5.4 (Responses API) |
| Character Animation | [Rive](https://rive.app) (`@rive-app/react-canvas`) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` |
| System Audio | ScreenCaptureKit (Swift, with process-level filtering) |
| Window Transparency | Cocoa NSWindow APIs via `macos-private-api` |
| Styling | Tailwind CSS + custom animations |

---

## Quick Start

### Prerequisites
- **macOS 14+** (Sonoma or later)
- **Node.js 20+**
- **Rust** ([rustup.rs](https://rustup.rs))
- **OpenAI API key** with Realtime API + GPT-4o + GPT-5.4 access

### Install

```bash
# 1. Install Peekaboo (screen capture + automation)
brew install steipete/tap/peekaboo

# 2. Clone and install
git clone https://github.com/sambuild04/reading-ai-agent.git
cd reading-ai-agent
npm install

# 3. Compile the audio helper
swiftc -o src-tauri/helpers/record-audio src-tauri/helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia

# 4. Set your API key
echo '{"apiKey": "sk-..."}' > ~/.books-reader.json

# 5. Grant Screen Recording permission
# System Settings → Privacy & Security → Screen Recording → add peekaboo + samuel

# 6. Run
npm run tauri:dev
```

Then say **"Hey Samuel"** and start talking.

---

## Example Conversations

**Reading a book:**
> "Samuel, read this page for me."
> *Samuel captures the Apple Books page, reads it aloud in his British butler voice*
> "What does the author mean by 'antifragile'?"
> *Samuel answers from memory without re-reading*

**Watching anime with learning mode:**
> "I'm learning Japanese."
> *Learning mode activates. Samuel starts monitoring screen + audio.*
> *30 seconds later, while watching:*
> "Sir, I just caught an interesting word — 新たな試み means 'new attempt.' The grammar pattern here uses な to connect the adjective 新た to the noun."
> "What did the character say before that?"
> "From what I overheard, they said 類いを見ない新たな試みが取り入れられている — meaning 'an unprecedented new approach has been adopted.'"

**Browsing the web:**
> *Samuel sees English text about cooking on your screen*
> "Do you know how to say 'recipe' in Japanese, sir? It's レシピ — or the more traditional 料理法."

---

## Planned Features

- **Local wake word** — on-device detection for instant, offline, zero-cost "Hey Samuel"
- **Custom character design** — design your own companion with AI-generated assets + Rive
- **Anki flashcard export** — auto-generate cards from vocabulary discovered during learning
- **iOS/Android companion** — same voice agent on mobile
- **Multi-language simultaneous** — learn Japanese and Korean at the same time

## Limitations

- **macOS only** — relies on Apple Books, Peekaboo, and ScreenCaptureKit
- **DRM content** — protected books may produce black screenshots
- **API costs** — wake word ~$0.006/min; ambient learning ~$0.02-0.05/min (Vision + transcription + triage); book reading ~$0.01/page
- **GPT-5.4** — Computer Use navigation requires GPT-5.4 API access
- **Copyright** — Vision API may refuse to transcribe copyrighted text verbatim

---

## Star History

If you find Samuel useful, please star the repo — it helps others discover the project.

## License

MIT

---

**Built by [Sam Feng](https://github.com/sambuild04)** — a solo project combining OpenAI's latest APIs into something that feels like magic.
