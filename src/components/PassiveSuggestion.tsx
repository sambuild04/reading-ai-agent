import { useEffect, useState, useCallback } from "react";

export interface Suggestion {
  text: string;
  source: string;
  confidence: number;
}

interface Props {
  suggestion: Suggestion | null;
  onDismiss: () => void;
  onElaborate: () => void;
}

export function PassiveSuggestion({ suggestion, onDismiss, onElaborate }: Props) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!suggestion) {
      setVisible(false);
      setFading(false);
      return;
    }
    setVisible(true);
    setFading(false);

    const fadeTimer = setTimeout(() => setFading(true), 7000);
    const hideTimer = setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, 8000);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [suggestion, onDismiss]);

  const handleElaborate = useCallback(() => {
    setVisible(false);
    onElaborate();
  }, [onElaborate]);

  if (!visible || !suggestion) return null;

  const icon = suggestion.source === "audio" ? "🎧" : "👁";

  return (
    <div className={`passive-suggestion ${fading ? "passive-suggestion-fade" : ""}`}>
      <div className="passive-suggestion-inner">
        <span className="passive-suggestion-icon">{icon}</span>
        <p className="passive-suggestion-text">{suggestion.text}</p>
        <div className="passive-suggestion-actions">
          <button
            onClick={handleElaborate}
            className="passive-suggestion-btn passive-suggestion-elaborate"
            title="Ask Samuel to explain more"
          >
            ↗
          </button>
          <button
            onClick={() => { setVisible(false); onDismiss(); }}
            className="passive-suggestion-btn passive-suggestion-close"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
