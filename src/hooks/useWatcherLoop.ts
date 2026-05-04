import { useEffect, useRef } from "react";
import { invoke } from "../lib/invoke-bridge";
import { sendTextAndRespond } from "../lib/session-bridge";
import type { ConnectionStatus } from "./useRealtime";

const WATCHER_INTERVAL_MS = 20_000;

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

interface WatchAlert {
  id: string;
  condition_type: string;
  source: string;
  enabled: boolean;
}

/**
 * Standalone watcher loop (Loop 2 of the ambient agent architecture).
 * Runs whenever the Realtime session is connected, regardless of learning mode.
 * Evaluates active triggers against screen content every cycle.
 * When learning mode is active, it defers to useLearningMode which handles
 * both audio + screen evaluation inline. This hook covers the gap when
 * learning mode is OFF but the user still has active triggers.
 */
export function useWatcherLoop(
  sessionStatus: ConnectionStatus,
  agentState?: "idle" | "listening" | "thinking" | "speaking",
  learningActive?: boolean,
  screenWatchEnabled = true,
) {
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;
  const learningActiveRef = useRef(learningActive);
  learningActiveRef.current = learningActive;
  const screenWatchRef = useRef(screenWatchEnabled);
  screenWatchRef.current = screenWatchEnabled;
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (sessionStatus !== "connected") return;

    const runWatcher = async () => {
      // Skip if learning mode is running (it handles watcher evaluation itself)
      if (learningActiveRef.current) return;
      if (inFlightRef.current) return;

      const state = agentStateRef.current;
      if (state === "thinking" || state === "speaking") return;

      // Check if there are any active triggers at all (avoid unnecessary work)
      let watches: WatchAlert[];
      try {
        watches = await invoke<WatchAlert[]>("watch_list");
      } catch {
        return;
      }
      const enabled = watches.filter((w) => w.enabled);
      if (enabled.length === 0) return;

      inFlightRef.current = true;

      try {
        const triggerMessages: string[] = [];
        const seenIds = new Set<string>();

        // Screen content: capture and describe via GPT-4o-mini
        let screenText = "";
        const hasScreenTriggers = enabled.some((w) => w.source === "screen" || w.source === "both");
        if (hasScreenTriggers && screenWatchRef.current) {
          try {
            screenText = await invoke<string>("check_screen_text") ?? "";
          } catch {
            // check_screen_text may not exist yet; fall back to nothing
          }
        }

        if (!screenText) {
          inFlightRef.current = false;
          return;
        }

        // Tier 1: keyword triggers
        const kwMatches = await invoke<WatchCheckMatch[]>("watch_check", {
          text: screenText,
          source: "screen",
        }).catch(() => [] as WatchCheckMatch[]);

        for (const m of kwMatches) {
          if (seenIds.has(m.id)) continue;
          seenIds.add(m.id);
          triggerMessages.push(m.message_template || m.description);
        }

        // Tier 2: classifier triggers
        const classifierMatches = await invoke<ClassifierMatch[]>(
          "watch_evaluate_classifier",
          { content: screenText, source: "screen" },
        ).catch(() => [] as ClassifierMatch[]);

        for (const m of classifierMatches) {
          if (seenIds.has(m.watch_id)) continue;
          seenIds.add(m.watch_id);
          const msg = m.message_template
            ? m.message_template.replace("{detail}", m.detail)
            : `${m.description}: ${m.detail}`;
          triggerMessages.push(msg);
        }

        if (triggerMessages.length > 0) {
          console.log(`[watcher-standalone] ${triggerMessages.length} trigger(s) fired`);
          sendTextAndRespond(
            `[TRIGGER ALERT] The following watches just matched:\n` +
            triggerMessages.map((m, i) => `${i + 1}. ${m}`).join("\n") +
            `\n\nContext (screen): ${screenText}\n\n` +
            `Briefly notify the user about what you detected. Be specific. Keep it to 1-2 sentences per trigger.`,
          );
        }
      } catch (e) {
        console.error("[watcher-standalone] error:", e);
      } finally {
        inFlightRef.current = false;
      }
    };

    const interval = setInterval(runWatcher, WATCHER_INTERVAL_MS);
    runWatcher();

    return () => clearInterval(interval);
  }, [sessionStatus]);
}
