import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  visible: boolean;
  onToggle: () => void;
  onDrop: (input: string) => void;
}

export function TeachDrop({ visible, onToggle, onDrop }: Props) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (val) {
      onDrop(val);
      setInputText("");
    }
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
    <div className="mailbox-popover">
      <input
        ref={inputRef}
        type="text"
        className="mailbox-input"
        placeholder="Paste a link, key, or text…"
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === "Escape") {
            onToggle();
          }
        }}
      />
      <button
        className="mailbox-send"
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
