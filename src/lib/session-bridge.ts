/**
 * Bridge between the RealtimeSession transport and tool functions.
 * Allows tools (samuel.ts) to inject images directly into the
 * active Realtime conversation without a separate Vision API call.
 */

type SendImageFn = (base64Jpeg: string) => void;
type SendTextFn = (text: string) => void;
type ScreenTargetFn = (appName: string) => void;
type RecordingActionFn = (action: "start" | "stop" | "processing" | "analyze" | "results" | "error", payload?: unknown) => void;
type LearningLanguageFn = (language: string | null) => void;
type SendSilentContextFn = (text: string) => void;
type SendTextAndRespondFn = (text: string) => void;
type TeachContentFn = (input: string, language?: string) => void;
type UIUpdateFn = (component: string, property: string, value: string) => string;

let sendImageFn: SendImageFn | null = null;
let sendTextFn: SendTextFn | null = null;
let screenTargetFn: ScreenTargetFn | null = null;
let recordingActionFn: RecordingActionFn | null = null;
let learningLanguageFn: LearningLanguageFn | null = null;
let sendSilentContextFn: SendSilentContextFn | null = null;
let sendTextAndRespondFn: SendTextAndRespondFn | null = null;
let teachContentFn: TeachContentFn | null = null;
let uiUpdateFn: UIUpdateFn | null = null;

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

// ---------------------------------------------------------------------------
// Learning Mode bridge
// ---------------------------------------------------------------------------

export function registerLearningLanguage(fn: LearningLanguageFn | null) {
  learningLanguageFn = fn;
}

/** Called by Samuel's set_learning_language tool to activate/deactivate learning mode. */
export function notifyLearningLanguage(language: string | null) {
  learningLanguageFn?.(language);
}

export function registerSendSilentContext(fn: SendSilentContextFn | null) {
  sendSilentContextFn = fn;
}

/**
 * Inject background context into the session WITHOUT triggering a response.
 * Samuel receives this as conversation history he can reference when asked,
 * but won't proactively speak about it.
 */
export function sendSilentContext(text: string): boolean {
  if (!sendSilentContextFn) return false;
  sendSilentContextFn(text);
  return true;
}

export function registerSendTextAndRespond(fn: SendTextAndRespondFn | null) {
  sendTextAndRespondFn = fn;
}

/**
 * Inject a text message into the session and trigger a model response.
 * Used by the learning mode hook to surface hints proactively.
 */
export function sendTextAndRespond(text: string): boolean {
  if (!sendTextAndRespondFn) return false;
  sendTextAndRespondFn(text);
  return true;
}

// ---------------------------------------------------------------------------
// Teach Mode bridge
// ---------------------------------------------------------------------------

export function registerTeachContent(fn: TeachContentFn | null) {
  teachContentFn = fn;
}

/** Called by Samuel's teach_from_content tool to trigger teach mode from voice. */
export function notifyTeachContent(input: string, language?: string) {
  teachContentFn?.(input, language);
}

// ---------------------------------------------------------------------------
// UI Update bridge
// ---------------------------------------------------------------------------

export function registerUIUpdate(fn: UIUpdateFn | null) {
  uiUpdateFn = fn;
}

/** Called by Samuel's update_ui tool to change UI properties via voice. */
export function applyUIUpdate(component: string, property: string, value: string): string {
  if (!uiUpdateFn) {
    console.warn("[session-bridge] applyUIUpdate called but no uiUpdateFn registered");
    return "UI update not available.";
  }
  return uiUpdateFn(component, property, value);
}

// ---------------------------------------------------------------------------
// Dismiss Card bridge
// ---------------------------------------------------------------------------

type DismissCardFn = () => void;
let dismissCardFn: DismissCardFn | null = null;

export function registerDismissCard(fn: DismissCardFn | null) {
  dismissCardFn = fn;
}

/** Dismiss the currently visible vocab card. Called by Samuel's dismiss_card tool. */
export function dismissCurrentCard(): boolean {
  if (!dismissCardFn) return false;
  dismissCardFn();
  return true;
}
