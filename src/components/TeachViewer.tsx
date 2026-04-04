import { useEffect, useRef, useState } from "react";
import type {
  AnnotatedContent,
  VocabAnnotation,
  GrammarAnnotation,
} from "../hooks/useTeachMode";

interface Props {
  content: AnnotatedContent;
  selectedLine: number | null;
  onSelectLine: (idx: number | null) => void;
  onAskSamuel: (question: string) => void;
  onClose: () => void;
}

type Tab = "text" | "vocab" | "grammar";

export function TeachViewer({
  content,
  selectedLine,
  onSelectLine,
  onAskSamuel,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("text");
  const [tappedWord, setTappedWord] = useState<VocabAnnotation | null>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Scroll selected line into view
  useEffect(() => {
    if (selectedLine !== null) {
      const el = lineRefs.current.get(selectedLine);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selectedLine]);

  const vocabByLine = new Map<number, VocabAnnotation[]>();
  for (const v of content.vocabulary) {
    const arr = vocabByLine.get(v.line_index) ?? [];
    arr.push(v);
    vocabByLine.set(v.line_index, arr);
  }

  const grammarByLine = new Map<number, GrammarAnnotation[]>();
  for (const g of content.grammar) {
    const arr = grammarByLine.get(g.line_index) ?? [];
    arr.push(g);
    grammarByLine.set(g.line_index, arr);
  }

  function formatTimestamp(ts: number): string {
    const m = Math.floor(ts / 60);
    const s = Math.floor(ts % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function handleWordTap(word: VocabAnnotation) {
    setTappedWord(word);
  }

  function handleExplainLine(idx: number) {
    const line = content.lines[idx];
    if (line) {
      onAskSamuel(`Explain line ${idx + 1}: "${line.text}"`);
    }
  }

  const contentTypeLabel: Record<string, string> = {
    youtube: "YouTube",
    article: "Article",
    image: "Image / Manga",
    pdf: "PDF",
    raw_text: "Text",
  };

  const videoId = (content as unknown as Record<string, unknown>).videoId as string | undefined;

  return (
    <div className="teach-overlay">
      <div className="teach-panel">
        {/* Header */}
        <div className="teach-header">
          <div className="teach-header-left">
            <span className="teach-type-badge">
              {contentTypeLabel[content.content_type] ?? content.content_type}
            </span>
            <h3 className="teach-title">{content.title ?? "Content"}</h3>
          </div>
          <div className="teach-header-right">
            <button
              className="teach-ask-btn"
              onClick={() => onAskSamuel("What's the hardest part of this content?")}
            >
              Ask Samuel
            </button>
            <button className="teach-close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {/* YouTube player embed */}
        {videoId && (
          <div className="teach-player">
            <iframe
              src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0`}
              allow="autoplay; encrypted-media"
              allowFullScreen
              title="YouTube player"
            />
          </div>
        )}

        {/* Summary */}
        {content.summary && (
          <p className="teach-summary">{content.summary}</p>
        )}

        {/* Tab bar */}
        <div className="teach-tabs">
          <button
            className={`teach-tab ${tab === "text" ? "teach-tab-active" : ""}`}
            onClick={() => setTab("text")}
          >
            Text ({content.lines.length})
          </button>
          <button
            className={`teach-tab ${tab === "vocab" ? "teach-tab-active" : ""}`}
            onClick={() => setTab("vocab")}
          >
            Vocab ({content.vocabulary.length})
          </button>
          <button
            className={`teach-tab ${tab === "grammar" ? "teach-tab-active" : ""}`}
            onClick={() => setTab("grammar")}
          >
            Grammar ({content.grammar.length})
          </button>
        </div>

        {/* Content area */}
        <div className="teach-content">
          {tab === "text" && (
            <div className="teach-lines">
              {content.lines.map((line, i) => {
                const lineVocab = vocabByLine.get(i);
                const lineGrammar = grammarByLine.get(i);
                const hasAnnotations = !!lineVocab || !!lineGrammar;
                const isSelected = selectedLine === i;

                return (
                  <div
                    key={i}
                    ref={(el) => {
                      if (el) lineRefs.current.set(i, el);
                    }}
                    className={`teach-line ${isSelected ? "teach-line-selected" : ""} ${hasAnnotations ? "teach-line-annotated" : ""}`}
                    onClick={() => onSelectLine(isSelected ? null : i)}
                  >
                    <div className="teach-line-main">
                      {line.timestamp !== null && (
                        <span className="teach-timestamp">
                          {formatTimestamp(line.timestamp)}
                        </span>
                      )}
                      <span className="teach-line-text">
                        {highlightWords(line.text, lineVocab ?? [], handleWordTap)}
                      </span>
                      {hasAnnotations && (
                        <span className="teach-line-dot" />
                      )}
                    </div>

                    {/* Inline annotations when selected */}
                    {isSelected && (
                      <div className="teach-line-detail">
                        {lineVocab?.map((v, vi) => (
                          <div key={vi} className="teach-inline-vocab">
                            <span className="teach-iv-word">{v.word}</span>
                            {v.reading && (
                              <span className="teach-iv-reading">{v.reading}</span>
                            )}
                            <span className="teach-iv-meaning">{v.meaning}</span>
                            {v.level && (
                              <span className="teach-iv-level">{v.level}</span>
                            )}
                          </div>
                        ))}
                        {lineGrammar?.map((g, gi) => (
                          <div key={gi} className="teach-inline-grammar">
                            <span className="teach-ig-pattern">{g.pattern}</span>
                            <span className="teach-ig-explanation">{g.explanation}</span>
                          </div>
                        ))}
                        <button
                          className="teach-explain-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExplainLine(i);
                          }}
                        >
                          Ask Samuel about this line
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "vocab" && (
            <div className="teach-vocab-list">
              {content.vocabulary.map((v, i) => (
                <div
                  key={i}
                  className="teach-vocab-item"
                  onClick={() => {
                    setTab("text");
                    onSelectLine(v.line_index);
                  }}
                >
                  <div className="teach-vocab-top">
                    <span className="teach-v-word">{v.word}</span>
                    {v.reading && <span className="teach-v-reading">{v.reading}</span>}
                    {v.level && <span className="teach-v-level">{v.level}</span>}
                  </div>
                  <div className="teach-v-meaning">{v.meaning}</div>
                  <div className="teach-v-context">
                    Line {v.line_index + 1}: {content.lines[v.line_index]?.text?.slice(0, 60)}…
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "grammar" && (
            <div className="teach-grammar-list">
              {content.grammar.map((g, i) => (
                <div
                  key={i}
                  className="teach-grammar-item"
                  onClick={() => {
                    setTab("text");
                    onSelectLine(g.line_index);
                  }}
                >
                  <div className="teach-g-pattern">{g.pattern}</div>
                  <div className="teach-g-explanation">{g.explanation}</div>
                  {g.example && (
                    <div className="teach-g-example">Example: {g.example}</div>
                  )}
                  <div className="teach-g-context">
                    Line {g.line_index + 1}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Word popup */}
        {tappedWord && (
          <div className="teach-word-popup" onClick={() => setTappedWord(null)}>
            <div className="teach-wp-content" onClick={(e) => e.stopPropagation()}>
              <div className="teach-wp-word">{tappedWord.word}</div>
              {tappedWord.reading && (
                <div className="teach-wp-reading">{tappedWord.reading}</div>
              )}
              <div className="teach-wp-meaning">{tappedWord.meaning}</div>
              {tappedWord.level && (
                <div className="teach-wp-level">{tappedWord.level}</div>
              )}
              <div className="teach-wp-actions">
                <button
                  onClick={() => {
                    onAskSamuel(`Explain the word "${tappedWord.word}" in detail — usage, nuance, example sentences.`);
                    setTappedWord(null);
                  }}
                >
                  Ask Samuel
                </button>
                <button onClick={() => setTappedWord(null)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Highlight annotated vocabulary words in a line of text
function highlightWords(
  text: string,
  vocab: VocabAnnotation[],
  onTap: (v: VocabAnnotation) => void,
): React.ReactNode[] {
  if (vocab.length === 0) return [text];

  // Build ranges of matches
  const matches: { start: number; end: number; vocab: VocabAnnotation }[] = [];
  for (const v of vocab) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(v.word, searchFrom);
      if (idx === -1) break;
      matches.push({ start: idx, end: idx + v.word.length, vocab: v });
      searchFrom = idx + v.word.length;
    }
  }

  if (matches.length === 0) return [text];

  // Sort by position, deduplicate overlaps
  matches.sort((a, b) => a.start - b.start);
  const merged: typeof matches = [];
  for (const m of matches) {
    const last = merged[merged.length - 1];
    if (last && m.start < last.end) continue;
    merged.push(m);
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) {
      parts.push(text.slice(cursor, m.start));
    }
    parts.push(
      <span
        key={`w-${m.start}`}
        className="teach-highlight-word"
        onClick={(e) => {
          e.stopPropagation();
          onTap(m.vocab);
        }}
      >
        {text.slice(m.start, m.end)}
      </span>,
    );
    cursor = m.end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}
