declare global {
  interface Window {
    __electronInvoke: (command: string, args: unknown) => Promise<unknown>;
  }
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return window.__electronInvoke(command, args ?? {}) as Promise<T>;
}

/**
 * Log to BOTH DevTools console AND the main process terminal so we can
 * see what's happening without opening DevTools. Use this for important
 * model/session debug events: tool calls, transcripts, response decisions.
 */
export function debugLog(tag: string, message: string, level: "log" | "warn" | "error" = "log") {
  // Local console for DevTools
  if (level === "warn") console.warn(`[${tag}]`, message);
  else if (level === "error") console.error(`[${tag}]`, message);
  else console.log(`[${tag}]`, message);
  // Forward to main process terminal (fire-and-forget)
  invoke("debug_log", { tag, message, level }).catch(() => {});
}
