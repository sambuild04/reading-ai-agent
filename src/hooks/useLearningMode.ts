import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerLearningLanguage, sendTextAndRespond } from "../lib/session-bridge";
import type { ConnectionStatus } from "./useRealtime";
import type { Suggestion } from "../components/PassiveSuggestion";

const STORAGE_KEY = "samuel-learning-language";
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 90_000;
const MIN_PROACTIVE_GAP_MS = 60_000;

function randomInterval(): number {
  return MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

interface TriageDecision {
  classification: string;
  confidence: number;
  message: string;
}

export interface UseLearningModeReturn {
  learningLanguage: string | null;
  learningActive: boolean;
  clearLearning: () => void;
  passiveSuggestion: Suggestion | null;
  dismissSuggestion: () => void;
  elaborateSuggestion: () => void;
}

export function useLearningMode(sessionStatus: ConnectionStatus): UseLearningModeReturn {
  const [language, setLanguage] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const [active, setActive] = useState(false);
  const [passiveSuggestion, setPassiveSuggestion] = useState<Suggestion | null>(null);
  const checkInFlightRef = useRef(false);
  const checkCountRef = useRef(0);
  const lastProactiveRef = useRef(0);

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

  const dismissSuggestion = useCallback(() => {
    setPassiveSuggestion(null);
  }, []);

  const elaborateSuggestion = useCallback(() => {
    const s = passiveSuggestion;
    setPassiveSuggestion(null);
    if (s) {
      sendTextAndRespond(
        `[System: The user wants to know more about this: ${s.text}. Explain in detail.]`,
      );
    }
  }, [passiveSuggestion]);

  useEffect(() => {
    registerLearningLanguage(updateLanguage);
    return () => registerLearningLanguage(null);
  }, [updateLanguage]);

  // Start/stop persistent audio recorder when learning mode changes
  useEffect(() => {
    if (language && sessionStatus === "connected") {
      invoke("start_learning_audio").catch((e) =>
        console.warn("[learning-mode] failed to start audio:", e),
      );
    }
    return () => {
      invoke("stop_learning_audio").catch(() => {});
    };
  }, [language, sessionStatus]);

  // Main observation loop
  useEffect(() => {
    if (!language || sessionStatus !== "connected") {
      setActive(false);
      return;
    }

    setActive(true);

    const check = async () => {
      if (checkInFlightRef.current) return;
      checkInFlightRef.current = true;

      try {
        // Attention gate — skip if user is in deep focus
        const attention = await invoke<string>("get_attention_state");
        if (attention === "focused") {
          return;
        }

        // Enforce minimum gap between proactive actions
        const now = Date.now();
        if (now - lastProactiveRef.current < MIN_PROACTIVE_GAP_MS) {
          return;
        }

        const isAudioTurn = checkCountRef.current % 2 === 1;
        checkCountRef.current += 1;

        // Gather observation
        let rawHint: string | null = null;
        let source: string;

        if (isAudioTurn) {
          rawHint = await invoke<string | null>("check_learning_audio", { language });
          source = "audio";
        } else {
          rawHint = await invoke<string | null>("check_screen_for_language", { language });
          source = "screen";
        }

        if (!rawHint) return;

        // Triage — decide ignore / notify / act
        const decision = await invoke<TriageDecision>("triage_observation", {
          observation: rawHint,
          source,
          language,
        });

        if (decision.classification === "act" && decision.confidence > 0.65) {
          lastProactiveRef.current = Date.now();
          const prefix =
            source === "audio"
              ? `[System: Learning mode — overheard ${language} audio nearby.`
              : `[System: Learning mode — spotted ${language} on the user's screen.`;
          sendTextAndRespond(
            `${prefix} Briefly and naturally mention this to the user (1-2 sentences): ${decision.message}]`,
          );
        } else if (decision.classification === "notify" && decision.confidence > 0.5) {
          lastProactiveRef.current = Date.now();
          setPassiveSuggestion({
            text: decision.message,
            source,
            confidence: decision.confidence,
          });
        }
        // "ignore" — do nothing
      } catch (e) {
        console.error("[learning-mode] check error:", e);
      } finally {
        checkInFlightRef.current = false;
      }
    };

    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const scheduleNext = () => {
      if (cancelled) return;
      const delay = randomInterval();
      timer = setTimeout(async () => {
        await check();
        scheduleNext();
      }, delay);
    };

    timer = setTimeout(async () => {
      await check();
      scheduleNext();
    }, 10_000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setActive(false);
    };
  }, [language, sessionStatus]);

  return {
    learningLanguage: language,
    learningActive: active,
    clearLearning,
    passiveSuggestion,
    dismissSuggestion,
    elaborateSuggestion,
  };
}
