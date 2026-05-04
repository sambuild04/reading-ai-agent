import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, debugLog } from "../lib/invoke-bridge";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from "@openai/agents/realtime";
import type { FunctionTool, RealtimeOutputGuardrail, RealtimeItem } from "@openai/agents/realtime";
import { samuelAgent } from "../lib/samuel";
import { registerSendImage, registerSendText, registerScreenTarget, registerSendSilentContext, registerSendTextAndRespond, registerSendAudioClip, registerReloadPlugins, notifyLearningLanguage, registerSetVolume } from "../lib/session-bridge";
import { loadAllPlugins } from "../lib/plugin-loader";

// ---------------------------------------------------------------------------
// Output Guardrails — monitor Samuel's speech in real-time and cut off if needed.
// Each guardrail runs periodically as transcript text accumulates.
// If tripwireTriggered=true, Samuel's audio is cancelled and the policyHint
// is fed back to the model so it self-corrects.
// ---------------------------------------------------------------------------

const outputGuardrails: RealtimeOutputGuardrail[] = [
  {
    name: "no_unprompted_teaching",
    policyHint:
      "Do not teach or explain language vocabulary unless the user explicitly asked for it " +
      "or there is confirmed audio/screen content in the target language. Stay silent about language unless prompted.",
    async execute({ agentOutput }) {
      const text = typeof agentOutput === "string" ? agentOutput : String(agentOutput);
      const teachingPatterns = [
        /\bin japanese\b.*\bmeans?\b/i,
        /\bthe word\b.*\b(means?|is)\b/i,
        /\bvocabulary\b.*\bword\b/i,
        /\bI (heard|noticed|detected|saw)\b.*\b(japanese|chinese|korean)\b/i,
        /\bN[1-5] level\b/i,
      ];
      const hasTeaching = teachingPatterns.some((p) => p.test(text));
      const isUnprompted = hasTeaching && text.length < 300 && !text.includes("[System:");
      return { tripwireTriggered: isUnprompted, outputInfo: { hasTeaching, length: text.length } };
    },
  },
  {
    name: "no_self_conversation",
    policyHint:
      "Stop talking to yourself. Only speak when responding to the user or delivering a tool result. " +
      "Do not narrate, monologue, or repeat yourself.",
    async execute({ agentOutput }) {
      const text = typeof agentOutput === "string" ? agentOutput : String(agentOutput);
      const sentences = text.split(/[.!?]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const unique = new Set(sentences);
      const isRepetitive = sentences.length > 3 && unique.size <= Math.ceil(sentences.length / 3);
      return { tripwireTriggered: isRepetitive, outputInfo: { sentences: sentences.length, unique: unique.size } };
    },
  },
];

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

/** Merge core + plugin tools, letting plugins override core tools by name. */
function mergeTools(coreTools: FunctionTool[], pluginTools: FunctionTool[]): FunctionTool[] {
  const pluginNames = new Set(pluginTools.map((t) => t.name));
  const filtered = coreTools.filter((t) => !pluginNames.has(t.name));
  return [...filtered, ...pluginTools];
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "status" | "approval";
  text: string;
  timestamp: number;
  /** Present only for role === "approval" */
  approval?: {
    toolName: string;
    args?: Record<string, unknown>;
    state: "pending" | "approved" | "denied";
  };
}

// Session keepalive & rotation constants
const HEARTBEAT_INTERVAL_MS = 30_000; // ping every 30s to prevent server-side idle timeout
const SESSION_ROTATION_MS = 25 * 60 * 1000; // reconnect every 25 min (before 60-min hard cap)
const CONTEXT_WINDOW_TURNS = 6; // carry this many turns across reconnections
const AUTO_SCREEN_COOLDOWN_MS = 5_000; // min 5s between auto-screen injections to prevent token flood
// If transcript hasn't arrived this long after speech_stopped, fall back to capturing
// context anyway — transcription is occasionally slow or fails.
const TRANSCRIPT_WAIT_MS = 2_500;
// Short utterances like "yes", "sounds good", "thanks" don't need a fresh screen
// capture — the prior turn's context is still in the conversation. Skipping the
// AX read + screenshot saves ~1-2s, ~150 KB of tokens, and a screenshot upload.
const ACK_PHRASES = new Set([
  "ok", "okay", "yes", "yeah", "yep", "yup", "no", "nope", "sure",
  "thanks", "thank you", "thx", "ty", "got it", "sounds good", "good",
  "great", "cool", "nice", "alright", "right", "correct", "exactly",
  "perfect", "awesome", "fine", "done", "stop", "wait",
  "go on", "continue", "please continue", "keep going", "next",
  "really", "interesting", "wow", "huh", "hmm", "ah", "oh",
  "i see", "makes sense", "noted", "understood", "agreed",
  "let me think", "hold on", "one second", "one moment",
]);

function isConversationalAck(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[.!?,'"…]/g, "").trim();
  if (!normalized) return false;
  // Direct match
  if (ACK_PHRASES.has(normalized)) return true;
  // Very short utterance under 20 chars with no question mark / no app/screen
  // related keywords — almost certainly an ack.
  if (
    text.length <= 20 &&
    !text.includes("?") &&
    !/\b(read|show|tell|what|who|where|when|why|how|check|look|see|find|open|click|type|gmail|email|tab|chrome|safari|browser|screen|youtube|wechat|order|message|page)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface UseRealtimeReturn {
  status: ConnectionStatus;
  transcript: TranscriptEntry[];
  agentState: "idle" | "listening" | "thinking" | "speaking";
  screenTarget: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  mute: (muted: boolean) => void;
  isMuted: boolean;
  setWakeWordMode: (on: boolean) => void;
  setSuppressIdle: (suppress: boolean) => void;
  prefetchKey: () => void;
  /** Stop Samuel mid-speech (e.g. "stop talking" button) */
  interrupt: () => void;
  /** Approve a pending tool call by its transcript entry ID */
  approveToolCall: (entryId: string) => void;
  /** Deny a pending tool call by its transcript entry ID */
  denyToolCall: (entryId: string) => void;
  /** Approve + remember per-app permission so this app is never asked again */
  alwaysAllowApp: (entryId: string, appName: string) => void;
  /** Deny + remember per-app permission so this app is always blocked */
  alwaysDenyApp: (entryId: string, appName: string) => void;
  /** Send a typed text message (shows in transcript + triggers model response) */
  sendText: (text: string) => void;
}

// Common hallucinations the transcriber produces from speaker echo / room reverb.
// Checked only within the echo guard window (first few seconds after agent speaks).
const ECHO_PHRASES = new Set([
  "thank you",
  "thanks",
  "you",
  "bye",
  "okay",
  "ok",
  "yes",
  "yeah",
  "no",
  "hmm",
  "hm",
  "hello",
  "hi",
  "hey",
  "good evening",
  "good morning",
  "good night",
  "good day",
  "good day sir",
  "good evening sir",
  "good morning sir",
  "sir",
  "chatgpt",
  "send me",
  "thank you sir",
  "thanks sir",
  "at your service",
  "how may i",
  "how may i assist",
  "how may i assist you",
  "how may i be of assistance",
  "how can i help",
  "how can i assist",
  "samuel",
  "samly",
  "kit",
]);

let entryCounter = 0;
function makeEntry(
  role: TranscriptEntry["role"],
  text: string,
): TranscriptEntry {
  return { id: String(++entryCounter), role, text, timestamp: Date.now() };
}

export function useRealtime(): UseRealtimeReturn {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [agentState, setAgentState] = useState<
    "idle" | "listening" | "thinking" | "speaking"
  >("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [screenTarget, setScreenTarget] = useState<string | null>(null);
  const screenTargetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const micStreamRef = useRef<Promise<MediaStream | undefined> | null>(null);

  // Pending tool approvals — maps transcript entry ID to the SDK approval item
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingApprovalsRef = useRef<Map<string, any>>(new Map());

  // Conversation context buffer — carried across reconnections
  const contextRef = useRef<ConversationTurn[]>([]);

  // Timers for keepalive and session rotation
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRotatingRef = useRef(false);

  // Pre-fetched ephemeral key — start the API call before connect() to overlap latency
  const prefetchedKeyRef = useRef<Promise<string> | null>(null);

  // Streaming assistant buffer
  const assistantBufferRef = useRef("");
  const assistantEntryIdRef = useRef<string | null>(null);

  // Placeholder entry for the user's speech (inserted early so ordering is correct)
  const userPendingIdRef = useRef<string | null>(null);

  // Track whether the user manually muted so we don't override their choice
  const userMutedRef = useRef(false);

  // Echo guard: timestamp when agent last finished speaking.
  // Transcriptions arriving shortly after are likely echo, not real user speech.
  const lastAgentSpeechEndRef = useRef(0);

  // Keep track of the last full agent response text — used to detect echo that
  // partially repeats what Samuel just said.
  const lastAgentTextRef = useRef("");

  // Count completed agent responses. The first response is always the greeting —
  // any VAD trigger immediately after it is guaranteed to be echo, not user speech.
  const agentResponseCountRef = useRef(0);

  // Rate-limit auto-screen injections to prevent flooding the session with images.
  const lastAutoScreenRef = useRef(0);
  // Track the last auto-screen item ID so we can delete stale screenshots.
  // Only ONE screenshot should exist in context at a time (prevents "this" confusion).
  const lastScreenItemIdRef = useRef<string | null>(null);
  // Hash of the last AX text we injected. We skip re-injection when the
  // screen hasn't materially changed — the model already has it.
  const lastAxHashRef = useRef<string>("");

  // Deferred-context state: speech_stopped sets this up but waits for the
  // transcript before deciding whether to capture+inject screen data.
  // - pendingTurnRef.current is true between speech_stopped and the decision
  //   (transcript completed OR fallback timeout).
  // - pendingTurnTimerRef fires the fallback if transcription is silent.
  const pendingTurnRef = useRef(false);
  const pendingTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Forward declaration; the actual function is defined inside the session
  // setup closure (it needs access to sessionRef, etc.). We assign through
  // this ref so the speech_stopped fallback timer can call it.
  const decideAndRespondRef = useRef<((transcript: string) => void) | null>(null);
  // True while a response is being generated (audio may still be playing).
  // Mic stays muted until this goes false + delay, preventing mid-sentence cutoff.
  const responseInProgressRef = useRef(false);

  // Wake word mode: after Samuel speaks, don't auto-unmute. Instead start an
  // inactivity timer. If user speaks within the window, keep going. If not,
  // mute mic and set agentState to "idle" (signals wake word should re-enable).
  const wakeWordModeRef = useRef(false);
  const suppressIdleRef = useRef(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  };

  // No client-side inactivity timer — once awake, Samuel stays listening.
  const startInactivityTimer = () => {};

  const stopKeepalive = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
  }, []);

  // Record a conversation turn into the rolling context buffer
  const recordTurn = useCallback((role: "user" | "assistant", text: string) => {
    if (!text.trim()) return;
    contextRef.current.push({ role, text });
    if (contextRef.current.length > CONTEXT_WINDOW_TURNS) {
      contextRef.current = contextRef.current.slice(-CONTEXT_WINDOW_TURNS);
    }
  }, []);

  // Managed audio element for Samuel's voice output — allows volume control
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  if (!audioElementRef.current) {
    audioElementRef.current = document.createElement("audio");
    audioElementRef.current.autoplay = true;
  }

  useEffect(() => {
    // Chromium WebRTC provides hardware-accelerated AEC — no mute workarounds needed.
    micStreamRef.current = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }).catch((e) => {
      console.warn("[session] mic request failed, will use SDK default:", e);
      return undefined;
    });

    const transport = new OpenAIRealtimeWebRTC({
      audioElement: audioElementRef.current!,
    });

    // Stable session ID for tracing — persists across reconnections
    const sessionGroupId = `samuel_${Date.now()}`;

    const session = new RealtimeSession(samuelAgent, {
      transport,
      model: "gpt-realtime",
      // Output guardrails — cut off unsafe/unwanted speech mid-generation
      outputGuardrails,
      outputGuardrailSettings: { debounceTextLength: 150 },
      // Tracing — correlate all events for debugging
      groupId: sessionGroupId,
      workflowName: "samuel-voice",
      traceMetadata: { app: "samuel", version: "1.0" },
      // Custom tool error formatter — gives the model actionable hints instead of raw errors.
      toolErrorFormatter: ({ toolName, kind, defaultMessage }) => {
        if (kind === "approval_rejected") {
          return `Tool "${toolName}" was not approved by the user. Ask if they want to proceed differently.`;
        }
        return `Tool "${toolName}" error: ${defaultMessage}. Try a different approach or tell the user.`;
      },
      config: {
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
              language: "en",
            },
            noiseReduction: { type: "far_field" },
            turnDetection: {
              type: "server_vad",
              threshold: 0.9,
              prefixPaddingMs: 300,
              silenceDurationMs: 1200,
              // CRITICAL: do NOT auto-respond on speech_stopped.
              // We manually trigger response.create AFTER injecting AX tree + screenshot,
              // so the model has full context before generating its reply.
              create_response: false,
            },
          },
          output: {
            voice: "ash",
          },
        },
      },
    });

    sessionRef.current = session;

    // Register volume control so tools/preferences can adjust Samuel's voice
    registerSetVolume((pct: number) => {
      if (audioElementRef.current) {
        audioElementRef.current.volume = Math.max(0, Math.min(1, pct / 100));
      }
    });

    // Auto-mute mic while Samuel speaks to prevent echo feedback in WKWebView.
    // Mic stays muted until response.done + delay (not audio_stopped) so the
    // full sentence plays without risk of VAD-triggered cancellation mid-speech.
    session.on("audio_start", () => {
      setAgentState("speaking");
      responseInProgressRef.current = true;
      if (!userMutedRef.current) {
        session.mute(true);
      }
    });

    session.on("audio_stopped", () => {
      lastAgentSpeechEndRef.current = Date.now();
      // Don't unmute here — wait for response.done to ensure full playback
      if (!responseInProgressRef.current) {
        setAgentState("listening");
      }
    });

    let toolTimeoutId: ReturnType<typeof setTimeout> | null = null;
    session.on("agent_tool_start", (_ctx, _agent, tool, details) => {
      setAgentState("thinking");
      const toolName = tool?.name ?? (typeof tool === "string" ? tool : "unknown");
      let argsPreview = "";
      try {
        const args = (details as Record<string, unknown>)?.toolCall ?? details;
        const argsStr = typeof args === "string" ? args : JSON.stringify(args);
        argsPreview = argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr;
      } catch {
        argsPreview = "(could not stringify args)";
      }
      debugLog("tool-call", `START ${toolName} args=${argsPreview}`);
      if (toolTimeoutId) clearTimeout(toolTimeoutId);
      toolTimeoutId = setTimeout(() => {
        debugLog("tool-call", `TIMEOUT ${toolName} — recovering UI from stuck thinking`, "warn");
        setAgentState("listening");
        responseInProgressRef.current = false;
      }, 30_000);
    });
    session.on("agent_tool_end", (_ctx, _agent, tool, result) => {
      if (toolTimeoutId) { clearTimeout(toolTimeoutId); toolTimeoutId = null; }
      setAgentState("listening");
      const toolName = tool?.name ?? (typeof tool === "string" ? tool : "unknown");
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      const preview = resultStr ? (resultStr.length > 400 ? resultStr.slice(0, 400) + "..." : resultStr) : "(empty)";
      debugLog("tool-call", `END   ${toolName} result=${preview}`);
    });

    // Guardrail tripped — Samuel said something he shouldn't have.
    // Use session.interrupt() to immediately stop the audio output.
    session.on("guardrail_tripped", (_ctx, _agent, error) => {
      const name = error?.result?.guardrail?.name ?? "unknown";
      console.warn(`[guardrail] tripped: ${name}`, error.message);
      // Immediately cut off the unwanted speech
      try { session.interrupt(); } catch {}
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `[Guardrail: ${name} — correcting]`),
      ]);
    });

    // Tool approval — show an interactive card the user can approve or deny
    session.on("tool_approval_requested", (_ctx, _agent, request) => {
      if (request.type === "function_approval") {
        const toolName = request.tool.name;
        console.log(`[approval] tool '${toolName}' needs approval`);

        const entryId = String(++entryCounter);
        pendingApprovalsRef.current.set(entryId, request.approvalItem);

        setTranscript((prev) => [
          ...prev,
          {
            id: entryId,
            role: "approval" as const,
            text: `Use tool "${toolName}"`,
            timestamp: Date.now(),
            approval: { toolName, state: "pending" },
          },
        ]);
      } else {
        // MCP / non-function approvals — auto-approve silently
        session.approve(request.approvalItem).catch(() => {});
      }
    });

    // Agent handoff — log when Samuel delegates to a specialist
    session.on("agent_handoff", (_ctx, fromAgent, toAgent) => {
      console.log(`[handoff] ${fromAgent.name} → ${toAgent.name}`);
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `[${toAgent.name} active]`),
      ]);
    });

    // History events — keep SDK history as source of truth for debugging
    session.on("history_updated", (history: RealtimeItem[]) => {
      console.log(`[history] updated: ${history.length} items`);
    });
    session.on("history_added", (item: RealtimeItem) => {
      // Prune stale screenshots from SDK history when a new one arrives.
      // This prevents the model from referencing old "this" screenshots.
      if (item.type === "message" && "role" in item && item.role === "user") {
        const hasImage = ("content" in item) && Array.isArray(item.content) &&
          item.content.some((c: Record<string, unknown>) => c.type === "input_image");
        if (hasImage && lastScreenItemIdRef.current && item.itemId !== lastScreenItemIdRef.current) {
          // Use updateHistory to remove the stale screenshot
          const staleId = lastScreenItemIdRef.current;
          session.updateHistory((h: RealtimeItem[]) =>
            h.filter((i: RealtimeItem) => i.itemId !== staleId)
          );
          console.log(`[history] pruned stale screenshot ${staleId}`);
        }
      }
    });

    session.on("error", (error: unknown) => {
      console.error("[session] error:", error);
      const msg =
        typeof error === "object" && error !== null
          ? JSON.stringify(error, null, 2)
          : String(error);
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Error: ${msg}`),
      ]);
    });

    // Detect server-side session close (idle timeout, network drop, etc.)
    // so the next wake word triggers a fresh reconnect.
    // Handled via transport wildcard events ("session.closed" / "close").

    // ── Smart context-injection decision ──────────────────────────────────
    // Called ONCE per turn after we know the transcript (or fallback timeout).
    // Decides whether to refresh AX/screenshot context based on:
    //   1. Was it a conversational ack? ("sounds good", "ok", "thanks") → skip
    //   2. Has the screen materially changed since last injection? → skip if not
    //   3. Are we still in cooldown / pre-greeting? → skip
    // Always triggers response.create at the end so the model replies.
    const decideAndRespond = (transcript: string) => {
      // Cheap djb2 hash — used to detect whether AX content changed materially.
      const cheapHash = (s: string): string => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
          h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return h.toString(36);
      };

      const triggerResponse = () => {
        try {
          sessionRef.current?.transport.sendEvent({ type: "response.create" });
          debugLog("turn", "response.create triggered");
        } catch (e) {
          debugLog("turn", `response.create failed: ${e}`, "warn");
        }
      };

      const now = Date.now();
      const elapsed = now - lastAutoScreenRef.current;
      const pastGreeting = agentResponseCountRef.current >= 1;

      // Reason 1: conversational ack — model has prior context, just respond
      if (transcript && isConversationalAck(transcript)) {
        debugLog("turn", `ack detected ("${transcript}") — skipping context refresh`);
        triggerResponse();
        return;
      }

      // Reason 2: still in pre-greeting or recent cooldown
      if (!pastGreeting || elapsed < AUTO_SCREEN_COOLDOWN_MS) {
        debugLog("turn", `skipping context inject (pastGreeting=${pastGreeting}, elapsed=${elapsed}ms)`);
        triggerResponse();
        return;
      }

      lastAutoScreenRef.current = now;

      const axPromise = invoke<string>("read_app_content", { appName: null, multi: true })
        .catch((e) => { debugLog("ctx", `AX read failed: ${e}`, "warn"); return ""; });
      const shotPromise = invoke<{ base64: string; app_name: string; display_context?: string }>("capture_screen_now")
        .catch((e) => { debugLog("ctx", `screenshot failed: ${e}`, "warn"); return null; });

      Promise.all([axPromise, shotPromise]).then(([axText, shot]) => {
        if (!sessionRef.current) return;

        const truncated = axText && axText.length > 6000
          ? axText.slice(0, 6000) + "\n...(truncated)"
          : axText ?? "";
        // Hash only the truncated payload — that's what the model would see.
        const axHash = truncated ? cheapHash(truncated) : "";
        const axChanged = !!axHash && axHash !== lastAxHashRef.current;

        // Reason 3: nothing new on screen — skip injection entirely
        if (!axChanged && !shot?.base64) {
          debugLog("ctx", `screen unchanged (hash=${axHash}) — skipping inject`);
          triggerResponse();
          return;
        }

        // Delete previous context (single-image rule)
        if (lastScreenItemIdRef.current) {
          try {
            sessionRef.current.transport.sendEvent({
              type: "conversation.item.delete",
              item_id: lastScreenItemIdRef.current,
            });
          } catch { /* may already be gone */ }
        }

        const itemId = `ctx_${now}`;
        const content: Array<Record<string, string>> = [];

        if (truncated && truncated.trim().length > 20) {
          content.push({
            type: "input_text",
            text: `[Screen content from all visible apps (Accessibility Tree — exact text):\n${truncated}]`,
          });
        }

        if (shot?.base64) {
          content.push({
            type: "input_image",
            image_url: `data:image/jpeg;base64,${shot.base64}`,
          });
        }

        if (content.length > 0) {
          try {
            sessionRef.current.transport.sendEvent({
              type: "conversation.item.create",
              item: { id: itemId, type: "message", role: "user", content },
            });
            lastScreenItemIdRef.current = itemId;
            lastAxHashRef.current = axHash;
            debugLog(
              "ctx",
              `injected AX(${axText?.length ?? 0} chars, changed=${axChanged}) + screenshot(${shot ? "yes" : "no"}) | item_id=${itemId}`,
            );
          } catch (e) {
            debugLog("ctx", `inject failed: ${e}`, "warn");
          }
        } else {
          debugLog("ctx", "both AX and screenshot empty — no context injected", "warn");
        }

        triggerResponse();
      }).catch((e) => {
        debugLog("ctx", `context promise failed: ${e}`, "warn");
        triggerResponse();
      });
    };
    decideAndRespondRef.current = decideAndRespond;

    // Raw transport events for real-time transcript display
    session.transport.on("*", (event: Record<string, unknown>) => {
      const type = event.type as string;

      switch (type) {
        case "input_audio_buffer.speech_started": {
          debugLog("turn", "speech_started");
          setAgentState("listening");
          // User is speaking — cancel any inactivity timer (keep conversation alive)
          clearInactivityTimer();
          // Insert a placeholder now so the user bubble appears before the agent reply
          const placeholder = makeEntry("user", "...");
          userPendingIdRef.current = placeholder.id;
          setTranscript((prev) => [...prev, placeholder]);
          break;
        }

        case "response.created": {
          const resp = event.response as Record<string, unknown> | undefined;
          debugLog("response", `CREATED id=${resp?.id ?? "?"} status=${resp?.status ?? "?"}`);
          break;
        }

        case "conversation.item.created": {
          const item = event.item as Record<string, unknown> | undefined;
          if (item) {
            const role = item.role as string | undefined;
            const itemType = item.type as string | undefined;
            const itemId = item.id as string | undefined;
            if (role === "user" || itemType === "function_call" || itemType === "function_call_output") {
              const content = item.content as Array<Record<string, unknown>> | undefined;
              const summary = content?.map((c) => `${c.type}:${typeof c.text === "string" ? (c.text as string).slice(0, 60) : ""}`).join("|") ?? "";
              debugLog("item-created", `role=${role ?? itemType} id=${itemId} content=${summary}`);
            }
          }
          break;
        }

        case "input_audio_buffer.speech_stopped":
          setAgentState("thinking");
          debugLog("turn", "speech_stopped — waiting for transcript to decide on context");
          // We DEFER the heavy AX read + screenshot until we know what the user
          // actually said. Conversational acks like "sounds good" don't need a
          // fresh screen capture; the prior turn's context is still available.
          // The transcript event normally arrives within a few hundred ms.
          // If it doesn't arrive within TRANSCRIPT_WAIT_MS, we fall back to
          // capturing context anyway (treat as "real query").
          pendingTurnRef.current = true;
          if (pendingTurnTimerRef.current) clearTimeout(pendingTurnTimerRef.current);
          pendingTurnTimerRef.current = setTimeout(() => {
            if (pendingTurnRef.current) {
              debugLog("turn", `no transcript after ${TRANSCRIPT_WAIT_MS}ms — capturing context anyway`);
              pendingTurnRef.current = false;
              decideAndRespondRef.current?.(""); // empty = treat as real query
            }
          }, TRANSCRIPT_WAIT_MS);
          break;

        case "conversation.item.input_audio_transcription.completed": {
          const text = (event.transcript as string)?.trim();
          const pendingId = userPendingIdRef.current;
          userPendingIdRef.current = null;

          debugLog("transcript", `user said: "${text}"`);

          const isNoise = !text || text.length <= 2;

          // Relaxed echo guard: rely on WebRTC AEC + post-speech mute (audio_stopped handler).
          // Only drop confirmed echoes (exact substring of Samuel's last reply or known phrase).
          const msSinceAgentSpoke = Date.now() - lastAgentSpeechEndRef.current;
          const echoWindow = 1500;
          const normalized = text ? text.toLowerCase().replace(/[.!?,'"]/g, "").trim() : "";

          const lastAgentLower = lastAgentTextRef.current.toLowerCase();
          const isPartialEcho = normalized.length > 3 && lastAgentLower.includes(normalized);

          const isLikelyEcho =
            msSinceAgentSpoke < echoWindow &&
            !!text &&
            (ECHO_PHRASES.has(normalized) || isPartialEcho);

          if (isNoise || isLikelyEcho) {
            if (isLikelyEcho) {
              debugLog("echo-guard", `DROPPED "${text}" (${msSinceAgentSpoke}ms after agent)`);
            } else if (isNoise) {
              debugLog("echo-guard", `noise dropped: "${text}"`);
            }
            if (pendingId) {
              setTranscript((prev) => prev.filter((e) => e.id !== pendingId));
            }
            // Cancel any pending turn so the fallback timer doesn't fire and
            // we don't trigger a response for the dropped echo.
            if (pendingTurnRef.current) {
              pendingTurnRef.current = false;
              if (pendingTurnTimerRef.current) {
                clearTimeout(pendingTurnTimerRef.current);
                pendingTurnTimerRef.current = null;
              }
              debugLog("turn", "pending turn cancelled (echo/noise)");
            }
            break;
          }

          recordTurn("user", text);
          if (pendingId) {
            setTranscript((prev) =>
              prev.map((e) => (e.id === pendingId ? { ...e, text } : e)),
            );
          } else {
            setTranscript((prev) => [...prev, makeEntry("user", text)]);
          }

          // Now that we have a real transcript, decide whether to refresh
          // screen context and trigger the response.
          if (pendingTurnRef.current) {
            pendingTurnRef.current = false;
            if (pendingTurnTimerRef.current) {
              clearTimeout(pendingTurnTimerRef.current);
              pendingTurnTimerRef.current = null;
            }
            decideAndRespondRef.current?.(text);
          }
          break;
        }

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta": {
          const delta = event.delta as string;
          if (delta) {
            setAgentState("speaking");
            assistantBufferRef.current += delta;
            if (!assistantEntryIdRef.current) {
              const entry = makeEntry(
                "assistant",
                assistantBufferRef.current,
              );
              assistantEntryIdRef.current = entry.id;
              setTranscript((prev) => [...prev, entry]);
            } else {
              const id = assistantEntryIdRef.current;
              const text = assistantBufferRef.current;
              setTranscript((prev) =>
                prev.map((e) => (e.id === id ? { ...e, text } : e)),
              );
            }
          }
          break;
        }

        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done": {
          const finalText = event.transcript as string;
          if (finalText) {
            lastAgentTextRef.current = finalText;
            recordTurn("assistant", finalText);
            // Feed Samuel's spoken text to the self-voice filter so the
            // learning audio doesn't capture and re-process his own speech.
            invoke("record_samuel_speech", { text: finalText }).catch(() => {});
            if (assistantEntryIdRef.current) {
              const id = assistantEntryIdRef.current;
              setTranscript((prev) =>
                prev.map((e) =>
                  e.id === id ? { ...e, text: finalText } : e,
                ),
              );
            }
          }
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          break;
        }

        case "response.done": {
          // Log response details so we can see what the model decided
          const resp = event.response as Record<string, unknown> | undefined;
          const respStatus = resp?.status as string | undefined;
          const respOutput = resp?.output as Array<Record<string, unknown>> | undefined;
          const finalText = lastAgentTextRef.current || assistantBufferRef.current;
          const toolCalls = (respOutput ?? []).filter((o) => o.type === "function_call" || o.type === "tool_call");
          debugLog("response", `DONE status=${respStatus} text="${finalText.slice(0, 200)}${finalText.length > 200 ? "..." : ""}" tool_calls=${toolCalls.length}`);
          if (toolCalls.length > 0) {
            for (const tc of toolCalls) {
              const argsStr = typeof tc.arguments === "string" ? tc.arguments.slice(0, 200) : JSON.stringify(tc.arguments).slice(0, 200);
              debugLog("response", `  └─ tool: ${tc.name ?? "?"} args=${argsStr}`);
            }
          }

          if (assistantBufferRef.current && assistantEntryIdRef.current) {
            lastAgentTextRef.current = assistantBufferRef.current;
          }
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          agentResponseCountRef.current += 1;
          responseInProgressRef.current = false;
          setAgentState("listening");

          // NOW unmute — the full response has been generated and audio
          // buffers are flushing. Delay lets remaining audio play out.
          if (!userMutedRef.current && session.muted === true) {
            const isGreeting = agentResponseCountRef.current <= 1;
            const unmuteDelay = isGreeting ? 3000 : 1500;
            setTimeout(() => {
              if (!userMutedRef.current && sessionRef.current) {
                try { sessionRef.current.mute(false); } catch {}
              }
              if (wakeWordModeRef.current) {
                startInactivityTimer();
              }
            }, unmuteDelay);
          }
          break;
        }

        case "response.cancelled": {
          // User interrupted mid-tool or mid-speech — reset state so UI
          // doesn't stay stuck on "thinking/working"
          responseInProgressRef.current = false;
          setAgentState("listening");
          if (!userMutedRef.current && session.muted === true) {
            setTimeout(() => {
              if (!userMutedRef.current && sessionRef.current) {
                try { sessionRef.current.mute(false); } catch {}
              }
            }, 500);
          }
          break;
        }

        case "error": {
          const err = event.error as Record<string, unknown>;
          const msg = (err?.message as string) ?? "Unknown error";
          const code = err?.code as string | undefined;
          const type = err?.type as string | undefined;
          debugLog("session-error", `type=${type} code=${code} msg=${msg}`, "error");
          setTranscript((prev) => [
            ...prev,
            makeEntry("status", `Error: ${msg}`),
          ]);
          break;
        }

        case "session.closed":
        case "close": {
          stopKeepalive();
          if (isRotatingRef.current) {
            // Planned rotation — reconnect() handles the rest
            console.log("[session] planned rotation close");
          } else {
            // Unexpected drop — auto-reconnect if we were connected
            console.log("[session] transport closed unexpectedly, will auto-reconnect");
            setStatus("disconnected");
            setAgentState("idle");
            // Auto-reconnect after a short delay
            setTimeout(() => {
              if (sessionRef.current) {
                console.log("[session] auto-reconnecting...");
                connectRef.current?.();
              }
            }, 2000);
          }
          break;
        }

        default:
          break;
      }
    });

    // Register screen target callback — shows a brief toast of which app was captured
    registerScreenTarget((appName: string) => {
      setScreenTarget(appName);
      if (screenTargetTimerRef.current) clearTimeout(screenTargetTimerRef.current);
      screenTargetTimerRef.current = setTimeout(() => setScreenTarget(null), 3000);
    });

    // Register text bridge so UI actions can prompt Samuel to speak.
    // Uses SDK's sendMessage() which handles item creation + response trigger.
    registerSendText((text: string) => {
      session.sendMessage(text);
    });

    // Plugin reload: loads all dynamic plugins and updates the live agent.
    // Also re-injects memory so it's not lost when tools are updated.
    const doReloadPlugins = async () => {
      try {
        const [pluginTools, memoryCtx] = await Promise.all([
          loadAllPlugins(),
          invoke<string>("memory_get_context").catch(() => ""),
        ]);
        const coreTools = samuelAgent.tools as FunctionTool[];
        const merged = mergeTools(coreTools, pluginTools);
        let instructions = samuelAgent.instructions as string;
        if (memoryCtx && memoryCtx !== "No prior context.") {
          instructions += `\n\n# Persistent Memory (from previous sessions)\n${memoryCtx}\nFollow these memories strictly. Do not repeat vocabulary marked as known.\nIMPORTANT: Regardless of any language content in memory above, you MUST speak in ENGLISH unless the user explicitly asks otherwise.`;
        }
        const updatedAgent = new RealtimeAgent({
          name: samuelAgent.name,
          instructions,
          tools: merged,
          voice: "ash",
        });
        await session.updateAgent(updatedAgent);
        console.log(`[plugins] agent updated: ${merged.length} tools (${pluginTools.length} from plugins), memory=${memoryCtx.length > 0 ? "yes" : "no"}`);
      } catch (err) {
        console.error("[plugins] reload failed:", err);
      }
    };
    registerReloadPlugins(doReloadPlugins);

    // Register the image bridge so tools can inject screenshots.
    // Uses SDK's addImage() — cleaner, handles encoding and error recovery.
    registerSendImage((base64Jpeg: string) => {
      session.addImage(`data:image/jpeg;base64,${base64Jpeg}`, { triggerResponse: false });
    });

    // Silent context: inject background info Samuel can reference but won't speak about.
    // Uses updateHistory to prune the previous context, keeping conversation lean.
    let silentContextId: string | null = null;
    registerSendSilentContext((text: string) => {
      // Prune previous silent context from history
      if (silentContextId) {
        const oldId = silentContextId;
        session.updateHistory((h: RealtimeItem[]) =>
          h.filter((item: RealtimeItem) => item.itemId !== oldId)
        );
      }
      const id = `ctx_${Date.now()}`;
      silentContextId = id;
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
    });

    // Bridge for learning mode: inject a system hint and trigger Samuel to respond.
    // Skips if the model is already generating a response to avoid session saturation.
    // Uses SDK's sendMessage() for proper item creation + response trigger.
    registerSendTextAndRespond((text: string) => {
      if (responseInProgressRef.current) {
        console.log("[session] skipping sendTextAndRespond — model is busy");
        return;
      }
      session.sendMessage(text);
    });

    // Inject PCM16 audio clips directly into the session so the model can hear
    // system audio (anime, games, videos) rather than just reading transcripts.
    registerSendAudioClip((pcmBase64: string, contextText?: string) => {
      const content: Array<Record<string, string>> = [];
      if (contextText) {
        content.push({ type: "input_text", text: contextText });
      }
      content.push({ type: "input_audio", audio: pcmBase64 });
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content,
        },
      });
    });

    return () => {
      registerSendImage(null);
      registerSendText(null);
      registerScreenTarget(null);
      registerSendSilentContext(null);
      registerSendTextAndRespond(null);
      registerSendAudioClip(null);
      registerReloadPlugins(null);
      stopKeepalive();
      session.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectRef = useRef<(() => Promise<void>) | null>(null);

  const prefetchKey = useCallback(() => {
    if (!prefetchedKeyRef.current) {
      console.log("[session] prefetching ephemeral key");
      prefetchedKeyRef.current = invoke<string>("create_ephemeral_key").catch((err) => {
        prefetchedKeyRef.current = null;
        throw err;
      });
    }
  }, []);

  const connect = useCallback(async () => {
    if (status === "connected" && !isRotatingRef.current) return;
    stopKeepalive();

    const session = sessionRef.current;
    if (!session) return;

    // If previous session died or rotating, close it cleanly
    try { session.close(); } catch {}

    const isReconnect = contextRef.current.length > 0;
    setStatus("connecting");
    if (!isReconnect) {
      setTranscript([makeEntry("status", "Connecting...")]);
    }

    try {
      // Use prefetched key if available, otherwise fetch with a 10s timeout
      let keyPromise = prefetchedKeyRef.current || invoke<string>("create_ephemeral_key");
      prefetchedKeyRef.current = null;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Ephemeral key request timed out")), 10_000),
      );
      let ephemeralKey: string;
      try {
        ephemeralKey = await Promise.race([keyPromise, timeout]);
      } catch (firstErr) {
        console.warn("[session] first key attempt failed, retrying:", firstErr);
        keyPromise = invoke<string>("create_ephemeral_key");
        ephemeralKey = await Promise.race([keyPromise, timeout]);
      }
      // Log the session config that will be sent to verify voice
      const initConfig = await session.getInitialSessionConfig();
      console.log(`[session] initial config voice: ${(initConfig as Record<string, unknown>).voice ?? "NOT SET"}`, JSON.stringify(initConfig));

      // Inject AEC-enabled mic stream before connecting.
      // The SDK reads transport.options.mediaStream during connect().
      if (micStreamRef.current) {
        const aecStream = await micStreamRef.current;
        if (aecStream) {
          const t = session.transport as unknown as { options: { mediaStream?: MediaStream } };
          t.options.mediaStream = aecStream;
          console.log("[session] using AEC-enabled mic stream (echoCancellation + noiseSuppression)");
        }
      }

      await session.connect({ apiKey: ephemeralKey });

      setStatus("connected");
      setAgentState("listening");
      isRotatingRef.current = false;

      agentResponseCountRef.current = 0;
      // Suppress auto-screen for the first few seconds so the model can greet
      // without being overwhelmed by an image on the very first speech_stopped.
      lastAutoScreenRef.current = Date.now();

      if (isReconnect) {
        // Replay context via updateHistory so Samuel remembers the conversation.
        // This is cleaner than manual sendEvent — the SDK tracks these items properly.
        const turns = contextRef.current.slice(-CONTEXT_WINDOW_TURNS);
        const historyItems: RealtimeItem[] = turns.map((turn, i) => {
          if (turn.role === "user") {
            return {
              itemId: `ctx_replay_${i}`,
              type: "message" as const,
              role: "user" as const,
              status: "completed" as const,
              content: [{ type: "input_text" as const, text: turn.text }],
            };
          }
          return {
            itemId: `ctx_replay_${i}`,
            type: "message" as const,
            role: "assistant" as const,
            status: "completed" as const,
            content: [{ type: "output_text" as const, text: turn.text }],
          };
        });
        session.updateHistory(historyItems);
        console.log(`[session] restored ${turns.length} context turns via updateHistory`);
        setTranscript((prev) => [...prev, makeEntry("status", "Session refreshed")]);

        // Don't re-greet — SDK keeps mic open natively
      } else {
        setTranscript([makeEntry("status", "Connected")]);

        // Inject local time so Samuel's greeting is time-appropriate.
        // Uses sendMessage which creates the item and triggers a response.
        const now = new Date();
        const timeCtx = `[System: Current local time is ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })} on ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Greet the user in ENGLISH with one short sentence. You MUST speak English.]`;

        // Load saved skills and inject summaries so Samuel knows what workflows are available
        invoke<Array<{ id: string; title: string; trigger: string; summary: string }>>("skill_list_summaries")
          .then((skills) => {
            let fullCtx = timeCtx;
            if (skills.length > 0) {
              const listing = skills.map((s) => `- ${s.title} [${s.id}]: ${s.summary} (trigger: ${s.trigger})`).join("\n");
              fullCtx += `\n[System: You have ${skills.length} saved skill(s). Before complex tasks, check if one applies:\n${listing}\nUse skill_manage(action="get", id="...") to load the full steps.]`;
              console.log(`[skills] injected ${skills.length} skill summaries into session`);
            }
            // Single sendMessage triggers the greeting response
            session.sendMessage(fullCtx);
          })
          .catch(() => {
            // Skills failed, just send time context
            session.sendMessage(timeCtx);
          });
      }

      // Load plugins + inject persistent memory in one atomic updateAgent call.
      // This avoids race conditions where two separate updateAgent calls overwrite each other.
      const session_ = sessionRef.current;
      if (session_) {
        Promise.all([
          loadAllPlugins().catch((err) => { console.error("[plugins] load failed:", err); return [] as FunctionTool[]; }),
          invoke<string>("memory_get_context").catch(() => ""),
        ]).then(([pluginTools, memoryCtx]) => {
          const coreTools = samuelAgent.tools as FunctionTool[];
          const tools = pluginTools.length > 0 ? mergeTools(coreTools, pluginTools) : coreTools;
          let instructions = samuelAgent.instructions as string;

          // Inject persistent memory so Samuel remembers across sessions
          if (memoryCtx && memoryCtx !== "No prior context.") {
            instructions += `\n\n# Persistent Memory (from previous sessions)\n${memoryCtx}\nFollow these memories strictly. Do not repeat vocabulary marked as known.\nIMPORTANT: Regardless of any language content in memory above, you MUST speak in ENGLISH unless the user explicitly asks otherwise.`;
            console.log(`[memory] injecting ${memoryCtx.length} chars of persistent context`);
          }

          // Auto-detect learning language from memory
          const langMatch = memoryCtx.match(/proficiency:(\w+)/i);
          if (langMatch) {
            console.log(`[session] auto-detected learning language: ${langMatch[1]}`);
            notifyLearningLanguage(langMatch[1]);
          }

          // Single updateAgent call with both plugins and memory
          const updatedAgent = new RealtimeAgent({
            name: samuelAgent.name,
            instructions,
            tools,
            voice: "ash",
          });
          session_.updateAgent(updatedAgent).then(() => {
            console.log(`[session] agent updated: ${pluginTools.length} plugin(s), memory=${memoryCtx.length > 0 ? "yes" : "no"}`);
          }).catch((err) => console.error("[session] updateAgent failed:", err));
        });
      }

      // Start heartbeat — keeps the Realtime API connection alive during silence.
      // Also detects dead connections: if send throws, trigger auto-reconnect.
      heartbeatRef.current = setInterval(() => {
        if (sessionRef.current) {
          try {
            sessionRef.current.transport.sendEvent({ type: "session.update", session: {} });
          } catch {
            console.warn("[heartbeat] send failed — connection dead, reconnecting");
            stopKeepalive();
            setStatus("disconnected");
            setAgentState("idle");
            setTimeout(() => { connectRef.current?.(); }, 1500);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Schedule session rotation before the 60-min hard cap
      rotationTimerRef.current = setTimeout(() => {
        console.log("[session] planned rotation at 25 min");
        isRotatingRef.current = true;
        connectRef.current?.();
      }, SESSION_ROTATION_MS);

    } catch (err) {
      console.error("[connect]", err);
      isRotatingRef.current = false;
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Connection failed: ${err}`),
      ]);
      setStatus("disconnected");
      setAgentState("idle");
    }
  }, [status, stopKeepalive, recordTurn]);

  // Keep connectRef current so auto-reconnect and rotation can call it
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    stopKeepalive();
    contextRef.current = [];
    registerSendImage(null);
    registerScreenTarget(null);
    sessionRef.current?.close();
    setStatus("disconnected");
    setAgentState("idle");
    setIsMuted(false);
    userMutedRef.current = false;
    setTranscript((prev) => [...prev, makeEntry("status", "Disconnected.")]);
  }, [stopKeepalive]);

  const mute = useCallback((muted: boolean) => {
    const session = sessionRef.current;
    userMutedRef.current = muted;
    if (session && session.muted !== null) {
      session.mute(muted);
    }
    setIsMuted(muted);
  }, []);

  const setWakeWordMode = useCallback((on: boolean) => {
    wakeWordModeRef.current = on;
    if (!on) clearInactivityTimer();
  }, []);

  const setSuppressIdle = useCallback((suppress: boolean) => {
    suppressIdleRef.current = suppress;
  }, []);

  // Programmatic interrupt — stops Samuel mid-speech immediately.
  // Useful for a "stop talking" button or when guardrails need to cut off.
  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (session) {
      try {
        session.interrupt();
        responseInProgressRef.current = false;
        setAgentState("listening");
        console.log("[session] interrupted by user/system");
      } catch {}
    }
  }, []);

  const approveToolCall = useCallback((entryId: string) => {
    const item = pendingApprovalsRef.current.get(entryId);
    if (!item) return;
    pendingApprovalsRef.current.delete(entryId);
    sessionRef.current?.approve(item).catch((err: unknown) =>
      console.error("[approval] approve failed:", err),
    );
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "approved" as const } }
          : e,
      ),
    );
  }, []);

  const denyToolCall = useCallback((entryId: string) => {
    const item = pendingApprovalsRef.current.get(entryId);
    if (!item) return;
    pendingApprovalsRef.current.delete(entryId);
    sessionRef.current?.reject(item, { message: "User denied this action." }).catch((err: unknown) =>
      console.error("[approval] reject failed:", err),
    );
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "denied" as const } }
          : e,
      ),
    );
  }, []);

  const alwaysAllowApp = useCallback((entryId: string, appName: string) => {
    // Approve the current request
    const item = pendingApprovalsRef.current.get(entryId);
    if (item) {
      pendingApprovalsRef.current.delete(entryId);
      sessionRef.current?.approve(item).catch((err: unknown) =>
        console.error("[approval] approve failed:", err),
      );
    }
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "approved" as const } }
          : e,
      ),
    );
    // Persist the "always allow" preference
    invoke("set_app_permission", { appName, permission: "always_allow" }).catch((err: unknown) =>
      console.error("[approval] set_app_permission failed:", err),
    );
    console.log(`[approval] always allow: ${appName}`);
  }, []);

  const alwaysDenyApp = useCallback((entryId: string, appName: string) => {
    const item = pendingApprovalsRef.current.get(entryId);
    if (item) {
      pendingApprovalsRef.current.delete(entryId);
      sessionRef.current?.reject(item, { message: `User permanently denied access to ${appName}.` }).catch((err: unknown) =>
        console.error("[approval] reject failed:", err),
      );
    }
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "denied" as const } }
          : e,
      ),
    );
    invoke("set_app_permission", { appName, permission: "always_deny" }).catch((err: unknown) =>
      console.error("[approval] set_app_permission failed:", err),
    );
    console.log(`[approval] always deny: ${appName}`);
  }, []);

  const sendText = useCallback((text: string) => {
    if (!text.trim()) return;
    setTranscript((prev) => [...prev, makeEntry("user", text.trim())]);
    recordTurn("user", text.trim());
    if (!sessionRef.current) return;
    if (responseInProgressRef.current) {
      console.log("[session] skipping sendText — model is busy");
      return;
    }
    sessionRef.current.sendMessage(text);
  }, [recordTurn]);

  return {
    status,
    transcript,
    agentState,
    screenTarget,
    connect,
    disconnect,
    mute,
    isMuted,
    setWakeWordMode,
    setSuppressIdle,
    prefetchKey,
    interrupt,
    approveToolCall,
    denyToolCall,
    alwaysAllowApp,
    alwaysDenyApp,
    sendText,
  };
}
