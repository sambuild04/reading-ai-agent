import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerLearningLanguage, sendTextAndRespond, sendSilentContext, sendAudioClip } from "../lib/session-bridge";
import type { ConnectionStatus } from "./useRealtime";
import type { VocabCardMode } from "../hooks/useUIPreferences";

const STORAGE_KEY = "samuel-learning-language";
const CHECK_INTERVAL_MS = 20_000;
const DEFAULT_PROACTIVE_GAP_MS = 45_000;
const MIN_REVIEW_WARMUP_MS = 2 * 60 * 1000;

interface AudioCheckResult {
  transcript: string | null;
  hint: string | null;
  clip_path: string | null;
  pcm_audio_base64: string | null;
}

interface WatchCheckMatch {
  id: string;
  description: string;
  message_template: string;
}

interface ClassifierMatch {
  watch_id: string;
  description: string;
  message_template: string;
  detail: string;
}

export interface UseLearningModeReturn {
  learningLanguage: string | null;
  learningActive: boolean;
  clearLearning: () => void;
}

export function useLearningMode(
  sessionStatus: ConnectionStatus,
  vocabCardIntervalSec?: number,
  agentState?: "idle" | "listening" | "thinking" | "speaking",
  cardMode: VocabCardMode = "manual",
  screenWatchEnabled = true,
  audioListenEnabled = true,
): UseLearningModeReturn {
  const proactiveGapMs = vocabCardIntervalSec
    ? vocabCardIntervalSec * 1000
    : DEFAULT_PROACTIVE_GAP_MS;

  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;
  const cardModeRef = useRef(cardMode);
  cardModeRef.current = cardMode;
  const proactiveGapRef = useRef(proactiveGapMs);
  proactiveGapRef.current = proactiveGapMs;
  const screenWatchRef = useRef(screenWatchEnabled);
  screenWatchRef.current = screenWatchEnabled;
  const audioListenRef = useRef(audioListenEnabled);
  audioListenRef.current = audioListenEnabled;

  const [language, setLanguage] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const [active, setActive] = useState(false);
  const checkInFlightRef = useRef(false);

  // Accumulates ambient context snippets for Samuel's periodic review
  const contextBufferRef = useRef<string[]>([]);

  const updateLanguage = useCallback((lang: string | null) => {
    setLanguage(lang);
    if (lang) {
      localStorage.setItem(STORAGE_KEY, lang);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const clearLearning = useCallback(() => {
    updateLanguage(null);
  }, [updateLanguage]);

  useEffect(() => {
    registerLearningLanguage(updateLanguage);
    return () => registerLearningLanguage(null);
  }, [updateLanguage]);

  // Audio recorder runs whenever learning language is set AND audio listening is enabled.
  useEffect(() => {
    if (language && audioListenEnabled) {
      invoke("start_learning_audio").catch((e) =>
        console.warn("[learning-mode] failed to start audio:", e),
      );
    } else {
      invoke("stop_learning_audio").catch(() => {});
    }
    return () => {
      invoke("stop_learning_audio").catch(() => {});
    };
  }, [language, audioListenEnabled]);

  // Tracks when the session started (for warmup gating)
  const sessionStartRef = useRef(0);

  // Main observation loop — checks BOTH audio and screen every cycle
  useEffect(() => {
    if (!language || sessionStatus !== "connected") {
      setActive(false);
      return;
    }

    setActive(true);
    sessionStartRef.current = Date.now();
    contextBufferRef.current = [];

    const runCheck = async () => {
      if (checkInFlightRef.current) return;
      // Suppress learning checks while Samuel is executing a tool or speaking.
      // Uses ref to avoid the interval being torn down on every state change.
      const state = agentStateRef.current;
      if (state === "thinking" || state === "speaking") return;
      checkInFlightRef.current = true;

      try {
        const noAudio: AudioCheckResult = { transcript: null, hint: null, clip_path: null, pcm_audio_base64: null };
        const [audioResult, screenHint] = await Promise.all([
          audioListenRef.current
            ? invoke<AudioCheckResult>("check_learning_audio", { language }).catch(() => noAudio)
            : Promise.resolve(noAudio),
          screenWatchRef.current
            ? invoke<string | null>("check_screen_for_language", { language }).catch(() => null)
            : Promise.resolve(null),
        ]);

        // Feed transcript to the viewing assessment window
        if (audioResult.transcript) {
          invoke("append_transcript_window", { text: audioResult.transcript }).catch(() => {});
        }

        // NOTE: We intentionally do NOT inject raw PCM audio into the Realtime
        // session. The model treats input_audio as user speech, which confuses
        // it about the user's language (English mic vs Japanese anime audio).
        // Instead we use text transcripts + hints as silent context.
        const contextParts: string[] = [];

        if (audioResult.transcript) {
          contextParts.push(`Audio heard from speakers: "${audioResult.transcript}"`);
        }
        if (audioResult.hint) {
          contextParts.push(`Vocab note: ${audioResult.hint}`);
        }
        if (screenHint && !screenHint.startsWith("NONE")) {
          contextParts.push(`Screen: "${screenHint}"`);
        }

        // ── Watcher Loop (ambient agent) ─────────────────────────────
        // Evaluate all active triggers against new content.
        // Keyword triggers: deterministic, evaluated in Rust.
        // Classifier triggers: GPT-4o-mini, evaluated in Rust.
        // Matches fire via sendTextAndRespond (synthetic turn injection).

        const audioText = audioResult.transcript || "";
        const screenText = screenHint && !screenHint.startsWith("NONE") ? screenHint : "";
        const hasContent = audioText || screenText;

        if (hasContent) {
          const triggerMessages: string[] = [];

          // Tier 1: keyword triggers (microseconds, free)
          const [audioKw, screenKw] = await Promise.all([
            audioText
              ? invoke<WatchCheckMatch[]>("watch_check", { text: audioText, source: "audio" }).catch(() => [] as WatchCheckMatch[])
              : Promise.resolve([] as WatchCheckMatch[]),
            screenText
              ? invoke<WatchCheckMatch[]>("watch_check", { text: screenText, source: "screen" }).catch(() => [] as WatchCheckMatch[])
              : Promise.resolve([] as WatchCheckMatch[]),
          ]);
          const seenIds = new Set<string>();
          for (const m of [...audioKw, ...screenKw]) {
            if (seenIds.has(m.id)) continue;
            seenIds.add(m.id);
            const msg = m.message_template || m.description;
            triggerMessages.push(msg);
          }

          // Tier 2: classifier triggers (GPT-4o-mini, ~$0.0001/call)
          const combined = [audioText, screenText].filter(Boolean).join("\n");
          const [audioClassifier, screenClassifier] = await Promise.all([
            audioText
              ? invoke<ClassifierMatch[]>("watch_evaluate_classifier", { content: audioText, source: "audio" }).catch(() => [] as ClassifierMatch[])
              : Promise.resolve([] as ClassifierMatch[]),
            screenText
              ? invoke<ClassifierMatch[]>("watch_evaluate_classifier", { content: screenText, source: "screen" }).catch(() => [] as ClassifierMatch[])
              : Promise.resolve([] as ClassifierMatch[]),
          ]);
          for (const m of [...audioClassifier, ...screenClassifier]) {
            if (seenIds.has(m.watch_id)) continue;
            seenIds.add(m.watch_id);
            const msg = m.message_template
              ? m.message_template.replace("{detail}", m.detail)
              : `${m.description}: ${m.detail}`;
            triggerMessages.push(msg);
          }

          // Fire all matched triggers as a single synthetic turn
          if (triggerMessages.length > 0) {
            console.log(`[watcher] ${triggerMessages.length} trigger(s) fired`);
            sendTextAndRespond(
              `[TRIGGER ALERT] The following watches just matched:\n` +
              triggerMessages.map((m, i) => `${i + 1}. ${m}`).join("\n") +
              `\n\nContext: ${combined}\n\n` +
              `Briefly notify the user about what you detected. Be specific. Keep it to 1-2 sentences per trigger.`,
            );
          }
        }

        // Passive ambient context (no watch evaluation here — that's the watcher loop above)
        if (contextParts.length > 0) {
          const contextMsg = contextParts.join(" | ");
          sendSilentContext(
            `[System: Ambient context — ${contextMsg}. ` +
            `You are passively listening. Do not speak unless prompted by the user or a trigger alert.]`,
          );
          contextBufferRef.current.push(contextMsg);
          if (contextBufferRef.current.length > 15) {
            contextBufferRef.current = contextBufferRef.current.slice(-15);
          }
        }
      } catch (e) {
        console.error("[learning-mode] check error:", e);
      } finally {
        checkInFlightRef.current = false;
      }
    };

    // Samuel review loop — in auto mode, periodically sends accumulated context
    // to Samuel and asks him to review for teaching opportunities. Samuel decides
    // what to highlight based on stored preferences (language, proficiency, goals).
    const runSamuelReview = () => {
      if (cardModeRef.current !== "auto") return;
      if (Date.now() - sessionStartRef.current < MIN_REVIEW_WARMUP_MS) return;

      const state = agentStateRef.current;
      if (state === "thinking" || state === "speaking") return;

      const buffer = contextBufferRef.current;
      if (buffer.length === 0) return;

      // Drain the buffer
      const snippets = buffer.splice(0, buffer.length);
      const contextText = snippets.join("\n");

      console.log(`[learning-mode] Samuel review: ${snippets.length} snippets`);

      sendTextAndRespond(
        `[System: Ambient review — You are in auto card mode. Review the recent ambient context below ` +
        `and decide if there's anything worth teaching the user (interesting words, phrases, or concepts ` +
        `in ${language}). Use show_word_card for vocabulary, or speak briefly for broader insights. ` +
        `Respect the user's proficiency level from memory. If nothing is interesting, stay silent — ` +
        `respond with just "Nothing notable." and do NOT speak to the user.\n\n${contextText}]`,
      );
    };

    // Immediate first check on connect — flush any pre-connect audio
    runCheck();

    // Observation loop every 20s
    const checkInterval = setInterval(runCheck, CHECK_INTERVAL_MS);
    // Samuel review runs at the user-configured interval (default ~45s),
    // gated by auto mode and warmup period
    const reviewInterval = setInterval(runSamuelReview, proactiveGapRef.current);

    return () => {
      clearInterval(checkInterval);
      clearInterval(reviewInterval);
      setActive(false);
    };
  }, [language, sessionStatus, proactiveGapMs]);

  return {
    learningLanguage: language,
    learningActive: active,
    clearLearning,
  };
}
