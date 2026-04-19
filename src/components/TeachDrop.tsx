import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  visible: boolean;
  onToggle: () => void;
  onDrop: (input: string, message?: string) => void;
}

export function TeachDrop({ visible, onToggle, onDrop }: Props) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onToggle();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onToggle]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      setInputText("");
    }
  }, [visible]);

  const handleSubmit = useCallback(() => {
    const val = inputText.trim();
    if (!val) return;

    // Split: first line is the content/link, rest is the user's instruction
    const lines = val.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) {
      onDrop(val);
    } else {
      // If the user wrote a message with pasted content, pass both
      onDrop(val);
    }
    setInputText("");
  }, [inputText, onDrop]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === "string") {
                onDrop(reader.result);
              }
            };
            reader.readAsDataURL(file);
          }
          return;
        }
      }
    },
    [onDrop],
  );

  if (!visible) return null;

  return (
    <div className="chatbox-popover">
      <textarea
        ref={inputRef}
        className="chatbox-input"
        placeholder="Type or paste anything — add a question too"
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        onPaste={handlePaste}
        rows={2}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === "Escape") {
            onToggle();
          }
        }}
      />
      <button
        className="chatbox-send"
        onClick={handleSubmit}
        disabled={!inputText.trim()}
      >
        <SendIcon />
      </button>
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22 11 13 2 9z" />
    </svg>
  );
}
