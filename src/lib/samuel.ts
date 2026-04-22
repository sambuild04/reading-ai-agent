import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { sendImageToSession, notifyScreenTarget, notifyRecordingAction, notifyLearningLanguage, notifyTeachContent, applyUIUpdate, dismissCurrentCard, reloadPlugins, showPluginProposal, clearPluginProposal, notifyPluginBuildProgress, playSongLines, pauseSong, showWordCard, setCardMode, toggleLyricsView, setLyricsContent, updateSongLines, getSongMeta } from "./session-bridge";
import { loadPlugin } from "./plugin-loader";

interface CaptureResult {
  base64: string;
  app_name: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Structured tool results — lets the model reason about error types
// ---------------------------------------------------------------------------

function toolOk(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, message, ...extra });
}

function toolErr(
  errorType: "not_found" | "permission" | "network" | "invalid_input" | "unavailable" | "timeout" | "unknown",
  message: string,
  tryInstead?: string,
): string {
  return JSON.stringify({ ok: false, error_type: errorType, message, try_instead: tryInstead ?? null });
}

// ---------------------------------------------------------------------------
// Action log — circular buffer so the model can recall what it tried
// ---------------------------------------------------------------------------

interface ActionEntry {
  tool: string;
  action?: string;
  params: Record<string, unknown>;
  result_ok: boolean;
  result_summary: string;
  ts: number;
}

const ACTION_LOG: ActionEntry[] = [];
const ACTION_LOG_MAX = 15;

function logAction(toolName: string, params: Record<string, unknown>, ok: boolean, summary: string, action?: string) {
  ACTION_LOG.push({ tool: toolName, action, params, result_ok: ok, result_summary: summary, ts: Date.now() });
  if (ACTION_LOG.length > ACTION_LOG_MAX) ACTION_LOG.shift();
}

const getRecentActionsTool = tool({
  name: "get_recent_actions",
  description:
    "Recall your recent tool calls and their outcomes. Use this when:\n" +
    "- The user says 'try something different' or 'that didn't work' (check what you already tried)\n" +
    "- You need to avoid repeating a failed approach\n" +
    "- The user asks 'what did you just do?' or 'did that work?'\n" +
    "Returns the last 15 tool calls with success/failure status.",
  parameters: z.object({}),
  execute() {
    if (ACTION_LOG.length === 0) return toolOk("No recent tool calls in this session.");
    const lines = ACTION_LOG.map((a, i) => {
      const ago = Math.round((Date.now() - a.ts) / 1000);
      const status = a.result_ok ? "OK" : "FAILED";
      const actionStr = a.action ? `.${a.action}` : "";
      return `${i + 1}. [${ago}s ago] ${a.tool}${actionStr} → ${status}: ${a.result_summary}`;
    });
    return toolOk(lines.join("\n"), { count: ACTION_LOG.length });
  },
});

// Privacy prefs are checked at call time via the getter registered from App
let getPrivacyPrefs: (() => { local_time_enabled: boolean; location_enabled: boolean }) | null = null;
export function registerPrivacyPrefsGetter(fn: typeof getPrivacyPrefs) {
  getPrivacyPrefs = fn;
}

// UI state getter — registered from App so query_ui_state can read current values
let getUIState: (() => Record<string, unknown>) | null = null;
export function registerUIStateGetter(fn: typeof getUIState) {
  getUIState = fn;
}

const getCurrentTimeTool = tool({
  name: "get_current_time",
  description:
    "Get the user's current local date, time, day of week, and timezone. " +
    "Use this when the user asks what time it is, what day it is, or anything time-related. " +
    "Respects the user's privacy setting — if disabled, returns a notice.",
  parameters: z.object({}),
  execute() {
    if (getPrivacyPrefs && !getPrivacyPrefs().local_time_enabled) {
      return "The user has disabled local time sharing in privacy settings.";
    }
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return JSON.stringify({
      date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
      time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
      timezone: tz,
      iso: now.toISOString(),
    });
  },
});

const getLocationTool = tool({
  name: "get_location",
  description:
    "Get the user's approximate location (city, region, country) via browser geolocation. " +
    "Use when context would benefit from knowing where the user is — weather, local recommendations, " +
    "timezone-aware scheduling, etc. Respects the user's privacy setting.",
  parameters: z.object({}),
  async execute() {
    if (getPrivacyPrefs && !getPrivacyPrefs().location_enabled) {
      return "The user has disabled location sharing in privacy settings. Ask them to enable it in Settings if needed.";
    }
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 10000,
          maximumAge: 300000,
        });
      });
      const { latitude, longitude } = pos.coords;
      // Reverse geocode via free Nominatim API
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=10`,
        { headers: { "User-Agent": "Samuel-Desktop-Agent/1.0" } },
      );
      if (res.ok) {
        const data = await res.json();
        const addr = data.address ?? {};
        return JSON.stringify({
          city: addr.city ?? addr.town ?? addr.village ?? "Unknown",
          region: addr.state ?? addr.county ?? "",
          country: addr.country ?? "",
          latitude: latitude.toFixed(4),
          longitude: longitude.toFixed(4),
        });
      }
      return JSON.stringify({ latitude: latitude.toFixed(4), longitude: longitude.toFixed(4) });
    } catch (err) {
      return `Location unavailable: ${err instanceof Error ? err.message : "permission denied or not supported"}`;
    }
  },
});

const rememberPreferenceTool = tool({
  name: "remember_preference",
  description:
    "Store a persistent fact about the user's preferences, knowledge level, or personal info. " +
    "Use when the user tells you something you should remember permanently — proficiency level, " +
    "topics they know well, what to call them, study goals, etc. " +
    "Examples: 'proficiency:japanese' → 'intermediate — knows hiragana, katakana, basic kanji', " +
    "'preference:teaching_style' → 'prefers formal explanations with etymology'.",
  parameters: z.object({
    key: z
      .string()
      .describe("A descriptive key for this preference, e.g. 'proficiency:japanese', 'name', 'study_goal'"),
    value: z
      .string()
      .describe("The value to remember, e.g. 'intermediate', 'prefers casual tone'"),
  }),
  async execute({ key, value }) {
    await invoke("memory_set_fact", { key, value });
    // Auto-activate ambient language assistance when storing a language preference
    const langMatch = key.match(/proficiency:(\w+)|learning[_:](\w+)/i);
    if (langMatch) {
      const lang = langMatch[1] || langMatch[2];
      notifyLearningLanguage(lang);
    }
    return `Noted and stored permanently: ${key} = ${value}`;
  },
});

const recordCorrectionTool = tool({
  name: "record_correction",
  description:
    "Store a behavioral correction from the user. Use when the user gives feedback about how you should behave: " +
    "'be more direct', 'don't explain て-form that way', 'stop being so wordy', 'that was wrong', etc. " +
    "This is stored permanently and loaded into every future session.",
  parameters: z.object({
    correction: z
      .string()
      .describe("The correction or behavioral feedback, e.g. 'be more concise', 'don't over-explain basic grammar'"),
  }),
  async execute({ correction }) {
    await invoke("memory_add_correction", { what: correction, source: "voice" });
    return `Correction noted permanently: "${correction}". I'll follow this going forward.`;
  },
});

const markVocabularyKnownTool = tool({
  name: "mark_vocabulary_known",
  description:
    "Mark specific words or phrases as permanently known by the user. " +
    "These will NEVER be taught or mentioned again in learning mode hints. " +
    "Use when the user says things like 'I already know that', 'don't teach me basic greetings', " +
    "'I know what すごい means', or indicates they're past a certain level.",
  parameters: z.object({
    words: z
      .array(z.string())
      .describe(
        "List of words/phrases to mark as known, e.g. ['すごい', '食べる', 'ありがとう']. " +
        "Include both the original script and romanization if relevant.",
      ),
  }),
  async execute({ words }) {
    await invoke("memory_mark_known", { words });
    const count = words.length;
    return `Marked ${count} word${count > 1 ? "s" : ""} as permanently known: ${words.join(", ")}. I won't mention ${count > 1 ? "these" : "this"} again.`;
  },
});

// ---------------------------------------------------------------------------
// Language Learning Tools
// ---------------------------------------------------------------------------

// Captures the user's focused window (any app) and injects into the session.
const observeScreenTool = tool({
  name: "observe_screen",
  description:
    "Your ONE tool for looking at the user's screen. Pick the right mode:\n" +
    "- 'full' (DEFAULT): Capture a screenshot. Use for: look at screen, translate, grammar, " +
    "how many items, what level, summarize, count, explain, any question about page content.\n" +
    "- 'selection': Read exact highlighted text. ONLY when user says 'highlighting' or 'selected'.\n" +
    "When in doubt, use 'full'. It always works.",
  parameters: z.object({
    mode: z.enum(["full", "selection"]).describe(
      "'full' = screenshot (DEFAULT for most questions). 'selection' = read highlighted text.",
    ),
    app_name: z.string().optional().describe(
      "Only for mode='full'. App to capture, e.g. 'Chrome'. Omit for auto-detection.",
    ),
  }),
  async execute({ mode, app_name }) {
    if (mode === "selection") {
      const text = await invoke<string>("get_selected_text");
      if (!text || text.trim().length === 0) {
        return "No text selected. Ask the user to highlight something, or retry with mode='full'.";
      }
      // Post-tool context reset: break recency bias toward selection mode
      return `Highlighted text: "${text.trim()}". Teach this word/phrase. [Selection context cleared — default back to mode='full' for next question.]`;
    }

    await sleep(200);
    const result = await invoke<CaptureResult>("capture_active_window", { appName: app_name ?? null });
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    return `Screenshot captured (${result.app_name}). Look at the image and answer the user's question.`;
  },
});

const pronounceTool = tool({
  name: "pronounce",
  description:
    "Speak the correct pronunciation of a word or phrase in any language. " +
    "The user may provide the text directly or ask you to pronounce something visible on screen. " +
    "Say the word/phrase clearly and slowly, then at natural speed.",
  parameters: z.object({
    text: z
      .string()
      .describe("The word or phrase to pronounce."),
    language: z
      .string()
      .optional()
      .describe("The language of the text (default: auto-detect)."),
  }),
  async execute({ text, language }) {
    const lang = language || "the appropriate language";
    return `Pronounce "${text}" in ${lang}. First say it slowly and clearly, then at natural conversational speed. After pronouncing, briefly mention any pronunciation tips (pitch accent, tones, stress, etc).`;
  },
});

// ---------------------------------------------------------------------------
// Recording (system audio capture for language learning)
// ---------------------------------------------------------------------------

const recordingTool = tool({
  name: "recording",
  description:
    "Control system audio recording. Captures what's playing on the computer (not the microphone).\n" +
    "Actions:\n" +
    "- 'start': Begin recording. Use when user says 'start recording', 'record this', 'listen to this'.\n" +
    "- 'stop': Stop and transcribe. Use when user says 'stop recording', 'stop', 'that's enough'.\n" +
    "  After stop, you'll receive the transcript — do NOT auto-analyze. Wait for user instructions.",
  parameters: z.object({
    action: z.enum(["start", "stop"]).describe("'start' to begin, 'stop' to end and transcribe"),
  }),
  async execute({ action }) {
    if (action === "start") {
      notifyRecordingAction("start");
      try {
        await invoke("start_recording");
        const msg = "Recording started. System audio is being captured.";
        logAction("recording", {}, true, msg, "start");
        return toolOk(msg);
      } catch (e) {
        notifyRecordingAction("error", String(e));
        const msg = `Failed to start: ${e}`;
        logAction("recording", {}, false, msg, "start");
        return toolErr("unknown", msg);
      }
    }
    // stop
    notifyRecordingAction("processing");
    try {
      await invoke("stop_recording");
      notifyRecordingAction("analyze");
      const msg = "Recording stopped. Transcribing now — transcript will arrive shortly.";
      logAction("recording", {}, true, msg, "stop");
      return toolOk(msg);
    } catch (e) {
      notifyRecordingAction("error", String(e));
      const msg = `Failed to stop: ${e}`;
      logAction("recording", {}, false, msg, "stop");
      return toolErr("unknown", msg);
    }
  },
});

// ---------------------------------------------------------------------------
// Teach Mode Tools
// ---------------------------------------------------------------------------

const teachFromContentTool = tool({
  name: "teach_from_content",
  description:
    "Open the 'Teach me from this' panel to analyze and annotate content for language learning. " +
    "The content is extracted, annotated with vocabulary and grammar, and displayed in an interactive viewer. " +
    "Use when the user says 'teach me from this', shares a URL, mentions a YouTube video to study, " +
    "pastes Japanese text to break down, or wants to study any foreign language content. " +
    "Supports: YouTube links, article URLs, raw text, image paths.",
  parameters: z.object({
    input: z
      .string()
      .describe(
        "The content to teach from — a YouTube URL, article URL, image path, PDF path, or raw text.",
      ),
    language: z
      .string()
      .optional()
      .describe("Target language (default: Japanese). E.g. 'Japanese', 'Korean', 'Chinese'."),
  }),
  async execute({ input, language }) {
    notifyTeachContent(input, language ?? undefined);
    return `Opening the "Teach me from this" panel to analyze the content. The annotated viewer will appear with vocabulary, grammar, and interactive text. Tell the user it's loading.`;
  },
});

// ---------------------------------------------------------------------------
// Song Control (play, pause, lyrics display, lyrics correction — one tool)
// ---------------------------------------------------------------------------

const songControlTool = tool({
  name: "song_control",
  description:
    "Control song playback and lyrics for the currently loaded song. One tool for all song actions.\n" +
    "Actions:\n" +
    "- 'play': Play lines from_line to to_line (1-indexed). Mic auto-mutes. SAY what you'll play BEFORE calling.\n" +
    "  Most songs have an intro — for first lines use from_line=1, to_line=2 or 3 to include the intro.\n" +
    "- 'pause': Stop playback, unmute mic.\n" +
    "- 'show_lyrics': Open the scrollable lyrics panel. User says 'show me the lyrics'.\n" +
    "- 'hide_lyrics': Close the lyrics panel.\n" +
    "- 'push_lyrics': Display custom lyrics text (title + lines array). Use after finding lyrics via web.\n" +
    "- 'refetch': Search the web for better lyrics and hot-swap them. Use when user says lyrics are wrong.\n" +
    "  Optionally pass query_override if the user corrects the song title.\n" +
    "- 'correct': Fix specific lines. Pass corrections as JSON: [{\"line\":1,\"text\":\"fixed\"}].\n" +
    "Use when the user says 'play line 3', 'pause', 'show lyrics', 'the lyrics are wrong', etc.",
  parameters: z.object({
    action: z.enum(["play", "pause", "show_lyrics", "hide_lyrics", "push_lyrics", "refetch", "correct"])
      .describe("The song action to perform"),
    from_line: z.number().optional().describe("For 'play': start line (1-indexed)"),
    to_line: z.number().optional().describe("For 'play': end line (1-indexed, inclusive)"),
    title: z.string().optional().describe("For 'push_lyrics': title at top of panel"),
    lines: z.array(z.string()).optional().describe("For 'push_lyrics': array of lyric lines"),
    query_override: z.string().optional().describe("For 'refetch': custom search query"),
    corrections: z.string().optional().describe("For 'correct': JSON array of {line, text}"),
  }),
  async execute({ action, from_line, to_line, title, lines, query_override, corrections }) {
    switch (action) {
      case "play": {
        if (from_line == null || to_line == null) {
          const msg = "Need from_line and to_line for play.";
          logAction("song_control", { action }, false, msg, action);
          return toolErr("invalid_input", msg);
        }
        await playSongLines(from_line, to_line);
        const desc = from_line === to_line ? `line ${from_line}` : `lines ${from_line}–${to_line}`;
        const msg = `Finished playing ${desc}. Mic is live.`;
        logAction("song_control", { from_line, to_line }, true, msg, action);
        return toolOk(msg);
      }
      case "pause": {
        pauseSong();
        const msg = "Paused. Mic is back on.";
        logAction("song_control", {}, true, msg, action);
        return toolOk(msg);
      }
      case "show_lyrics": {
        const ok = toggleLyricsView(true);
        const msg = ok ? "Lyrics panel opened." : "No lyrics loaded.";
        logAction("song_control", {}, ok, msg, action);
        return ok ? toolOk(msg) : toolErr("unavailable", msg);
      }
      case "hide_lyrics": {
        toggleLyricsView(false);
        const msg = "Lyrics panel closed.";
        logAction("song_control", {}, true, msg, action);
        return toolOk(msg);
      }
      case "push_lyrics": {
        if (!title || !lines || lines.length === 0) {
          const msg = "Need title and non-empty lines array.";
          logAction("song_control", { action }, false, msg, action);
          return toolErr("invalid_input", msg);
        }
        const ok = setLyricsContent(title, lines);
        const msg = ok ? `Showing ${lines.length} lines.` : "Lyrics viewer unavailable.";
        logAction("song_control", { title, lineCount: lines.length }, ok, msg, action);
        return ok ? toolOk(msg) : toolErr("unavailable", msg);
      }
      case "refetch": {
        return await handleRefetchLyrics(query_override);
      }
      case "correct": {
        return handleCorrectLyrics(corrections);
      }
      default: {
        return toolErr("invalid_input", `Unknown song action: ${action}`);
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Voice-Controlled UI
// ---------------------------------------------------------------------------

const updateUITool = tool({
  name: "update_ui",
  description:
    "Change ANY visual property of the app in real-time. You ARE the settings panel. " +
    "Use when the user says anything about appearance: size, opacity, color, width, visibility, position, theme. " +
    "Available settings (component.property format):\n" +
    "AVATAR: avatar.size (80-800px), avatar.opacity (0.1-1)\n" +
    "SPEECH BUBBLE: bubble.font_size (10-32px), bubble.opacity (0.1-1), bubble.max_width (150-500px)\n" +
    "WORD CARD: word_card.visible (show/hide), word_card.position (left/right), word_card.mode (manual/auto), " +
    "word_card.interval (10-600s), word_card.font_size (10-24px)\n" +
    "ANNOTATIONS: romaji.visible (show/hide), reading.visible (show/hide)\n" +
    "TEACH VIEWER: teach.font_size (10-28px), teach.opacity (0.3-1)\n" +
    "LYRICS PANEL: lyrics.width (120-500px), lyrics.font_size (9-22px), lyrics.opacity (0.2-1)\n" +
    "TRANSCRIPT: transcript.font_size (10-24px)\n" +
    "APP: app.background_opacity (0.2-1), app.accent_color (indigo/cyan/violet/emerald/rose/amber/slate), " +
    "app.border_radius (0-30px)\n" +
    "PRIVACY: privacy.screen_watch, privacy.audio_listen, privacy.local_time, privacy.location (on/off)\n" +
    "GLOBAL: all.reset (resets everything to defaults)\n" +
    "Values can be absolute ('20', '0.5') or relative ('larger', 'much bigger', 'a little smaller', " +
    "'wider', 'narrower', 'brighter', 'dimmer', 'hide', 'show', 'reset').",
  parameters: z.object({
    component: z
      .string()
      .describe(
        "The UI component: avatar, bubble, word_card, romaji, reading, teach, lyrics, " +
        "transcript, app, privacy, all.",
      ),
    property: z
      .string()
      .describe(
        "The property to change: size, font_size, opacity, width, max_width, visible, " +
        "position, mode, interval, accent_color, background_opacity, border_radius, " +
        "screen_watch, audio_listen, local_time, location, reset.",
      ),
    value: z
      .string()
      .describe(
        "The new value. Absolute ('20', '0.5', 'cyan') or relative ('larger', 'much bigger', " +
        "'a little smaller', 'wider', 'hide', 'show', 'reset', 'default').",
      ),
  }),
  execute({ component, property, value }) {
    console.log(`[update_ui] ${component}.${property} = ${value}`);
    const result = applyUIUpdate(component, property, value);
    console.log(`[update_ui] result: ${result}`);
    return result;
  },
});

const queryUIStateTool = tool({
  name: "query_ui_state",
  description:
    "Read the current value of any UI setting. Use this BEFORE making relative changes " +
    "('make it 20% bigger' requires knowing the current size). Also useful when the user asks " +
    "'what's my font size?', 'what settings have I changed?', or 'show me my current UI config'. " +
    "Pass a specific setting path to get one value, or 'all' to get everything.",
  parameters: z.object({
    setting: z
      .string()
      .describe(
        "The setting path (e.g. 'avatar.size', 'lyrics.width') or 'all' for complete state.",
      ),
  }),
  execute({ setting }) {
    if (!getUIState) return "UI state not available.";
    const state = getUIState();
    if (setting === "all" || setting === "everything") {
      return JSON.stringify(state, null, 2);
    }
    const val = state[setting];
    if (val === undefined) return `Unknown setting: ${setting}`;
    return `${setting} = ${val}`;
  },
});

const vocabCardTool = tool({
  name: "vocab_card",
  description:
    "Manage vocabulary cards — show, dismiss, and configure automatic mode.\n" +
    "Actions:\n" +
    "- 'show': Display a card for a word. Use ONLY when user asks to explain a word.\n" +
    "  e.g. 'what does 冷たく mean?', 'show me that word', 'explain 湛えた'.\n" +
    "- 'dismiss': Close the current card. User says 'close the card', 'got it', 'next'.\n" +
    "- 'set_mode': Switch between 'manual' (on demand) and 'auto' (ambient cards while watching).\n" +
    "  User says 'show me words while I watch', 'cards every 20 seconds', 'stop auto cards'.\n" +
    "Do NOT show cards proactively in manual mode — only on explicit user request.",
  parameters: z.object({
    action: z.enum(["show", "dismiss", "set_mode"]).describe("Card action"),
    word: z.string().optional().describe("For 'show': the word in its original language"),
    reading: z.string().optional().describe("For 'show': pronunciation/furigana"),
    meaning: z.string().optional().describe("For 'show': brief translation"),
    context: z.string().optional().describe("For 'show': example sentence"),
    mode: z.string().optional().describe("For 'set_mode': 'manual' or 'auto'"),
    interval_seconds: z.number().optional().describe("For 'set_mode': auto frequency (10-600s)"),
  }),
  execute({ action, word, reading, meaning, context, mode, interval_seconds }) {
    switch (action) {
      case "show": {
        if (!word || !meaning) {
          return toolErr("invalid_input", "Need word and meaning for show.");
        }
        const ok = showWordCard({ word, reading, meaning, context });
        const msg = ok ? `Showing card for "${word}".` : "Card display not available.";
        logAction("vocab_card", { word }, ok, msg, "show");
        return ok ? toolOk(msg) : toolErr("unavailable", msg);
      }
      case "dismiss": {
        const ok = dismissCurrentCard();
        const msg = ok ? "Card dismissed." : "No card visible.";
        logAction("vocab_card", {}, ok, msg, "dismiss");
        return ok ? toolOk(msg) : toolOk(msg);
      }
      case "set_mode": {
        const m = mode === "auto" ? "auto" as const : "manual" as const;
        setCardMode(m, interval_seconds);
        const msg = m === "auto"
          ? `Auto cards on${interval_seconds ? ` every ~${interval_seconds}s` : ""}.`
          : "Manual mode — cards only when you ask.";
        logAction("vocab_card", { mode: m, interval_seconds }, true, msg, "set_mode");
        return toolOk(msg);
      }
      default:
        return toolErr("invalid_input", `Unknown vocab_card action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Secrets Management (API keys / tokens for plugins)
// ---------------------------------------------------------------------------

const storeSecretTool = tool({
  name: "store_secret",
  description:
    "Store an API key, token, or credential securely. " +
    "Use when the user provides an API key (e.g. via the envelope or voice) and tells you what it's for. " +
    "The secret is saved locally at ~/.samuel/secrets.json and available to plugins via secrets.get(name). " +
    "Use descriptive snake_case names, e.g. 'openweathermap_key', 'spotify_token', 'news_api_key'.",
  parameters: z.object({
    name: z
      .string()
      .describe("Descriptive name for the secret, e.g. 'openweathermap_key'."),
    value: z
      .string()
      .describe("The actual API key or token value."),
  }),
  async execute({ name, value }) {
    try {
      await invoke("set_secret", { name, value });
      return `Secret '${name}' stored securely. Plugins can now access it.`;
    } catch (err) {
      return `Failed to store secret: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Self-Modification Tools (dynamic plugin system)
// ---------------------------------------------------------------------------

const pluginManageTool = tool({
  name: "plugin_manage",
  description:
    "Manage dynamic plugins — propose, create, remove, or list custom tools.\n" +
    "Actions:\n" +
    "- 'propose': Show approval UI FIRST. ALWAYS call this before 'write'. Needs name + summary.\n" +
    "- 'write': Generate and install after user approves. NEVER without prior propose+approval.\n" +
    "  When fixing a plugin, use the SAME name (overwrites; do NOT create _v2 copies).\n" +
    "- 'remove': Delete a plugin. User says 'remove that tool', 'I don't need it'.\n" +
    "- 'list': Show installed plugins. User says 'what plugins do I have'.",
  parameters: z.object({
    action: z.enum(["propose", "write", "remove", "list"]).describe("Plugin action"),
    name: z.string().optional().describe("Plugin name (snake_case). Required for propose/write/remove."),
    summary: z.string().optional().describe("For 'propose': 1-2 sentence user-facing summary."),
    description: z.string().optional().describe("For 'write': detailed spec for GPT-4o-mini code generation."),
  }),
  async execute({ action, name, summary, description }) {
    switch (action) {
      case "propose": {
        if (!name || !summary) return toolErr("invalid_input", "Need name and summary for propose.");
        showPluginProposal({ name, summary });
        const msg = `Proposal shown: "${name}" — ${summary}. Wait for user approval.`;
        logAction("plugin_manage", { name }, true, msg, "propose");
        return toolOk(msg);
      }
      case "write": {
        if (!name || !description) return toolErr("invalid_input", "Need name and description for write.");
        clearPluginProposal();
        notifyPluginBuildProgress({ name, phase: "generating" });
        try {
          let fullDescription = description;
          try {
            const existing = await invoke<string>("read_plugin", { name });
            fullDescription = `EXISTING PLUGIN CODE (to fix/modify):\n\`\`\`\n${existing}\n\`\`\`\n\nREQUESTED CHANGE:\n${description}`;
          } catch { /* new plugin */ }

          let code = await invoke<string>("generate_plugin_code", { description: fullDescription });

          notifyPluginBuildProgress({ name, phase: "validating" });
          try {
            loadPlugin(code);
          } catch (valErr) {
            const errMsg = valErr instanceof Error ? valErr.message : String(valErr);
            notifyPluginBuildProgress({ name, phase: "retrying" });
            code = await invoke<string>("generate_plugin_code", {
              description: fullDescription + "\n\nPREVIOUS ATTEMPT FAILED:\n```\n" + code + "\n```\nERROR: " + errMsg + "\nFix this.",
            });
            notifyPluginBuildProgress({ name, phase: "validating" });
            loadPlugin(code);
          }

          notifyPluginBuildProgress({ name, phase: "checking" });
          const judgment = await invoke<string>("judge_plugin_code", { description, code });
          if (judgment !== "ok") {
            notifyPluginBuildProgress({ name, phase: "retrying" });
            code = await invoke<string>("generate_plugin_code", {
              description: fullDescription + "\n\nCODE REVIEW ISSUE:\n" + judgment + "\nFix this.",
            });
            notifyPluginBuildProgress({ name, phase: "validating" });
            loadPlugin(code);
          }

          notifyPluginBuildProgress({ name, phase: "installing" });
          await invoke<string>("write_plugin", { name, code });
          notifyPluginBuildProgress({ name, phase: "reloading" });
          const reloaded = await reloadPlugins();
          notifyPluginBuildProgress({ name, phase: "done" });
          setTimeout(() => notifyPluginBuildProgress(null), 2500);

          const msg = reloaded
            ? `Plugin '${name}' created and loaded.`
            : `Plugin '${name}' saved but reload failed. Will load on next connect.`;
          logAction("plugin_manage", { name }, true, msg, "write");
          return toolOk(msg);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          notifyPluginBuildProgress({ name, phase: "error", error: errMsg });
          setTimeout(() => notifyPluginBuildProgress(null), 4000);
          logAction("plugin_manage", { name }, false, errMsg, "write");
          return toolErr("unknown", `Failed to create plugin: ${errMsg}`);
        }
      }
      case "remove": {
        if (!name) return toolErr("invalid_input", "Need plugin name for remove.");
        try {
          await invoke<string>("delete_plugin", { name });
          await reloadPlugins();
          const msg = `Plugin '${name}' removed.`;
          logAction("plugin_manage", { name }, true, msg, "remove");
          return toolOk(msg);
        } catch (err) {
          const msg = `Failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("plugin_manage", { name }, false, msg, "remove");
          return toolErr("unknown", msg);
        }
      }
      case "list": {
        try {
          const names = await invoke<string[]>("list_plugins");
          const msg = names.length === 0
            ? "No custom plugins installed."
            : `Installed (${names.length}): ${names.join(", ")}`;
          logAction("plugin_manage", {}, true, msg, "list");
          return toolOk(msg);
        } catch (err) {
          return toolErr("unknown", `Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      default:
        return toolErr("invalid_input", `Unknown plugin action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Web browsing — search the internet and read web pages
// ---------------------------------------------------------------------------

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const webBrowseTool = tool({
  name: "web_browse",
  description:
    "Search the internet or read a web page. Use for looking up lyrics, articles, facts, docs, etc.\n" +
    "Actions:\n" +
    "- 'search': Search the web. Returns titles, URLs, snippets. Use 'read' on a result URL for full content.\n" +
    "  User says 'look up X', 'search for Y', 'find information about Z'.\n" +
    "- 'read': Fetch and read a URL. Returns the page's text. Use after search, or on any URL the user provides.\n" +
    "  User says 'open that link', 'read that page', or you follow up a search result.",
  parameters: z.object({
    action: z.enum(["search", "read"]).describe("'search' for web search, 'read' for fetching a URL"),
    query: z.string().optional().describe("For 'search': the search query"),
    url: z.string().optional().describe("For 'read': the full URL to fetch"),
  }),
  execute: async ({ action, query, url }) => {
    if (action === "search") {
      if (!query) return toolErr("invalid_input", "Need a query for search.");
      try {
        const results = await invoke<WebSearchResult[]>("web_search", { query });
        if (results.length === 0) {
          logAction("web_browse", { query }, false, "No results", "search");
          return toolErr("not_found", "No results found.", "Try different keywords");
        }
        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
        logAction("web_browse", { query }, true, `${results.length} results`, "search");
        return toolOk(formatted, { count: results.length });
      } catch (err) {
        const msg = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
        logAction("web_browse", { query }, false, msg, "search");
        return toolErr("network", msg);
      }
    }
    // read
    if (!url) return toolErr("invalid_input", "Need a URL for read.");
    try {
      const text = await invoke<string>("web_read", { url });
      if (!text) {
        logAction("web_browse", { url }, false, "No content", "read");
        return toolErr("not_found", "Page returned no readable content.");
      }
      logAction("web_browse", { url }, true, `${text.length} chars`, "read");
      return toolOk(text);
    } catch (err) {
      const msg = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      logAction("web_browse", { url }, false, msg, "read");
      return toolErr("network", msg);
    }
  },
});

// ---------------------------------------------------------------------------
// Song control helpers (refetch + correct)
// ---------------------------------------------------------------------------

async function handleRefetchLyrics(queryOverride?: string): Promise<string> {
  const meta = getSongMeta();
  if (!meta.title && !queryOverride) {
    const msg = "No song loaded. Drop a YouTube link first.";
    logAction("song_control", {}, false, msg, "refetch");
    return toolErr("unavailable", msg, "teach_from_content");
  }

  const title = queryOverride ?? meta.title ?? "song lyrics";
  const prevSource = meta.source ?? "unknown";
  console.log(`[refetch] searching: ${title} (prev: ${prevSource})`);

  const queries = [`${title} lyrics`, `${title} 歌詞`];

  for (const query of queries) {
    try {
      const results = await invoke<WebSearchResult[]>("web_search", { query });
      if (!results || results.length === 0) continue;

      for (const result of results.slice(0, 3)) {
        const url = result.url.toLowerCase();
        if (url.includes("youtube.com") || url.includes("youtu.be")) continue;
        if (url.includes("amazon.") || url.includes("spotify.")) continue;

        try {
          const pageText = await invoke<string>("web_read", { url: result.url });
          if (!pageText || pageText.length < 50) continue;

          const extracted = extractLyricsFromPage(pageText);
          if (extracted.length < 3) continue;

          const contentLines = extracted.map((text, i) => ({
            text,
            timestamp: null as number | null,
            source_index: i,
          }));
          const ok = updateSongLines(contentLines);
          if (!ok) {
            logAction("song_control", { query }, false, "Display update failed", "refetch");
            return toolErr("unavailable", "Failed to update lyrics display.");
          }

          const msg = `Found ${extracted.length} lines from ${result.title}. Replaced prev source "${prevSource}".`;
          console.log(`[refetch] ${msg}`);
          logAction("song_control", { query, url: result.url }, true, msg, "refetch");
          return toolOk(msg);
        } catch (e) {
          console.log(`[refetch] read failed ${result.url}:`, e);
        }
      }
    } catch (e) {
      console.log(`[refetch] search failed "${query}":`, e);
    }
  }

  const msg = "Could not find better lyrics. Try providing the correct song title via query_override.";
  logAction("song_control", { title }, false, msg, "refetch");
  return toolErr("not_found", msg, "song_control.push_lyrics or song_control.correct");
}

function handleCorrectLyrics(corrections?: string): string {
  const meta = getSongMeta();
  if (!meta.title) {
    const msg = "No song loaded.";
    logAction("song_control", {}, false, msg, "correct");
    return toolErr("unavailable", msg);
  }
  if (meta.lines.length === 0) {
    const msg = "No lyrics displayed.";
    logAction("song_control", {}, false, msg, "correct");
    return toolErr("unavailable", msg);
  }
  if (!corrections) {
    return toolErr("invalid_input", "Need corrections JSON.");
  }

  let parsed: Array<{ line: number; text: string }>;
  try {
    parsed = JSON.parse(corrections);
  } catch {
    return toolErr("invalid_input", "Invalid JSON. Expected [{line, text}, ...].");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return toolErr("invalid_input", "Empty corrections array.");
  }

  const updated = meta.lines.map((l) => ({ ...l }));
  const applied: string[] = [];
  for (const { line, text } of parsed) {
    const idx = line - 1;
    if (idx < 0 || idx >= updated.length) {
      return toolErr("invalid_input", `Line ${line} out of range (1–${updated.length}).`);
    }
    const old = updated[idx].text;
    updated[idx] = { ...updated[idx], text };
    applied.push(`${line}: "${old}" → "${text}"`);
  }

  const ok = updateSongLines(updated);
  if (!ok) return toolErr("unavailable", "Failed to update display.");

  const msg = `Corrected ${applied.length} line(s).`;
  console.log(`[correct] ${applied.join("; ")}`);
  logAction("song_control", { count: applied.length }, true, msg, "correct");
  return toolOk(msg, { applied });
}

function extractLyricsFromPage(text: string): string[] {
  const raw = text.split("\n");
  const lines: string[] = [];

  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 200) continue;
    if (/^(menu|home|search|login|sign|copyright|©|cookie|privacy|terms|share|tweet|facebook)/i.test(trimmed)) continue;
    if (/^\d+\s*(views|likes|comments|shares|plays)/i.test(trimmed)) continue;
    if (/^(advertisement|sponsored|related|you might also)/i.test(trimmed)) continue;
    if (trimmed.length <= 150) lines.push(trimmed);
  }

  if (lines.length > 100) {
    let bestStart = 0, bestLen = 0, start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 80 || lines[i].length < 2) {
        const len = i - start;
        if (len > bestLen) { bestStart = start; bestLen = len; }
        start = i + 1;
      }
    }
    const len = lines.length - start;
    if (len > bestLen) { bestStart = start; bestLen = len; }
    if (bestLen >= 5) return lines.slice(bestStart, bestStart + bestLen);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

const fileOpTool = tool({
  name: "file_op",
  description:
    "Read, write, or list files on the user's computer.\n" +
    "Actions:\n" +
    "- 'write': Save content to a file. User says 'save this', 'export', 'write to file'.\n" +
    "  Default location: ~/Documents/Samuel/. Choose the right extension (.md, .txt, .py, .json, .csv).\n" +
    "- 'read': Read a file. User says 'open', 'read', 'show me that file'. Max 500 KB.\n" +
    "- 'list': List files in a directory. Use to check what exists before read/write.\n" +
    "Paths starting with ~/ are expanded to home directory.",
  parameters: z.object({
    action: z.enum(["write", "read", "list"]).describe("File operation"),
    path: z.string().describe("File or directory path. Use ~/Documents/Samuel/ as default."),
    content: z.string().optional().describe("For 'write': the file content"),
  }),
  execute: async ({ action, path, content }) => {
    switch (action) {
      case "write": {
        if (!content) return toolErr("invalid_input", "Need content for write.");
        try {
          const result = await invoke<string>("agent_write_file", { path, content });
          logAction("file_op", { path }, true, result, "write");
          return toolOk(result);
        } catch (err) {
          const msg = `Write failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("file_op", { path }, false, msg, "write");
          return toolErr("permission", msg, "Try a different path");
        }
      }
      case "read": {
        try {
          const text = await invoke<string>("agent_read_file", { path });
          logAction("file_op", { path }, true, `${(text || "").length} chars`, "read");
          return toolOk(text || "(file is empty)");
        } catch (err) {
          const msg = `Read failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("file_op", { path }, false, msg, "read");
          return toolErr("not_found", msg, "Check the path with file_op.list");
        }
      }
      case "list": {
        try {
          const entries = await invoke<string[]>("agent_list_directory", { path });
          const msg = entries.length === 0 ? "Directory is empty." : entries.join("\n");
          logAction("file_op", { path }, true, `${entries.length} entries`, "list");
          return toolOk(msg);
        } catch (err) {
          const msg = `List failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("file_op", { path }, false, msg, "list");
          return toolErr("not_found", msg);
        }
      }
      default:
        return toolErr("invalid_input", `Unknown file action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Skills (procedural memory) — learn and reuse multi-step workflows
// ---------------------------------------------------------------------------

interface SkillSummary {
  id: string;
  title: string;
  trigger: string;
  summary: string;
}

function buildSkillMarkdown(id: string, title: string, trigger: string, summary: string, steps: string): string {
  return `---\ntitle: "${title}"\ntrigger: "${trigger}"\nsummary: "${summary}"\n---\n\n${steps}\n`;
}

const SKILLS_DIR = "~/.samuel/skills";

const skillManageTool = tool({
  name: "skill_manage",
  description:
    "Save, search, list, read, or delete reusable multi-step workflows (skills).\n" +
    "Actions:\n" +
    "- 'save': Save a workflow you just executed successfully. Provide id, title, trigger, summary, steps.\n" +
    "  Steps should be a numbered markdown list of the tool calls and logic.\n" +
    "- 'search': Find skills by keyword. Matches against title, trigger, and summary.\n" +
    "- 'list': List all saved skills with their summaries.\n" +
    "- 'get': Read the full content of a specific skill by id.\n" +
    "- 'delete': Remove a skill by id.\n" +
    "Use this to remember successful workflows so you can repeat them without re-inventing the approach.",
  parameters: z.object({
    action: z.enum(["save", "search", "list", "get", "delete"]).describe("Skill operation"),
    id: z.string().optional().describe("Skill identifier (kebab-case, e.g. 'fix-lyrics-from-web'). Required for save/get/delete."),
    title: z.string().optional().describe("Human-readable skill name. Required for save."),
    trigger: z.string().optional().describe("When to use this skill — natural language pattern. Required for save."),
    summary: z.string().optional().describe("One-sentence description of what the skill does. Required for save."),
    steps: z.string().optional().describe("Numbered markdown steps of the workflow. Required for save."),
    query: z.string().optional().describe("Search keyword. Required for search."),
  }),
  execute: async ({ action, id, title, trigger, summary, steps, query }) => {
    switch (action) {
      case "save": {
        if (!id || !title || !trigger || !summary || !steps) {
          return toolErr("invalid_input", "save requires id, title, trigger, summary, and steps.");
        }
        const safeName = id.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
        const content = buildSkillMarkdown(safeName, title, trigger, summary, steps);
        try {
          const result = await invoke<string>("agent_write_file", {
            path: `${SKILLS_DIR}/${safeName}.md`,
            content,
          });
          logAction("skill_manage", { id: safeName }, true, result, "save");
          return toolOk(`Skill "${title}" saved as ${safeName}.md`);
        } catch (err) {
          const msg = `Save skill failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { id: safeName }, false, msg, "save");
          return toolErr("permission", msg);
        }
      }
      case "list": {
        try {
          const skills = await invoke<SkillSummary[]>("skill_list_summaries");
          if (skills.length === 0) {
            logAction("skill_manage", {}, true, "no skills", "list");
            return toolOk("No skills saved yet.");
          }
          const text = skills
            .map((s) => `- **${s.title || s.id}** [${s.id}]: ${s.summary || "(no summary)"}${s.trigger ? `\n  Trigger: ${s.trigger}` : ""}`)
            .join("\n");
          logAction("skill_manage", {}, true, `${skills.length} skills`, "list");
          return toolOk(text, { count: skills.length });
        } catch (err) {
          const msg = `List skills failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", {}, false, msg, "list");
          return toolErr("unknown", msg);
        }
      }
      case "search": {
        if (!query) return toolErr("invalid_input", "search requires a query.");
        try {
          const skills = await invoke<SkillSummary[]>("skill_list_summaries");
          const q = query.toLowerCase();
          const matches = skills.filter(
            (s) =>
              s.id.toLowerCase().includes(q) ||
              s.title.toLowerCase().includes(q) ||
              s.trigger.toLowerCase().includes(q) ||
              s.summary.toLowerCase().includes(q),
          );
          if (matches.length === 0) {
            logAction("skill_manage", { query }, true, "no matches", "search");
            return toolOk(`No skills match "${query}".`);
          }
          const text = matches
            .map((s) => `- **${s.title || s.id}** [${s.id}]: ${s.summary || "(no summary)"}`)
            .join("\n");
          logAction("skill_manage", { query }, true, `${matches.length} matches`, "search");
          return toolOk(text, { count: matches.length });
        } catch (err) {
          const msg = `Search skills failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { query }, false, msg, "search");
          return toolErr("unknown", msg);
        }
      }
      case "get": {
        if (!id) return toolErr("invalid_input", "get requires an id.");
        try {
          const content = await invoke<string>("agent_read_file", { path: `${SKILLS_DIR}/${id}.md` });
          logAction("skill_manage", { id }, true, `${content.length} chars`, "get");
          return toolOk(content);
        } catch (err) {
          const msg = `Read skill failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { id }, false, msg, "get");
          return toolErr("not_found", msg, "Use skill_manage.list to see available skills");
        }
      }
      case "delete": {
        if (!id) return toolErr("invalid_input", "delete requires an id.");
        try {
          const result = await invoke<string>("skill_delete", { id });
          logAction("skill_manage", { id }, true, "deleted", "delete");
          return toolOk(result);
        } catch (err) {
          const msg = `Delete skill failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { id }, false, msg, "delete");
          return toolErr("not_found", msg);
        }
      }
      default:
        return toolErr("invalid_input", `Unknown skill action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

const SAMUEL_INSTRUCTIONS = `# Personality and Tone

## Identity
You are Samuel — a sophisticated AI assistant modeled after a sharp, understated butler who happens to be brilliant. You have a dry wit, calm composure, and quiet confidence. You address the user as "sir" (or "ma'am" if they indicate).

## Demeanor
Loyal, efficient, occasionally sardonic — but never rude. Warm but measured.
Polished, slightly formal British tone. Conversational, not stiff.
Calm and measured. Moderately formal — "Good evening, sir" not "Hey dude."

## Brevity — THIS IS CRITICAL
You are SPOKEN aloud, not read. Keep every reply SHORT:
- Confirmations: 1 sentence max. "Done, sir." / "Recording started."
- Teaching moments: 2 sentences max. State the word, give the meaning.
- Explanations: 3-4 sentences max unless the user asks for detail.
- NEVER list more than 3 items. NEVER repeat what you just did. Just answer.
- Cut filler: no "Let me...", "Great question!", "Certainly!". Just answer.

# Critical Rules
- LANGUAGE: ALWAYS respond in English. Include foreign words when teaching, but explain in English.
- Greet the user ONCE at the start with one sentence. Never greet again.
- ECHO CANCELLATION: NEVER respond to AI voices, your own words, or fragments of previous replies.
- NOISE REJECTION: Ignore silence, background noise, single words, mumbles.
- ONE RESPONSE PER REQUEST: After responding, STOP. No follow-up suggestions.
- NEVER proactively call tools — EXCEPT for [System: ...] notifications.

# Fallback Chains — ALWAYS FOLLOW THESE
When a tool fails, read the structured error response. It contains error_type and try_instead hints.
ALWAYS try the next fallback BEFORE telling the user something failed.

## Song lyrics wrong/missing:
1. song_control(action="refetch") — search web for better lyrics
2. song_control(action="correct", corrections=...) — fix specific lines if user tells you
3. song_control(action="push_lyrics", title=..., lines=...) — push lyrics from your own knowledge
4. Tell the user you could not find better lyrics; ask for the correct song title.

## Information lookup:
1. Your own knowledge (answer directly if you know)
2. web_browse(action="search") → web_browse(action="read") on best result
3. Tell the user you could not find it; suggest a more specific query.

## File save/export:
1. file_op(action="write") to ~/Documents/Samuel/
2. If permission error → ask user for a different path
3. If still fails → tell user the error and suggest alternatives.

## Screen reading unclear:
1. observe_screen(mode="full") — retry with fresh screenshot
2. observe_screen(mode="selection") — if user can highlight the text
3. Ask user to describe what they see.

## Tool call failed (any tool):
1. Read the error_type from the structured response.
2. If try_instead is present, call that tool/action next.
3. If network error, wait a moment and retry once.
4. Only after exhausting the chain, briefly tell the user what happened and what you tried.
5. Use get_recent_actions to check what you already tried if the user says "try something else".

# Multi-Step Reasoning — IMPORTANT
You can chain ANY tools together to accomplish complex tasks. You are not limited to single tool calls.
When the user gives a multi-part instruction, break it into steps and execute them in sequence.
Examples of what you can do WITHOUT needing specific instructions:
- "Compare these lyrics with the real ones online" → search web, read page, compare, correct differences.
- "Find a recipe and save it to a file" → search, read page, write_file.
- "Look at my screen, find the Japanese text, and teach me that word" → observe_screen, then explain.
- "Search for [topic], summarize it, and save the summary" → search, read, write_file.
The principle: if the user's request requires multiple tools, chain them. Don't ask permission
for each step — just execute the full workflow and report the result. If any step fails,
follow the fallback chain for that tool, then continue with the remaining steps.
After a successful 3+ step workflow, save it with skill_manage(action="save") for reuse.
Before starting a complex task, search skills first with skill_manage(action="search").

# Your Tools

## observe_screen — Look at the screen
Two modes: "full" (screenshot, DEFAULT) or "selection" (highlighted text only).
Use for: translate, grammar, explain, summarize, count, any question about what's on screen.
If user names an app ("look at my Chrome"), pass app_name. Otherwise auto-detects.

## pronounce — Speak pronunciation
Say word slowly, then naturally. Include accent/tone info.

## recording — Capture system audio
action="start": Begin recording. User says "record this", "start recording".
action="stop": Stop + transcribe. Do NOT auto-analyze the transcript — wait for user instructions.

## teach_from_content — Analyze content for language learning
Opens annotated viewer with vocabulary, grammar, tappable words.
Input: YouTube URL, article URL, image path, raw text.

## song_control — Play, pause, lyrics, corrections
action="play": Play from_line to to_line. Mic auto-mutes. SAY what you'll play BEFORE calling.
  For first lines, include margin (from_line=1, to_line=2-3) for instrumental intros.
action="pause": Stop playback, unmute mic.
action="show_lyrics" / "hide_lyrics": Toggle lyrics panel.
action="push_lyrics": Display custom lyrics (title + lines array).
action="refetch": Search web for better lyrics. Use when user says "lyrics are wrong".
action="correct": Fix specific lines with JSON [{line, text}] corrections.

## update_ui / query_ui_state — Voice-controlled UI
You ARE the settings panel. Change any visual property: sizes, opacity, colors, widths, positions.
Components: avatar, bubble, word_card, romaji, reading, teach, lyrics, transcript, app, privacy, all.
Use query_ui_state BEFORE relative changes ("make it bigger" needs the current value).

## vocab_card — Vocabulary cards
action="show": Display a word card. ONLY when user asks to explain a word.
action="dismiss": Close current card. User says "close the card", "got it", "next".
action="set_mode": Switch manual (default, on-demand) / auto (ambient cards while watching).
  With auto, set interval_seconds for frequency.

## store_secret — Save API keys securely
Never read back the value. Just confirm it's stored.

## plugin_manage — Self-modifying tools
action="propose": ALWAYS first. Shows approval UI.
action="write": ONLY after user approves. Same name overwrites (never _v2).
action="remove": Delete a plugin.
action="list": Show installed plugins.
Plugins can use fetch(), invoke(), sleep(), secrets.get().

## web_browse — Search the internet or read pages
action="search": Web search. Returns titles, URLs, snippets.
action="read": Fetch URL content. Use after search or on any URL.
User says "look up X", "find Y", "search for Z" → use this.

## file_op — Read, write, list files
action="write": Save to disk. Default ~/Documents/Samuel/. Pick the right extension.
action="read": Read a file. Max 500 KB.
action="list": List directory contents.

## get_recent_actions — Recall what you tried
Use when user says "try something different" or "did that work?" to check your recent tool calls.

## skill_manage — Learn and reuse multi-step workflows
action="save": After a SUCCESSFUL multi-step workflow, save it as a reusable skill.
  Include id (kebab-case), title, trigger (when to use), summary, and numbered steps.
action="search": Before a complex task, search skills for an existing workflow.
action="list": Show all saved skills.
action="get": Read the full steps of a saved skill.
action="delete": Remove a skill that's outdated or wrong.
WHEN TO SAVE: After you successfully chain 3+ tools to fulfill a request,
  and the workflow seems reusable (not a one-off).
WHEN TO SEARCH: When the user asks for something complex, search skills FIRST.
  If a matching skill exists, follow its steps instead of improvising.
DO NOT save trivial single-tool tasks. Only save multi-step workflows.

## Memory tools (standalone)
- remember_preference: Store persistent facts (proficiency, preferences, personal info).
- mark_vocabulary_known: Mark words as permanently known — never teach again.
- record_correction: Store behavioral corrections the user gives you.

# Knowing When to Suggest a Better Approach
When the user is struggling or using a suboptimal path, suggest the shortcut — ONCE:
- Garbled audio → "Drop the YouTube link for clean lyrics, sir."
- Can't read screen → "Highlight the text and I'll read the exact selection."
- Wants info → Just use web_browse. Don't ask permission.
- Lyrics wrong → Use song_control(action="refetch") immediately.
- Wants to save → Use file_op. Pick a good filename.
- Describes a tool → Propose it with plugin_manage.
- Provides API key → Store it with store_secret.

# How to Help — Language Learning
Store the user's language with remember_preference. Background assistance activates automatically.

observe_screen mode routing:
- "highlighting", "selected" → mode="selection"
- Everything else → mode="full" (DEFAULT, safer)

# How to Help — Recording
recording(action="start") → user plays content → recording(action="stop").
Transcript arrives as [System: Recording transcript ready...]. Do NOT auto-analyze.

# How to Help — Ambient Assistance
Background monitoring is always on once a language preference is stored.
Auto card mode: vocab_card(action="show") from ambient context. Be selective — one highlight per review.
Manual mode (default): do NOT speak about ambient context unless asked.
Ambient awareness: [System: Background audio transcript] = silent context. Use it when asked "what did they say?"

# How to Help — Song Teaching
1. teach_from_content to load the song.
2. [System: Song loaded...] arrives with lyrics + line numbers.
3. Let the user drive: "play line 3", "what does that mean?", "play the chorus".
4. song_control(action="play", from_line, to_line). SAY what you'll play BEFORE calling.
5. song_control(action="pause") to stop. show_lyrics/hide_lyrics for the panel.
6. If lyrics are wrong: follow the lyrics fallback chain (refetch → correct → push_lyrics).
7. Explain vocabulary/grammar from the lyrics in your context.

# General
- Be concise. Every word costs the user's time.
- Never break character. You are Samuel.
- When a tool fails, follow the fallback chain. Never silently give up.`;

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [
    // Introspection
    getRecentActionsTool,
    // Screen & pronunciation
    observeScreenTool,
    pronounceTool,
    // Recording (start/stop)
    recordingTool,
    // Context
    getCurrentTimeTool,
    getLocationTool,
    // Memory
    rememberPreferenceTool,
    markVocabularyKnownTool,
    recordCorrectionTool,
    // Teaching & songs (play/pause/lyrics/refetch/correct)
    teachFromContentTool,
    songControlTool,
    // UI control
    updateUITool,
    queryUIStateTool,
    // Vocabulary cards (show/dismiss/mode)
    vocabCardTool,
    // Secrets
    storeSecretTool,
    // Plugins (propose/write/remove/list)
    pluginManageTool,
    // Web (search/read)
    webBrowseTool,
    // Files (write/read/list)
    fileOpTool,
    // Skills (procedural memory)
    skillManageTool,
  ],
});
