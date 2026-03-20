/**
 * Bridge between the RealtimeSession transport and tool functions.
 * Allows tools (samuel.ts) to inject images directly into the
 * active Realtime conversation without a separate Vision API call.
 */

type SendImageFn = (base64Jpeg: string) => void;
type SendTextFn = (text: string) => void;
type ScreenTargetFn = (appName: string) => void;
type RecordingActionFn = (action: "start" | "stop" | "processing" | "analyze" | "results" | "error", payload?: unknown) => void;

let sendImageFn: SendImageFn | null = null;
let sendTextFn: SendTextFn | null = null;
let screenTargetFn: ScreenTargetFn | null = null;
let recordingActionFn: RecordingActionFn | null = null;

export function registerSendImage(fn: SendImageFn | null) {
  sendImageFn = fn;
}

export function registerSendText(fn: SendTextFn | null) {
  sendTextFn = fn;
}

/**
 * Inject a text message into the Realtime session as a user message
 * and trigger a response. Used when UI-driven actions need Samuel to react.
 */
export function sendTextToSession(text: string): boolean {
  if (!sendTextFn) return false;
  sendTextFn(text);
  return true;
}

export function registerScreenTarget(fn: ScreenTargetFn | null) {
  screenTargetFn = fn;
}

/**
 * Inject a captured page image directly into the Realtime session.
 * Returns true if the image was sent, false if no session is active.
 */
export function sendImageToSession(base64Jpeg: string): boolean {
  if (!sendImageFn) return false;
  sendImageFn(base64Jpeg);
  return true;
}

/** Notify the UI which app/window the agent just captured. */
export function notifyScreenTarget(appName: string) {
  screenTargetFn?.(appName);
}

export function registerRecordingAction(fn: RecordingActionFn | null) {
  recordingActionFn = fn;
}

/** Notify the UI about a recording state change. */
export function notifyRecordingAction(action: "start" | "stop" | "processing" | "analyze" | "results" | "error", payload?: unknown) {
  recordingActionFn?.(action, payload);
}
