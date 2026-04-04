import type { ContentLine } from "../hooks/useTeachMode";

// ── YouTube metadata via oEmbed ──────────────────────────────────────────────

export function extractVideoId(url: string): string | null {
  const match =
    url.match(/[?&]v=([^&#]+)/) ??
    url.match(/youtu\.be\/([^?&#]+)/) ??
    url.match(/\/embed\/([^?&#]+)/);
  return match?.[1] ?? null;
}

interface YouTubeMeta {
  title: string;
  author: string;
  videoId: string;
}

export async function fetchYouTubeMeta(url: string): Promise<YouTubeMeta> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("Invalid YouTube URL");

  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  );
  if (!res.ok) throw new Error(`oEmbed failed: ${res.status}`);

  const data = await res.json();
  return {
    title: data.title ?? "",
    author: data.author_name ?? "",
    videoId,
  };
}

// ── Parse song name from YouTube title ───────────────────────────────────────

function parseSongInfo(title: string, author: string): { track: string; artist: string } {
  // Common patterns: "Song Name / Artist", "Artist - Song Name",
  // "TVアニメ「Show」OP/ED「Song Name」", "Song Name (feat. X)"
  let track = title;
  let artist = author;

  // Strip common suffixes: [Official Video], (MV), 【MV】, etc.
  track = track
    .replace(/\s*[\[【(（].*?(official|mv|music video|pv|full|lyric|ノンクレジット|OP|ED|opening|ending).*?[\]】)）]/gi, "")
    .trim();

  // Try "Artist - Song" pattern
  const dashMatch = track.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    artist = dashMatch[1].trim();
    track = dashMatch[2].trim();
  }

  // Try "Song / Artist" pattern (common in J-pop)
  const slashMatch = track.match(/^(.+?)\s*\/\s*(.+)$/);
  if (slashMatch) {
    track = slashMatch[1].trim();
    artist = slashMatch[2].trim();
  }

  // Extract from 「Song Name」brackets
  const bracketMatch = track.match(/「(.+?)」/);
  if (bracketMatch) {
    track = bracketMatch[1].trim();
  }

  return { track, artist };
}

// ── LRCLIB lookup ────────────────────────────────────────────────────────────

interface LrcLibResult {
  syncedLyrics: string | null;
  plainLyrics: string | null;
  trackName: string;
  artistName: string;
}

async function searchLrcLib(track: string, artist: string): Promise<LrcLibResult | null> {
  // Try exact match first
  const exactUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`;
  console.log("[lyrics] LRCLIB exact:", exactUrl);

  let res = await fetch(exactUrl);
  if (res.ok) {
    const data = await res.json();
    if (data.syncedLyrics || data.plainLyrics) {
      return {
        syncedLyrics: data.syncedLyrics,
        plainLyrics: data.plainLyrics,
        trackName: data.trackName ?? track,
        artistName: data.artistName ?? artist,
      };
    }
  }

  // Try search endpoint for fuzzy match
  const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${track} ${artist}`)}`;
  console.log("[lyrics] LRCLIB search:", searchUrl);

  res = await fetch(searchUrl);
  if (res.ok) {
    const results = await res.json();
    if (Array.isArray(results) && results.length > 0) {
      const best = results[0];
      return {
        syncedLyrics: best.syncedLyrics,
        plainLyrics: best.plainLyrics,
        trackName: best.trackName ?? track,
        artistName: best.artistName ?? artist,
      };
    }
  }

  return null;
}

// ── Parse LRC format ─────────────────────────────────────────────────────────

function parseSyncedLyrics(lrc: string): ContentLine[] {
  const lines: ContentLine[] = [];
  let idx = 0;

  for (const raw of lrc.split("\n")) {
    // "[00:12.34] lyrics text" or "[00:12.345] lyrics text"
    const match = raw.match(/^\[(\d+):(\d+)\.(\d+)\]\s*(.*)$/);
    if (!match) continue;

    const text = match[4].trim();
    if (!text) continue;

    const mins = parseInt(match[1], 10);
    const secs = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, "0").slice(0, 3), 10);
    const timestamp = mins * 60 + secs + ms / 1000;

    lines.push({ text, timestamp, source_index: idx });
    idx++;
  }

  return lines;
}

function parsePlainLyrics(text: string): ContentLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l, i) => ({ text: l.trim(), timestamp: null, source_index: i }));
}

// ── Main: fetch lyrics for a YouTube URL ─────────────────────────────────────

export interface LyricsResult {
  lines: ContentLine[];
  title: string;
  artist: string;
  videoId: string;
  synced: boolean;
  source: "lrclib" | "whisper" | "none";
}

export async function fetchLyricsForYouTube(
  url: string,
  onProgress: (msg: string) => void,
): Promise<LyricsResult> {
  onProgress("Fetching video info…");
  const meta = await fetchYouTubeMeta(url);
  console.log("[lyrics] meta:", meta.title, "by", meta.author);

  const { track, artist } = parseSongInfo(meta.title, meta.author);
  console.log("[lyrics] parsed:", track, "by", artist);

  onProgress("Looking up lyrics…");
  const lrcResult = await searchLrcLib(track, artist);

  if (lrcResult) {
    console.log("[lyrics] LRCLIB hit:", lrcResult.trackName, "synced:", !!lrcResult.syncedLyrics);

    if (lrcResult.syncedLyrics) {
      const lines = parseSyncedLyrics(lrcResult.syncedLyrics);
      if (lines.length > 0) {
        return {
          lines,
          title: `${lrcResult.trackName} — ${lrcResult.artistName}`,
          artist: lrcResult.artistName,
          videoId: meta.videoId,
          synced: true,
          source: "lrclib",
        };
      }
    }

    if (lrcResult.plainLyrics) {
      const lines = parsePlainLyrics(lrcResult.plainLyrics);
      if (lines.length > 0) {
        return {
          lines,
          title: `${lrcResult.trackName} — ${lrcResult.artistName}`,
          artist: lrcResult.artistName,
          videoId: meta.videoId,
          synced: false,
          source: "lrclib",
        };
      }
    }
  }

  console.log("[lyrics] no lyrics found on LRCLIB");

  // No lyrics found — return empty so the backend can try Whisper as fallback
  return {
    lines: [],
    title: meta.title,
    artist: meta.author,
    videoId: meta.videoId,
    synced: false,
    source: "none",
  };
}
