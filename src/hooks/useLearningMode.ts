import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerLearningLanguage, sendTextAndRespond } from "../lib/session-bridge";
import type { ConnectionStatus } from "./useRealtime";

const STORAGE_KEY = "samuel-learning-language";
const CHECK_INTERVAL_MS = 45_000; // 45 seconds — alternates between screen and audio

export interface UseLearningModeReturn {
  learningLanguage: string | null;
  learningActive: boolean;
  clearLearning: () => void;
}

export function useLearningMode(sessionStatus: ConnectionStatus): UseLearningModeReturn {
  const [language, setLanguage] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const [active, setActive] = useState(false);
  const checkInFlightRef = useRef(false);
  const checkCountRef = useRef(0); // alternates: even = screen, odd = audio

  // Persist and expose language changes from Samuel's tool
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

  // Register bridge callback so Samuel's set_learning_language tool works
  useEffect(() => {
    registerLearningLanguage(updateLanguage);
    return () => registerLearningLanguage(null);
  }, [updateLanguage]);

  // Periodic screen check when learning mode is active and session is connected
  useEffect(() => {
    if (!language || sessionStatus !== "connected") {
      setActive(false);
      return;
    }

    setActive(true);

    const check = async () => {
      if (checkInFlightRef.current) return;
      checkInFlightRef.current = true;
      const isAudioTurn = checkCountRef.current % 2 === 1;
      checkCountRef.current += 1;
      try {
        let hints: string | null = null;
        if (isAudioTurn) {
          hints = await invoke<string | null>("check_audio_for_language", {
            language,
            durationSecs: 8,
          });
          if (hints) {
            sendTextAndRespond(
              `[System: Learning mode — overheard ${language} audio nearby. ` +
              `Briefly and naturally mention this to the user (1-2 sentences): ${hints}]`,
            );
          }
        } else {
          hints = await invoke<string | null>("check_screen_for_language", { language });
          if (hints) {
            sendTextAndRespond(
              `[System: Learning mode — spotted ${language} on the user's screen. ` +
              `Briefly and naturally mention this to the user (1-2 sentences): ${hints}]`,
            );
          }
        }
      } catch (e) {
        console.error("[learning-mode] check error:", e);
      } finally {
        checkInFlightRef.current = false;
      }
    };

    const interval = setInterval(check, CHECK_INTERVAL_MS);
    // Run the first check after a short delay (let the session stabilize)
    const initialTimeout = setTimeout(check, 10_000);

    return () => {
      clearInterval(interval);
      clearTimeout(initialTimeout);
      setActive(false);
    };
  }, [language, sessionStatus]);

  return { learningLanguage: language, learningActive: active, clearLearning };
}
