import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playBubblePop } from "../lib/sounds";

export interface Suggestion {
  text: string;
  source: string;
  confidence: number;
  clipPath?: string;
  transcript?: string;
}

interface Props {
  suggestion: Suggestion | null;
  onDismiss: () => void;
  onElaborate: () => void;
}

const CARD_LIFETIME_MS = 60_000;

export function PassiveSuggestion({ suggestion, onDismiss, onElaborate }: Props) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!suggestion) {
      setVisible(false);
      setExiting(false);
      return;
    }

    setVisible(true);
    setExiting(false);
    playBubblePop();

    dismissTimerRef.current = setTimeout(() => {
      handleDismissAnimated();
    }, CARD_LIFETIME_MS);

    return () => {
      clearTimeout(dismissTimerRef.current);
    };
  }, [suggestion]);

  const handleDismissAnimated = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      setVisible(false);
      setExiting(false);
      onDismiss();
    }, 400);
  }, [onDismiss]);

  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleNewToMe = useCallback(async () => {
    if (suggestion) {
      try {
        const words = extractWords(suggestion.text);
        await invoke("save_flashcard", {
          word: words[0] || suggestion.text.slice(0, 30),
          hint: suggestion.text,
          transcript: suggestion.transcript || "",
          audioClipPath: suggestion.clipPath || null,
          source: suggestion.source,
        });
        console.log("[vocab-card] saved flashcard");
      } catch (e) {
        console.warn("[vocab-card] failed to save flashcard:", e);
      }
    }
    handleDismissAnimated();
  }, [suggestion, handleDismissAnimated]);

  const handleKnowIt = useCallback(async () => {
    if (suggestion) {
      const words = extractWords(suggestion.text);
      if (words.length > 0) {
        try {
          await invoke("memory_mark_known", { words });
        } catch (e) {
          console.warn("[vocab-card] failed to mark known:", e);
        }
      }
    }
    handleDismissAnimated();
  }, [suggestion, handleDismissAnimated]);

  const handleExplain = useCallback(() => {
    clearTimeout(dismissTimerRef.current);
    setVisible(false);
    setExiting(false);
    onElaborate();
  }, [onElaborate]);

  const handlePlayClip = useCallback(async () => {
    if (!suggestion?.clipPath) return;
    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      return;
    }
    try {
      const b64 = await invoke<string>("read_flashcard_file", { filePath: suggestion.clipPath });
      const audio = new Audio(`data:audio/mp4;base64,${b64}`);
      audioRef.current = audio;
      audio.onended = () => setIsPlaying(false);
      audio.onerror = () => setIsPlaying(false);
      audio.play();
      setIsPlaying(true);
    } catch (e) {
      console.warn("[vocab-card] clip playback failed:", e);
    }
  }, [suggestion, isPlaying]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  if (!visible || !suggestion) return null;

  const icon = suggestion.source === "audio" ? "🎧" : "👁";
  const sourceLabel = suggestion.source === "audio" ? "Overheard" : "On screen";
  const hasClip = !!suggestion.clipPath;

  return (
    <div className={`vocab-card ${exiting ? "vocab-card-exit" : ""}`}>
      <div className="vocab-card-header">
        <span className="vocab-card-source">{icon} {sourceLabel}</span>
        <div className="vocab-card-header-right">
          {hasClip && (
            <button
              onClick={handlePlayClip}
              className="vocab-card-play-btn"
              title="Replay the scene clip"
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
          )}
          <button
            onClick={handleDismissAnimated}
            className="vocab-card-close-btn"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      </div>

      <p className="vocab-card-content">{suggestion.text}</p>

      <div className="vocab-card-actions">
        <button onClick={handleNewToMe} className="vocab-card-btn vocab-card-btn-new">
          <span className="vocab-card-btn-icon">✦</span>
          Save it
        </button>
        <button onClick={handleKnowIt} className="vocab-card-btn vocab-card-btn-know">
          <span className="vocab-card-btn-icon">✓</span>
          I know it
        </button>
        <button onClick={handleExplain} className="vocab-card-btn vocab-card-btn-explain">
          <span className="vocab-card-btn-icon">💬</span>
          Explain
        </button>
      </div>
    </div>
  );
}

/**
 * Best-effort extraction of the primary word/phrase from a triage hint.
 * Looks for quoted text, bold markdown, or CJK + kana sequences.
 */
function extractWords(text: string): string[] {
  const words: string[] = [];

  // Quoted strings: 'word' or "word" or 「word」
  const quoted = text.match(/[「'""']([^「'""'」]+)[」'""']/g);
  if (quoted) {
    for (const q of quoted) {
      const inner = q.slice(1, -1).trim();
      if (inner.length > 0 && inner.length < 30) words.push(inner);
    }
  }

  // Bold markdown: **word**
  const bold = text.match(/\*\*([^*]+)\*\*/g);
  if (bold) {
    for (const b of bold) {
      const inner = b.replace(/\*\*/g, "").trim();
      if (inner.length > 0 && inner.length < 30) words.push(inner);
    }
  }

  // CJK sequences (kanji + kana)
  const cjk = text.match(/[\u3000-\u9fff\uf900-\ufaff]+/g);
  if (cjk) {
    for (const c of cjk) {
      if (c.length >= 2 && c.length < 20 && !words.includes(c)) words.push(c);
    }
  }

  // Deduplicate
  return [...new Set(words)].slice(0, 5);
}
