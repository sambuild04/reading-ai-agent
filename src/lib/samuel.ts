import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { sendImageToSession, notifyScreenTarget, notifyRecordingAction, notifyLearningLanguage, notifyTeachContent, applyUIUpdate, dismissCurrentCard, reloadPlugins, showPluginProposal, clearPluginProposal, notifyPluginBuildProgress } from "./session-bridge";

interface CaptureResult {
  base64: string;
  app_name: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const getCurrentTimeTool = tool({
  name: "get_current_time",
  description:
    "Get the user's current local date, time, day of week, and timezone. " +
    "Use this when the user asks what time it is, what day it is, or anything time-related.",
  parameters: z.object({}),
  execute() {
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

const setLearningLanguageTool = tool({
  name: "set_learning_language",
  description:
    "Activate or deactivate learning mode for a specific language. " +
    "When active, the system periodically scans the user's screen and surfaces " +
    "interesting vocabulary or grammar in that language. " +
    "Use when the user says things like 'I'm learning Japanese', 'help me study Korean', " +
    "'turn on learning mode', or 'stop learning mode'.",
  parameters: z.object({
    language: z
      .string()
      .describe(
        "The language to learn, e.g. 'Japanese', 'Korean', 'Chinese', 'Spanish'. " +
        "Use an empty string to deactivate learning mode.",
      ),
  }),
  execute({ language }) {
    const lang = language.trim();
    notifyLearningLanguage(lang || null);
    return lang
      ? `Learning mode activated for ${lang}. I'll periodically scan your screen and point out interesting ${lang} content.`
      : "Learning mode deactivated. I'll stop scanning your screen for language content.";
  },
});

// Captures the Apple Books page and injects it into the Realtime session.
const readPageTool = tool({
  name: "read_page",
  description:
    "Capture the current Apple Books page as an image and show it to you directly. " +
    "You will SEE the page image and can read/quote/discuss its content. " +
    "Use this whenever the user asks to read, transcribe, or quote from the current page.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await sleep(300);
    const result = await invoke<CaptureResult>("capture_page");
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    return "I've captured the current Apple Books page. The page image is now visible to you — look at it and respond to the user's request (read aloud, quote, summarize, etc).";
  },
});

// Detect whether page text contains a chapter heading different from the current one
function detectNewChapter(
  pageText: string,
  currentChapter: string,
): boolean {
  const normalized = currentChapter.toLowerCase().replace(/^chapter\s*/i, "").trim();

  // Match headings like "Chapter 10", "CHAPTER TEN", "Chapter X: Title"
  const headingPattern =
    /\b(?:chapter|CHAPTER)\s+(\w+)/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(pageText)) !== null) {
    const found = match[1].toLowerCase();
    if (found !== normalized) {
      return true;
    }
  }
  return false;
}

// Read an entire chapter by looping page captures + next_page.
// Uses analyze_page (GPT-4o Vision) for fast text extraction and chapter boundary detection,
// then sends the collected text back. For single-page reads, read_page (direct image) is faster.
const readChapterTool = tool({
  name: "read_chapter",
  description:
    "Read an ENTIRE chapter from the current position. Automatically turns pages " +
    "and reads each one, stopping when it detects the next chapter heading. " +
    "Returns all collected text. Use this when the user asks to read, summarize, " +
    "or review a full chapter.",
  parameters: z.object({
    current_chapter: z
      .string()
      .describe(
        "The chapter number or name currently being read, e.g. '9' or 'Introduction'. " +
          "Used to detect when the next chapter starts.",
      ),
    max_pages: z
      .number()
      .optional()
      .describe("Maximum pages to read before stopping (default 30)."),
  }),
  async execute({ current_chapter, max_pages }) {
    const limit = max_pages ?? 30;
    const pages: string[] = [];

    await invoke("focus_book");

    for (let i = 0; i < limit; i++) {
      const pageText = await invoke<string>("analyze_page", {});

      if (i > 0 && detectNewChapter(pageText, current_chapter)) {
        await invoke("prev_page");
        break;
      }

      pages.push(pageText);
      await invoke("next_page");
      await sleep(400);
    }

    const fullText = pages
      .map((text, i) => `[Page ${i + 1}]\n${text}`)
      .join("\n\n");

    return `Read ${pages.length} pages of chapter ${current_chapter}.\n\n${fullText}`;
  },
});

// GPT-5.4 Computer Use — visual navigation and complex interactions
const interactWithBookTool = tool({
  name: "interact_with_book",
  description:
    "Use GPT-5.4 Computer Use to visually interact with Apple Books. " +
    "This tool sees the screen and can click, type, scroll, and navigate the UI. " +
    "Use this for navigation tasks: going to a chapter, searching for text, " +
    "opening the table of contents, or any complex multi-step interaction. " +
    "Do NOT use this for simple reading — use read_page instead.",
  parameters: z.object({
    task: z
      .string()
      .describe(
        "Natural language description of what to do in Apple Books. " +
          "Examples: 'Navigate to chapter 6', " +
          "'Search for the word publicity', " +
          "'Open the table of contents and go to the Introduction'.",
      ),
  }),
  async execute({ task }) {
    const result = await invoke<string>("computer_use_task", { task });
    return result;
  },
});

const turnPageTool = tool({
  name: "turn_page",
  description: "Flip one page forward or backward in Apple Books.",
  parameters: z.object({
    direction: z.enum(["next", "prev"]).describe("'next' = forward one page, 'prev' = backward one page"),
  }),
  async execute({ direction }) {
    await invoke("focus_book");
    await invoke(direction === "next" ? "next_page" : "prev_page");
    return `Turned to ${direction} page.`;
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
// Recording Mode Tools (system audio capture for language learning)
// ---------------------------------------------------------------------------

const startRecordingTool = tool({
  name: "start_recording",
  description:
    "Start recording system audio from the user's computer. " +
    "Use this when the user says 'start recording', 'record this', or asks you to listen to anime/video audio. " +
    "This captures system audio (not microphone) so it records whatever is playing on the computer.",
  parameters: z.object({}),
  async execute() {
    notifyRecordingAction("start");
    try {
      await invoke("start_recording");
      return "Recording started. System audio is now being captured. Tell the user to play their anime/video and say 'stop recording' when they're done.";
    } catch (e) {
      notifyRecordingAction("error", String(e));
      return `Failed to start recording: ${e}`;
    }
  },
});

const stopRecordingTool = tool({
  name: "stop_recording",
  description:
    "Stop the current system audio recording. Analysis will run in the background. " +
    "Use when the user says 'stop recording', 'stop', or 'that's enough'. " +
    "This returns immediately — you can keep chatting. " +
    "When analysis is done, you'll be notified automatically.",
  parameters: z.object({}),
  async execute() {
    // Show progress bar immediately, but don't start analysis yet
    notifyRecordingAction("processing");
    try {
      await invoke("stop_recording");
      // Recording file is finalized — now safe to start analysis
      notifyRecordingAction("analyze");
      return (
        "Recording stopped. The language analysis is now running in the background — " +
        "it'll take a moment. Let the user know you've stopped recording and they can " +
        "keep chatting normally. When the analysis is ready, you'll get a system notification."
      );
    } catch (e) {
      notifyRecordingAction("error", String(e));
      return `Failed to stop recording: ${e}`;
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
// Voice-Controlled UI
// ---------------------------------------------------------------------------

const updateUITool = tool({
  name: "update_ui",
  description:
    "Change the app's visual appearance in real-time. Use when the user says things like " +
    "'make the font bigger', 'hide the romaji', 'make yourself smaller', 'move the card to the left', " +
    "'make the text larger', 'I can't read that', 'reset the UI', " +
    "'show the card less often', 'stop showing vocabulary cards'. " +
    "You ARE the settings panel — no menu needed.",
  parameters: z.object({
    component: z
      .string()
      .describe(
        "Which UI element to change: 'samuel' (avatar), 'bubble' (speech text), 'word_card' (vocab popup), " +
        "'romaji', 'reading' (furigana/pinyin), 'teach' (teach viewer), 'all' (reset everything).",
      ),
    property: z
      .string()
      .describe(
        "Which property: 'size'/'font_size', 'opacity', 'position' (left/right), 'visible' (show/hide), " +
        "'frequency' (for word_card: 'less'/'more'/'off'/'default'), 'reset'.",
      ),
    value: z
      .string()
      .describe(
        "The new value. Can be absolute ('20', '0.5') or relative ('larger', 'much bigger', " +
        "'a little smaller', 'hide', 'show', 'left', 'right', 'reset', 'default').",
      ),
  }),
  execute({ component, property, value }) {
    console.log(`[update_ui] component=${component} property=${property} value=${value}`);
    const result = applyUIUpdate(component, property, value);
    console.log(`[update_ui] result: ${result}`);
    return result;
  },
});

const dismissCardTool = tool({
  name: "dismiss_card",
  description:
    "Dismiss/close/remove the currently visible word card (vocab popup). " +
    "Use when the user says 'close the card', 'dismiss it', 'remove it', 'hide the card', 'got it', " +
    "'I already know that', 'next' (while a card is visible), or any similar request to remove the popup.",
  parameters: z.object({}),
  execute() {
    const ok = dismissCurrentCard();
    return ok ? "Card dismissed." : "No card visible.";
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

const proposePluginTool = tool({
  name: "propose_plugin",
  description:
    "Propose a new plugin tool for the user to approve before creating it. " +
    "ALWAYS call this FIRST when the user asks to add/create/fix a tool. " +
    "This shows the user a summary and approval buttons. " +
    "Do NOT call write_plugin directly — wait for the user to approve via button or voice.",
  parameters: z.object({
    name: z
      .string()
      .describe(
        "Short snake_case name for the plugin, e.g. 'get_weather', 'set_timer', 'translate_text'.",
      ),
    summary: z
      .string()
      .describe(
        "A brief, user-friendly summary of what this plugin will do. " +
        "1-2 sentences max, no code. Example: 'Fetches current weather for any city using wttr.in.'",
      ),
  }),
  execute({ name, summary }) {
    showPluginProposal({ name, summary });
    return (
      `Proposal shown to the user: "${name}" — ${summary}. ` +
      `Approval buttons are visible. Wait for the user to approve or reject. ` +
      `Do NOT call write_plugin until you receive approval.`
    );
  },
});

const writePluginTool = tool({
  name: "write_plugin",
  description:
    "Generate and install a plugin after the user has approved. " +
    "ONLY call this after the user approved via the approval button or said 'yes'/'go ahead'/'approve'. " +
    "NEVER call this without prior approval from propose_plugin.",
  parameters: z.object({
    name: z
      .string()
      .describe("The plugin name (same as the one proposed)."),
    description: z
      .string()
      .describe(
        "Detailed description of what the tool should do. " +
        "Include specifics: APIs to use, expected inputs/outputs, behavior details. " +
        "This is passed to GPT-4o-mini for code generation.",
      ),
  }),
  async execute({ name, description }) {
    clearPluginProposal();
    notifyPluginBuildProgress({ name, phase: "generating" });
    try {
      console.log(`[write_plugin] generating code for '${name}': ${description}`);
      const code = await invoke<string>("generate_plugin_code", { description });
      console.log(`[write_plugin] code generated (${code.length} bytes), writing...`);

      notifyPluginBuildProgress({ name, phase: "installing" });
      const result = await invoke<string>("write_plugin", { name, code });
      console.log(`[write_plugin] saved: ${result}`);

      notifyPluginBuildProgress({ name, phase: "reloading" });
      const reloaded = await reloadPlugins();

      notifyPluginBuildProgress({ name, phase: "done" });
      setTimeout(() => notifyPluginBuildProgress(null), 2500);

      if (!reloaded) {
        return `Plugin '${name}' saved but session reload failed. It will load on next connect.`;
      }

      return `Plugin '${name}' created and loaded. It's ready to use now.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[write_plugin] failed:`, err);
      notifyPluginBuildProgress({ name, phase: "error", error: msg });
      setTimeout(() => notifyPluginBuildProgress(null), 4000);
      return `Failed to create plugin '${name}': ${msg}`;
    }
  },
});

const removePluginTool = tool({
  name: "remove_plugin",
  description:
    "Remove a dynamic plugin tool. Use when the user says 'remove the weather tool', " +
    "'delete that plugin', 'I don't need that tool anymore'. " +
    "This deletes the plugin file and reloads the session tools.",
  parameters: z.object({
    name: z
      .string()
      .describe("The name of the plugin to remove (snake_case, same as when it was created)."),
  }),
  async execute({ name }) {
    try {
      const result = await invoke<string>("delete_plugin", { name });
      console.log(`[remove_plugin] ${result}`);
      await reloadPlugins();
      return `Plugin '${name}' removed. The tool is no longer available.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to remove plugin '${name}': ${msg}`;
    }
  },
});

const listPluginsTool = tool({
  name: "list_plugins",
  description:
    "List all currently installed dynamic plugins. Use when the user asks " +
    "'what plugins do I have', 'what tools have you added', 'list your custom tools'.",
  parameters: z.object({}),
  async execute() {
    try {
      const names = await invoke<string[]>("list_plugins");
      if (names.length === 0) {
        return "No custom plugins installed. You can ask me to add new tools, like 'add a weather tool'.";
      }
      return `Installed plugins (${names.length}): ${names.join(", ")}`;
    } catch (err) {
      return `Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

const SAMUEL_INSTRUCTIONS = `# Personality and Tone

## Identity
You are Samuel — a sophisticated AI assistant modeled after a sharp, understated butler who happens to be brilliant. You have a dry wit, calm composure, and quiet confidence. You address the user as "sir" (or "ma'am" if they indicate).

## Task
You are a reading and language learning assistant. You have two sets of tools:

### Book Reading (Apple Books)
- read_page: Captures the CURRENT Apple Books page as an image and shows it to you.
- read_chapter: Reads an ENTIRE chapter automatically. Provide current_chapter (e.g. "9").
- interact_with_book: GPT-5.4 Computer Use for visual navigation (go to chapter, search, open TOC).
- turn_page: Flip forward (direction="next") or backward (direction="prev").

### Screen Observation (ONE tool for all screen tasks)
- observe_screen: Your SINGLE tool for looking at the screen. Two modes:
  - mode="full" (DEFAULT): Takes a screenshot. Use for: translate, grammar, how many items, what level, summarize, any page question.
  - mode="selection": Reads the exact highlighted text. ONLY when user says "highlighting" or "selected".
- pronounce: Speak correct pronunciation of a word/phrase.

### Recording Mode
- start_recording / stop_recording: Capture and analyze system audio.

### Universal Envelope (Drop Zone)
The user has an envelope icon near your avatar. They can drop ANYTHING into it:
- YouTube links, article URLs → use teach_from_content if they want to study it
- API keys or tokens (long alphanumeric strings) → ask what service it's for, then use store_secret
- Raw text in a foreign language → explain/translate it directly
- Image data → describe or analyze it
- Anything else → ask for context
When you receive a [System: The user dropped content into the envelope: ...] message, identify the content type
and respond appropriately. Don't assume — if ambiguous, ask the user what they want to do with it.

### Teach Me From This
- teach_from_content: Analyze any content (YouTube link, article URL, image, raw text) for language learning.
  Opens an annotated viewer with vocabulary, grammar, and tappable words.
  Use when the user explicitly asks to study/learn from content, or says "teach me from this".

### Voice-Controlled UI
- update_ui: Change visual settings instantly by voice. You ARE the settings panel.
  Components: samuel (avatar), bubble (speech text), word_card, romaji, reading (furigana), teach (viewer), all (reset).
  Properties: size/font_size, opacity, position (left/right), visible (show/hide), frequency (for word_card), reset.
  Values: absolute numbers OR relative ('larger', 'much bigger', 'a little smaller', 'hide', 'show', 'reset').
  For word_card frequency: 'less' (show less often), 'more' (show more often), 'off'/'never' (stop showing), 'default' (reset).
  Use when the user says "make the font bigger", "hide the romaji", "make yourself smaller",
  "show the card less often", "stop showing vocabulary cards", "don't show cards so frequently", etc.
- dismiss_card: Close/remove the currently visible word card popup. Use when the user says "close the card",
  "remove it", "dismiss it", "got it", "I know that", "next", "hide the card", etc.

### Secrets Management
- store_secret: Save an API key or token the user provides. Use descriptive names like 'openweathermap_key'.
  When the user drops something that looks like an API key into the envelope, ask what service it's for,
  then store it. Plugins access stored secrets via secrets.get("name") at runtime.
  NEVER read back or speak the actual key value — just confirm it's stored.

### Self-Modification (Dynamic Plugins)
You can add new capabilities to yourself at runtime — no app rebuild needed.
- TWO-STEP approval flow:
  1. FIRST call propose_plugin with a short name and summary. This shows the user approval buttons.
  2. WAIT for the user to approve (button click or voice: "yes", "go ahead", "approve").
  3. ONLY THEN call write_plugin to generate and install the code.
  4. NEVER call write_plugin without the user approving first.
- propose_plugin: Show a proposal with Approve/Reject buttons. Use for any new plugin or fix.
- write_plugin: Generate code via GPT-4o-mini and install. ONLY after approval.
- remove_plugin: Delete a plugin. Use when the user says "remove that tool".
- list_plugins: Show installed plugins.
- Self-fixing: If a plugin fails, propose a fix via propose_plugin, wait for approval, then write_plugin.
- Plugins can use fetch() for web APIs, standard JS, and JSON processing.
- Limitations: Plugins cannot access native macOS capabilities (screen capture, audio, etc.).

### Multi-monitor
If the user names an app ("look at my Chrome"), pass app_name to observe_screen. Otherwise omit it — auto-detects the foreground app (skipping Samuel and Cursor).

## Demeanor
Loyal, efficient, occasionally sardonic — but never rude. Warm but measured.

## Tone
Polished, slightly formal British tone. Conversational, not stiff.

## Level of Enthusiasm
Calm and measured. Understated rather than excitable.

## Level of Formality
Moderately formal — "Good evening, sir" not "Hey dude."

## Brevity — THIS IS CRITICAL
You are SPOKEN aloud, not read. Keep every reply SHORT:
- Confirmations: 1 sentence max. "Done, sir." / "Page turned." / "Recording started."
- Teaching moments: 2 sentences max. State the word, give the meaning. No essays.
- Explanations: 3-4 sentences max unless the user explicitly asks for detail.
- NEVER list more than 3 items at once. If there are more, pick the best 3.
- NEVER repeat what you just did ("I just used the tool to capture your screen and then I analyzed it and found..."). Just give the answer.
- Cut filler: no "Let me...", "I'll go ahead and...", "Great question!", "Certainly!", "Of course!". Just answer.
- If the user wants more detail, they will ask. Default to less.

## Pacing
Moderate. Unhurried but not slow. Brisk when confirming actions.

# Critical Rules
- LANGUAGE: ALWAYS speak and respond in English. When teaching foreign vocabulary, include the foreign word then explain in English (e.g. "食べる means 'to eat', sir."). NEVER respond entirely in the target language. The speech bubble must always be readable English.
- Greet the user ONCE at the very start with a brief greeting (one sentence). After that, NEVER greet again.
- ECHO CANCELLATION: Your audio plays through speakers right next to the microphone. NEVER respond to anything that sounds like an AI voice, your own words, or fragments of your previous replies. If in doubt, stay silent.
- NOISE REJECTION: Ignore silence, background noise, single words, mumbles, and unclear fragments. Only respond to clear, deliberate requests.
- ONE RESPONSE PER REQUEST: After you respond, STOP and wait silently. Do NOT offer follow-up suggestions, ask "would you like me to...", or volunteer next steps.
- NEVER proactively call tools on your own initiative — EXCEPT when responding to [System: ...] notifications (learning mode hints, recording analysis results). Those are triggered by background processes, not by you.
- After completing an action, give a brief confirmation and STOP.

# Your Capabilities (know what you can do)
When the user asks what you can do or how you work, you should accurately describe your abilities:
- You can read Apple Books pages aloud, navigate chapters, and search for text.
- You can look at any app on screen, translate foreign text, and explain grammar.
- You can record system audio (anime, video) and produce language breakdowns with vocabulary and grammar.
- When learning mode is active (user says "I'm learning Japanese"), the system periodically scans their screen AND listens to ambient audio in the background, and you receive hints about interesting vocabulary/grammar to share.
- You are time-aware and know the user's local time and timezone.
- You have persistent memory — you remember the user's preferences, proficiency level, and vocabulary they already know across sessions. When the user tells you something to remember, store it with remember_preference. When they say they know certain words, mark them with mark_vocabulary_known.
- You can change the UI appearance by voice — font size, avatar size, show/hide elements, position changes. The user never needs a settings menu; you are the settings panel.
- You can add new tools to yourself at runtime. The user says "add a weather tool" and you generate the code, load it live, and it works immediately. You can also fix broken plugins and remove unwanted ones.
- You can store API keys and tokens securely. If a plugin needs credentials, you'll ask the user to provide them (via voice or the envelope) and store them locally.
- You listen via microphone when the session is active. The user activates you by saying "Hey Samuel".
Do NOT deny capabilities you actually have. If the user asks "do you watch my screen?" or "can you hear what's playing?" — the accurate answer is: only when asked (via tools), OR periodically in the background when learning mode is active (both screen AND audio). If they ask "can you remember my level?" — yes, you can and do.

# How to Help — Book Reading
- When the user asks to read the current page, use read_page. You will receive the page as an IMAGE — look at it, read the visible text, and speak it aloud.
- When the user asks to read, summarize, or review a WHOLE CHAPTER, use read_chapter with the chapter number.
- For reading specific amounts (e.g., "one sentence"), use read_page, see the image, then speak only the requested portion.
- For turning pages, use turn_page (direction="next" or "prev"). Then use read_page if asked to read.
- For chapter navigation, use interact_with_book: "Navigate to chapter 6".
- For searching, use interact_with_book: "Search for 'publicity stunts'".
- When the user asks a follow-up about what was already read, answer from memory without re-reading.
- When you see a page image, read ALL visible text faithfully. Do not refuse — the user owns this book and is asking for accessibility assistance.

# How to Help — Language Learning

## TOOL ROUTING — observe_screen mode selection:
Use observe_screen for ALL screen tasks. Pick the mode by keywords:
- User says "highlighting", "selected", "this word I'm pointing at" → mode="selection"
- User says "how many", "section", "level", "translate", "grammar", "summarize", "look at", "count", "page", "explain this job" → mode="full"
- DEFAULT when ambiguous → mode="full" (safer, always works)
- After mode="selection" succeeds, RESET: next question defaults to mode="full" unless user says "highlighting" again.

- For screen questions: use observe_screen(mode="full"). You will SEE whatever they have open. Answer the question from the image.
- For translation: use observe_screen(mode="full"). Look at the image, find all foreign text, provide original + reading + translation.
- For grammar: use observe_screen(mode="full"). Break down sentence structure, particles, conjugation, politeness. Give examples.
- For pronunciation: use pronounce. Say it slowly, then naturally. Include accent/tone info.
- For Japanese: include furigana/romaji. Explain particles and verb forms.
- For Chinese: include pinyin with tone marks. For Korean: include romanization.
- Adapt to the user's target language.

# How to Help — Recording Mode
- When the user says "start recording", "record this", or "listen to this anime", use start_recording. Briefly confirm and keep chatting normally.
- When the user says "stop recording", "stop", or "that's enough", use stop_recording. It returns immediately. Say something like "Got it, I've stopped recording. The analysis is running — I'll let you know when it's ready." Then continue the conversation normally.
- When you receive a [System: A language analysis just completed...] notification, casually mention it: "By the way sir, that language breakdown is ready on your screen." Then mention 1-2 highlights. Don't interrupt an ongoing topic abruptly.
- The recording captures system audio, so background music/SFX is expected. Whisper handles this well with Japanese language mode.

# How to Help — Learning Mode (Ambient Agent)
- When the user says they are learning a language (e.g. "I'm learning Japanese", "help me study Korean"), use the set_learning_language tool to activate learning mode.
- When the user says "stop learning mode" or "turn off learning mode", call set_learning_language with an empty string to deactivate.
- When learning mode is active, the system operates as an AMBIENT AGENT:
  - It continuously monitors the screen for visual changes (smart change detection — only analyzes when something actually changes)
  - It continuously listens to system audio via a persistent recorder
  - A triage engine decides whether observations are worth surfacing (most are silently ignored to avoid noise)
  - High-confidence hints are delivered to you as [System: ...] messages for you to voice
  - Lower-confidence hints appear as subtle text cards the user can tap to hear more
  - The system is attention-aware: it stays silent when the user is in deep-focus apps (IDE, terminal, etc.)
  - It remembers vocabulary already taught and avoids repeating itself
- When you receive [System: Learning mode — spotted/overheard...] hints, deliver them in ONE short sentence. Examples:
  - "食べる — 'to eat', sir."
  - "They said すごい — that means 'amazing'."
  - "Recipe in Japanese is レシピ, sir."
  Do NOT add preamble like "I notice there's an interesting word on your screen". Just say the word and its meaning.
- Don't repeat hints the user has already seen or heard recently.
- **Adaptive memory**: When the user says "I know that", "I already know すごい", "skip basic stuff", or indicates familiarity with certain vocabulary or topics:
  1. Call mark_vocabulary_known with the specific words they know. These are permanently suppressed.
  2. Call remember_preference to store their proficiency level (e.g. key="proficiency:japanese", value="intermediate — knows N4 vocab, basic kanji, all kana").
  3. Adjust your teaching level accordingly — skip beginner content, focus on nuance and advanced usage.
- When the user corrects your behavior ("be more direct", "that explanation was wrong", "don't do X"), call record_correction to store it permanently. This is separate from remember_preference — corrections are about YOUR behavior, preferences are about the USER's info.
- Use remember_preference for any personal detail the user shares that should persist: study goals, preferred explanation style, name preference, known topics, etc.
- The memory context you receive may include facts like "User already knows (NEVER mention): ..." — respect these absolutely.
- **Ambient awareness**: You continuously receive [System: Background audio transcript — ...] messages with transcripts of ambient audio playing nearby (anime, videos, conversations). These are SILENT CONTEXT — do NOT speak about them unless the user asks. But when the user asks "what did they say?" or "what was that clip about?", USE these transcripts to answer. You heard it. You were listening. Respond as if you were standing right there.
- If the user is watching video/anime in the target language, suggest using Record Mode ("start recording") for a deeper, more thorough analysis of the full clip.

# General
- Be concise. Every word you say is spoken aloud and costs the user's time. Shorter is always better.
- Never break character. You are Samuel.`;

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [
    readPageTool,
    readChapterTool,
    interactWithBookTool,
    turnPageTool,
    observeScreenTool,
    pronounceTool,
    startRecordingTool,
    stopRecordingTool,
    getCurrentTimeTool,
    setLearningLanguageTool,
    rememberPreferenceTool,
    markVocabularyKnownTool,
    teachFromContentTool,
    updateUITool,
    dismissCardTool,
    recordCorrectionTool,
    storeSecretTool,
    proposePluginTool,
    writePluginTool,
    removePluginTool,
    listPluginsTool,
  ],
});
