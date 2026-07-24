import {
  AMBIENT_FACE_TASK_CONTEXT,
  AMBIENT_VOICE_TASK_CONTEXT,
  type AmbientFacialFrame,
  type AmbientVoiceFrame
} from "@phenometrix/ambient-core";
import {
  AMBIENT_LOCAL_CONSENT_TEXT,
  AMBIENT_LOCAL_PROTOCOL_PACK,
  AMBIENT_LOCAL_PROTOCOL_REF,
  REPORT_BOUNDARY_STATEMENT,
  REPORT_SOURCE_DISCLOSURE,
  type AudioPipelineProvenance,
  type ConsentRecordV1,
  type FaceCalibration,
  type PostEncounterReportV1,
  type ProcessorProvenanceV1,
  type VisualPipelineProvenance
} from "@phenometrix/contracts";
import { buildPostEncounterReport } from "@phenometrix/evidence-core";
import { InMemoryEventJournal } from "@phenometrix/event-log";
import { buildAmbientObservation } from "./ambient-core-adapter.js";
import {
  AMBIENT_CAPTURE_LIMIT_MS,
  AMBIENT_SETUP_TIMEOUT_MS,
  createAmbientWorkflowState,
  reduceAmbientWorkflow,
  type AmbientWorkflowEffect,
  type AmbientWorkflowEvent,
  type AmbientWorkflowState
} from "./ambient-workflow.js";
import { classifyFaceCalibration } from "./capture-calibration.js";
import { CaptureRuntime, withTimeout } from "./capture-runtime.js";
import {
  VISUAL_WORKER_MESSAGE_VERSION,
  createVideoCaptureSettings,
  createVisualWorkerFrameMessage,
  createVisualWorkerInitializeMessage,
  visualWorkerMessage,
  type VisualWorkerResponse
} from "./face-worker-protocol.js";
import { FaceOverlayController } from "./face-overlay-controller.js";
import { LiveVoiceVisualizer } from "./live-voice-visualizer.js";
import {
  loadAndVerifyStaticAssets,
  type ResolvedStaticAssets
} from "./static-assets.js";
import {
  LatestFrameScheduler,
  VideoFramePump,
  type ScheduledVisualFrame
} from "./visual-frame-pump.js";
import {
  startVoiceCapturePipeline,
  type VoiceCapturePipeline
} from "./voice-capture.js";
import {
  requestedAudioCaptureSettings
} from "./voice-worker-protocol.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing required element #${id}`);
  return value as T;
}

// Detected once on the main thread, where matchMedia exists. The face-worker
// runs in a DedicatedWorkerGlobalScope with no matchMedia, so this presentation
// preference is threaded into the worker via the attach-overlay message.
const prefersReducedMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const welcomeView = element<HTMLElement>("welcome-view");
const captureView = element<HTMLElement>("capture-view");
const messageView = element<HTMLElement>("message-view");
const reportView = element<HTMLElement>("report-view");
const consentForm = element<HTMLFormElement>("consent-form");
const consentCheckbox = element<HTMLInputElement>("consent-checkbox");
const consentText = element<HTMLElement>("consent-text");
const startButton = element<HTMLButtonElement>("start-button");
const finishButton = element<HTMLButtonElement>("finish-button");
const discardButton = element<HTMLButtonElement>("discard-button");
const resetButton = element<HTMLButtonElement>("reset-button");
const messageResetButton = element<HTMLButtonElement>("message-reset-button");
const messageTitle = element<HTMLElement>("message-title");
const messageDetail = element<HTMLElement>("message-detail");
const phaseLabel = element<HTMLElement>("phase-label");
const privacyState = element<HTMLElement>("privacy-state");
const captureEyebrow = element<HTMLElement>("capture-eyebrow");
const captureTitle = element<HTMLElement>("capture-title");
const captureInstruction = element<HTMLElement>("capture-instruction");
const captureStatus = element<HTMLElement>("capture-status");
const audioLaneState = element<HTMLElement>("audio-lane-state");
const audioLaneDetail = element<HTMLElement>("audio-lane-detail");
const faceLaneState = element<HTMLElement>("face-lane-state");
const faceLaneDetail = element<HTMLElement>("face-lane-detail");
const cameraPreview = element<HTMLVideoElement>("camera-preview");
const landmarkOverlay = element<HTMLCanvasElement>("landmark-overlay");
const faceMeshStatus = element<HTMLElement>("face-mesh-status");
const cameraPlaceholder = element<HTMLElement>("camera-placeholder");
const sessionClock = element<HTMLTimeElement>("session-clock");
const reportBoundary = element<HTMLElement>("report-boundary");
const reportSource = element<HTMLElement>("report-source");
const reportSections = element<HTMLElement>("report-sections");
const faceOverlay = new FaceOverlayController(
  landmarkOverlay,
  faceMeshStatus
);
const liveVoiceVisualizer = new LiveVoiceVisualizer({
  levelGauge: element<HTMLCanvasElement>("voice-level-gauge"),
  pitchGauge: element<HTMLCanvasElement>("voice-pitch-gauge"),
  energyCanvas: element<HTMLCanvasElement>("voice-energy-chart"),
  pitchCanvas: element<HTMLCanvasElement>("voice-pitch-chart"),
  clarityCanvas: element<HTMLCanvasElement>("voice-clarity-chart"),
  state: element<HTMLElement>("voice-live-state"),
  level: element<HTMLElement>("voice-level-value"),
  pitch: element<HTMLElement>("voice-pitch-value"),
  snr: element<HTMLElement>("voice-snr-value"),
  confidence: element<HTMLElement>("voice-confidence-value"),
  agreement: element<HTMLElement>("voice-agreement-value"),
  quality: element<HTMLElement>("voice-quality-state")
});

consentText.textContent = AMBIENT_LOCAL_CONSENT_TEXT;

let workflow: AmbientWorkflowState = createAmbientWorkflowState();
let runtime = new CaptureRuntime();
let sessionId = "";
let subjectRef = "";
let consentRecord: ConsentRecordV1 | null = null;
let sessionStartedAtIso = "";
let observationStartedAtIso = "";
let observationStartedAtPerformanceMs = 0;
let observationEndedAtIso = "";
let audioStream: MediaStream | null = null;
let videoStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let voicePipeline: VoiceCapturePipeline | null = null;
let faceWorker: Worker | null = null;
let faceScheduler: LatestFrameScheduler<ImageBitmap> | null = null;
let facePump: VideoFramePump<ImageBitmap> | null = null;
let faceDisposedResolver: (() => void) | null = null;
let setupTimer: ReturnType<typeof setTimeout> | null = null;
let captureLimitTimer: ReturnType<typeof setTimeout> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let quietStartedAtMs: number | null = null;
let quietCalibrationRms: number[] = [];
let noiseCalibrationDurationMs = 0;
let faceCalibrationFrames: AmbientFacialFrame[] = [];
let faceCalibration: FaceCalibration | null = null;
let lastFaceCalibrationAtMs: number | null = null;
let audioCalibrationResolved = false;
let faceCalibrationResolved = false;
let lastVoiceFrameTMs = 0;
let voiceObservationOriginMs = 0;
let audioProvenance: AudioPipelineProvenance | null = null;
let visualProvenance: VisualPipelineProvenance | null = null;
let processorProvenance: ProcessorProvenanceV1[] = [];
let staticAssets: ResolvedStaticAssets | null = null;
let staticManifestError: string | null = null;
let journal: InMemoryEventJournal | null = null;
let audioLaneFailureReason: string | null = null;
let faceLaneFailureReason: string | null = null;
let faceCalibrationGuidance: string | null = null;

const staticAssetsPromise = loadAndVerifyStaticAssets(document.baseURI)
  .then((assets) => {
    staticAssets = assets;
    return assets;
  })
  .catch((error: unknown) => {
    staticManifestError = error instanceof Error ? error.message : "asset-manifest-unavailable";
    return null;
  });

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionIdentity(): void {
  sessionId = crypto.randomUUID();
  subjectRef = `subject-${crypto.randomUUID()}`;
  sessionStartedAtIso = nowIso();
  consentRecord = {
    schemaVersion: "phenometric.consent-record.v1",
    consentId: `consent-${crypto.randomUUID()}`,
    sessionId,
    documentVersion: AMBIENT_LOCAL_PROTOCOL_PACK.consentDocument.version,
    documentSha256: AMBIENT_LOCAL_PROTOCOL_PACK.consentDocument.contentSha256,
    recordedAt: sessionStartedAtIso,
    scopes: {
      cameraCapture: true,
      microphoneCapture: true,
      localInMemoryAnalysis: true
    },
    localParticipantAssertion: true,
    withdrawnAt: null
  };
  journal = new InMemoryEventJournal({
    sessionId,
    subjectRef,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF
  });
  journal.append({
    sessionId,
    subjectRef,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    actor: { kind: "application", id: "capture-web", version: "1.0.0" },
    type: "consent.recorded",
    stage: "requesting-permission",
    summary: "Local in-memory consent recorded.",
    payload: { consentId: consentRecord.consentId },
    evidenceRefs: []
  });
}

function clearTimers(): void {
  if (setupTimer !== null) clearTimeout(setupTimer);
  if (captureLimitTimer !== null) clearTimeout(captureLimitTimer);
  if (clockTimer !== null) clearInterval(clockTimer);
  setupTimer = null;
  captureLimitTimer = null;
  clockTimer = null;
}

function isCurrent(generation: number): boolean {
  return generation === workflow.generation &&
    !["discarded", "error", "report"].includes(workflow.phase);
}

function laneCopy(state: AmbientWorkflowState["audioLane"]): {
  label: string;
  detail: string;
} {
  if (state === "requesting") return { label: "Requesting", detail: "Waiting for browser permission." };
  if (state === "calibrating") return { label: "Calibrating", detail: "Checking local signal quality." };
  if (state === "measurable") return { label: "Ready", detail: "Derived measurements may be available after sufficient evidence." };
  if (state === "not-measurable") return { label: "Not measurable", detail: "This lane will be shown as unavailable in the report." };
  return { label: "Off", detail: "The device is not active." };
}

function streamIsLive(stream: MediaStream | null): boolean {
  return Boolean(
    stream?.getTracks().some((track) => track.readyState === "live")
  );
}

function readableFailure(error: unknown, fallback: string): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message || error.name;
  return fallback;
}

function renderWorkflow(): void {
  const active = [
    "requesting-permission",
    "calibrating",
    "observing",
    "finalizing"
  ].includes(workflow.phase);
  welcomeView.hidden = workflow.phase !== "idle";
  captureView.hidden = !active;
  reportView.hidden = workflow.phase !== "report";
  if (workflow.phase === "discarded" || workflow.phase === "error") {
    messageView.hidden = false;
    messageTitle.textContent = workflow.phase === "error" ? "Session unavailable" : "Session discarded";
    messageDetail.textContent = workflow.phase === "error"
      ? "The local capture could not continue. Devices are off and no report was created."
      : "No report was created and all local session data was cleared.";
  } else {
    messageView.hidden = true;
  }

  const labels: Record<AmbientWorkflowState["phase"], string> = {
    idle: "Ready",
    "requesting-permission": "Requesting devices",
    calibrating: "Technical setup",
    observing: "Ambient session",
    finalizing: "Finalizing locally",
    report: "Report ready",
    discarded: "Devices off",
    error: "Devices off"
  };
  phaseLabel.textContent = labels[workflow.phase];
  privacyState.textContent = active ? "Devices active · local only" : "Devices off";
  privacyState.classList.toggle("is-live", active);
  finishButton.disabled = workflow.phase !== "observing";

  const audioCopy = laneCopy(workflow.audioLane);
  const audioCapturingWithoutCalibration =
    workflow.phase === "observing" &&
    workflow.audioLane === "not-measurable" &&
    streamIsLive(audioStream);
  audioLaneState.textContent = audioCapturingWithoutCalibration
    ? "On"
    : audioCopy.label;
  audioLaneState.dataset.state = workflow.audioLane;
  audioLaneDetail.textContent =
    audioCapturingWithoutCalibration
      ? "Local capture is on, but technical calibration was incomplete; voice metrics may be Not measurable."
      : workflow.audioLane === "not-measurable" && audioLaneFailureReason
      ? `Unavailable: ${audioLaneFailureReason}. The camera lane can continue.`
      : audioCopy.detail;
  const faceCopy = laneCopy(workflow.faceLane);
  const faceCapturingWithoutCalibration =
    workflow.phase === "observing" &&
    workflow.faceLane === "not-measurable" &&
    streamIsLive(videoStream);
  faceLaneState.textContent = faceCapturingWithoutCalibration
    ? "On"
    : faceCopy.label;
  faceLaneState.dataset.state = workflow.faceLane;
  faceLaneDetail.textContent =
    faceCapturingWithoutCalibration
      ? `Local capture is on, but technical calibration was incomplete; face metrics may be Not measurable.${faceCalibrationGuidance ? ` ${faceCalibrationGuidance}` : ""}`
      : workflow.faceLane === "not-measurable" && faceLaneFailureReason
      ? `Unavailable: ${faceLaneFailureReason}. The microphone lane can continue.`
      : workflow.faceLane === "calibrating" && faceCalibrationGuidance
        ? faceCalibrationGuidance
      : faceCopy.detail;

  if (workflow.phase === "observing") {
    captureEyebrow.textContent = "Ambient session";
    captureTitle.textContent = "Continue the ordinary conversation";
    captureInstruction.textContent = "No exercises or scripted prompts are required. End whenever you are ready.";
    captureStatus.textContent = "Only derived, content-free engineering measurements are retained in session memory.";
  } else if (workflow.phase === "finalizing") {
    captureEyebrow.textContent = "Local finalization";
    captureTitle.textContent = "Turning devices off";
    captureInstruction.textContent = "The report appears only after camera, microphone, and processors have stopped.";
    captureStatus.textContent = "Clearing transient media buffers.";
  } else {
    captureEyebrow.textContent = "Technical setup";
    captureTitle.textContent = "Preparing local signals";
    captureInstruction.textContent = "Face the camera and allow a brief quiet moment for calibration.";
  }
}

function dispatch(event: AmbientWorkflowEvent): void {
  if (
    event.type === "calibration-resolved" &&
    event.measurable &&
    journal
  ) {
    journal.append({
      sessionId,
      subjectRef,
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      actor: {
        kind: "processor",
        id: event.lane === "audio" ? "voice-analysis" : "facial-analysis",
        version: "1.0.0"
      },
      type: "capture.lane.ready",
      stage: "calibrating",
      summary: `${event.lane === "audio" ? "Voice" : "Face"} lane passed technical calibration.`,
      payload: { modality: event.lane === "audio" ? "voice" : "face" },
      evidenceRefs: []
    });
  }
  const transition = reduceAmbientWorkflow(workflow, event);
  workflow = transition.state;
  renderWorkflow();
  for (const effect of transition.effects) void executeEffect(effect);
}

async function requestLane(
  generation: number,
  lane: "audio" | "face"
): Promise<void> {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("media-devices-unavailable");
    const stream = await navigator.mediaDevices.getUserMedia(
      lane === "audio"
        ? {
            video: false,
            audio: {
              channelCount: 1,
              sampleRate: 48_000,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          }
        : {
            audio: false,
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
              facingMode: "user"
            }
          }
    );
    if (!isCurrent(generation)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    if (lane === "audio") audioStream = stream;
    else videoStream = stream;
    dispatch({
      type: "permission-resolved",
      generation,
      lane,
      available: true,
      atMs: performance.now()
    });
  } catch (error) {
    if (!isCurrent(generation)) return;
    const reason = readableFailure(error, `${lane}-permission-unavailable`);
    if (lane === "audio") {
      audioLaneFailureReason = reason;
      liveVoiceVisualizer.setUnavailable();
    }
    else faceLaneFailureReason = reason;
    dispatch({
      type: "permission-resolved",
      generation,
      lane,
      available: false,
      atMs: performance.now()
    });
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function handleVoiceFrame(frameInput: AmbientVoiceFrame): void {
  const frame: AmbientVoiceFrame = {
    ...frameInput,
    speechActive: frameInput.speechActive,
    periodic: frameInput.periodic,
    trackSegmentId: frameInput.trackSegmentId
  };
  liveVoiceVisualizer.push(frame);
  lastVoiceFrameTMs = frame.tMs;
  if (workflow.phase === "calibrating" && !audioCalibrationResolved) {
    const quiet = !frame.speechActive && frame.blockGapMs <= 40 &&
      frame.clippedSampleFraction <= 0.01 && Math.abs(frame.dcOffset) <= 0.02;
    if (!quiet) {
      quietStartedAtMs = null;
      quietCalibrationRms = [];
      return;
    }
    quietStartedAtMs ??= frame.tMs;
    quietCalibrationRms.push(frame.rms);
    const duration = frame.tMs - quietStartedAtMs;
    if (duration >= 2_000) {
      audioCalibrationResolved = true;
      noiseCalibrationDurationMs = duration;
      voicePipeline?.setNoiseFloor(Math.max(0.0001, median(quietCalibrationRms)));
      dispatch({
        type: "calibration-resolved",
        generation: workflow.generation,
        lane: "audio",
        measurable: true,
        atMs: performance.now()
      });
    }
    return;
  }
  if (workflow.phase === "observing") {
    runtime.addVoiceFrame({
      ...frame,
      tMs: Math.max(0, frame.tMs - voiceObservationOriginMs),
      taskContext: AMBIENT_VOICE_TASK_CONTEXT
    });
  }
}

async function startAudioLane(generation: number): Promise<void> {
  if (!audioStream) {
    liveVoiceVisualizer.setUnavailable();
    dispatch({
      type: "calibration-resolved",
      generation,
      lane: "audio",
      measurable: false,
      atMs: performance.now()
    });
    return;
  }
  try {
    const assets = staticAssets ?? await staticAssetsPromise;
    if (!assets) throw new Error(staticManifestError ?? "asset-manifest-unavailable");
    if (!isCurrent(generation)) return;
    audioContext = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
    attachRuntimeHandles(generation);
    const track = audioStream.getAudioTracks()[0];
    const settings = track?.getSettings() ?? {};
    const browserProcessing = {
      echoCancellation: settings.echoCancellation ?? false,
      noiseSuppression: settings.noiseSuppression ?? false,
      autoGainControl: settings.autoGainControl ?? false
    };
    const captureSettings = requestedAudioCaptureSettings(
      settings.sampleRate ?? audioContext.sampleRate,
      settings.channelCount ?? 1,
      browserProcessing
    );
    voicePipeline = await startVoiceCapturePipeline({
      stream: audioStream,
      audioContext,
      captureSettings,
      captureEpoch: generation,
      taskContext: "quiet-calibration",
      workletUrl: assets.voiceWorkletUrl,
      callbacks: {
        onReady(provenance) {
          audioProvenance = provenance;
          processorProvenance.push({
            modality: "voice",
            processorRef: provenance.processorRef,
            runtime: provenance.runtime,
            runtimeVersion: provenance.algorithmVersion,
            assetPath: assets.manifest.assets.voiceWorklet.path,
            assetSha256: assets.manifest.assets.voiceWorklet.sha256,
            assetIntegrityVerified: true
          });
        },
        onFrame(frame) {
          if (isCurrent(generation)) handleVoiceFrame(frame as AmbientVoiceFrame);
        },
        onDiagnostics() {},
        onFailure(reason) {
          audioLaneFailureReason = reason;
          console.error("Audio processor failed:", reason);
          if (!audioCalibrationResolved && isCurrent(generation)) {
            audioCalibrationResolved = true;
            dispatch({
              type: "calibration-resolved",
              generation,
              lane: "audio",
              measurable: false,
              atMs: performance.now()
            });
          }
        }
      }
    });
    if (!isCurrent(generation)) await voicePipeline.stop();
  } catch (error) {
    if (!isCurrent(generation)) return;
    audioLaneFailureReason = readableFailure(error, "audio-processor-unavailable");
    console.error("Audio lane setup failed:", error);
    liveVoiceVisualizer.setUnavailable();
    audioCalibrationResolved = true;
    dispatch({
      type: "calibration-resolved",
      generation,
      lane: "audio",
      measurable: false,
      atMs: performance.now()
    });
  }
}

function handleFaceFrame(
  frameInput: AmbientFacialFrame,
  faceCount: number
): void {
  faceOverlay.updateFaceCount(faceCount);
  const frame: AmbientFacialFrame = {
    ...frameInput,
    faceCount,
    trackSegmentId: `face-${workflow.generation}`,
    qualityReasons:
      faceCount > 1
        ? [...new Set([...frameInput.qualityReasons, "multiple-faces" as const])]
        : frameInput.qualityReasons
  };
  if (workflow.phase === "calibrating" && !faceCalibrationResolved) {
    if (faceCount !== 1) {
      faceCalibrationGuidance =
        faceCount > 1
          ? "Only one face can be visible during setup."
          : "Move fully into view and face the camera.";
    } else if (
      frame.pose === null ||
      Math.abs(frame.pose.yawDegrees) > 7 ||
      Math.abs(frame.pose.pitchDegrees) > 10 ||
      Math.abs(frame.pose.rollDegrees) > 5
    ) {
      faceCalibrationGuidance = "Face the camera directly and hold your head level.";
    } else if (frame.qualityReasons.includes("illumination-out-of-range")) {
      faceCalibrationGuidance = "Use even front lighting without strong backlight.";
    } else if (frame.qualityReasons.includes("blur")) {
      faceCalibrationGuidance = "Hold still briefly so the camera image is sharp.";
    } else if (
      frame.qualityReasons.includes("frame-rate-below-minimum") ||
      frame.qualityReasons.includes("too-many-skipped-frames")
    ) {
      faceCalibrationGuidance = "Camera analysis is stabilizing; keep this tab visible.";
    } else {
      faceCalibrationGuidance = "Signal detected. Hold this position briefly.";
    }
    faceLaneDetail.textContent = faceCalibrationGuidance;
    if (
      faceCount !== 1 ||
      (lastFaceCalibrationAtMs !== null &&
        frame.acquiredAtMs - lastFaceCalibrationAtMs > 200)
    ) {
      faceCalibrationFrames = [];
    }
    lastFaceCalibrationAtMs = frame.acquiredAtMs;
    if (faceCount === 1) faceCalibrationFrames.push(frame);
    const result = classifyFaceCalibration(faceCalibrationFrames);
    if (result.quality === "strong" && result.calibration) {
      faceCalibrationResolved = true;
      faceCalibration = result.calibration;
      faceCalibrationGuidance = null;
      dispatch({
        type: "calibration-resolved",
        generation: workflow.generation,
        lane: "face",
        measurable: true,
        atMs: performance.now()
      });
    }
    return;
  }
  if (workflow.phase === "observing") runtime.addFaceFrame(frame);
}

function faceWorkerDisposed(generation: number): Promise<void> {
  const worker = faceWorker;
  faceOverlay.clear();
  if (!worker) {
    faceOverlay.releaseWorker();
    return Promise.resolve();
  }
  const acknowledgement = new Promise<void>((resolve) => {
    faceDisposedResolver = resolve;
    try {
      worker.postMessage(
        visualWorkerMessage({ type: "dispose", captureEpoch: generation })
      );
    } catch {
      resolve();
    }
  });
  return withTimeout(acknowledgement, 500, () => undefined)
    .catch(() => undefined)
    .then(() => {
      worker.terminate();
      faceDisposedResolver = null;
      if (faceWorker === worker) faceWorker = null;
      faceOverlay.releaseWorker();
    });
}

async function startFaceLane(generation: number): Promise<void> {
  if (!videoStream) {
    dispatch({
      type: "calibration-resolved",
      generation,
      lane: "face",
      measurable: false,
      atMs: performance.now()
    });
    return;
  }
  try {
    const assets = staticAssets ?? await staticAssetsPromise;
    if (!assets) throw new Error(staticManifestError ?? "asset-manifest-unavailable");
    if (!isCurrent(generation)) return;
    cameraPreview.srcObject = videoStream;
    await cameraPreview.play();
    if (!isCurrent(generation)) return;
    cameraPlaceholder.hidden = true;
    const track = videoStream.getVideoTracks()[0];
    const settings = track?.getSettings() ?? {};
    const captureSettings = createVideoCaptureSettings({
      width: settings.width ?? (cameraPreview.videoWidth || 1280),
      height: settings.height ?? (cameraPreview.videoHeight || 720),
      frameRate: settings.frameRate,
      facingMode: settings.facingMode
    });
    let workerReady = false;
    let rejectWorkerReady: ((reason?: unknown) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      rejectWorkerReady = reject;
      const worker = new Worker(new URL("./face-worker.ts", import.meta.url), {
        type: "module"
      });
      faceWorker = worker;
      attachRuntimeHandles(generation);
      worker.addEventListener("error", () => {
        faceOverlay.markUnavailable();
        reject(new Error("face-worker-unavailable"));
      }, { once: true });
      worker.addEventListener("message", (event: MessageEvent<VisualWorkerResponse>) => {
        const message = event.data;
        if (
          message.schemaVersion !== VISUAL_WORKER_MESSAGE_VERSION ||
          message.captureEpoch !== generation
        ) return;
        if (message.type === "ready") {
          workerReady = true;
          visualProvenance = message.provenance;
          processorProvenance.push({
            modality: "face",
            processorRef: message.provenance.processorRef,
            runtime: message.provenance.runtime,
            runtimeVersion: message.provenance.mediaPipeVersion,
            assetPath: assets.manifest.assets.faceModel.path,
            assetSha256: assets.manifest.assets.faceModel.sha256,
            assetIntegrityVerified: true
          });
          resolve();
        } else if (message.type === "frame") {
          faceScheduler?.accept({
            captureEpoch: message.captureEpoch,
            sequence: message.sequence,
            acquisitionTimestampMs: message.acquiredAtMs
          });
          if (isCurrent(generation)) {
            handleFaceFrame(message.frame as AmbientFacialFrame, message.faceCount);
          }
        } else if (message.type === "overlay-status") {
          faceOverlay.acknowledge(message.captureEpoch, message.attached);
        } else if (message.type === "discarded") {
          faceScheduler?.discard({
            captureEpoch: message.captureEpoch,
            sequence: message.sequence,
            acquisitionTimestampMs: message.acquiredAtMs
          });
        } else if (message.type === "error") {
          if (message.sequence !== null && message.acquiredAtMs !== null) {
            faceScheduler?.fail({
              captureEpoch: message.captureEpoch,
              sequence: message.sequence,
              acquisitionTimestampMs: message.acquiredAtMs
            });
          }
          if (message.code === "initialization-failed") {
            faceOverlay.markUnavailable();
            reject(new Error(message.code));
          }
        } else if (message.type === "disposed") {
          faceDisposedResolver?.();
          faceDisposedResolver = null;
          if (!workerReady) rejectWorkerReady?.(new Error("face-worker-disposed"));
        }
      });
    });
    const initializedWorker = faceWorker;
    if (!initializedWorker) throw new Error("face-worker-unavailable");
    faceOverlay.attach(initializedWorker, generation, prefersReducedMotion);
    initializedWorker.postMessage(
      createVisualWorkerInitializeMessage(generation, captureSettings, {
        mediaPipeRootUrl: assets.mediaPipeRootUrl,
        modelUrl: assets.faceModelUrl,
        modelSha256: assets.manifest.assets.faceModel.sha256
      })
    );
    const readyBeforeTimeout = await withTimeout(
      ready.then(() => true),
      10_000,
      () => false
    );
    if (!readyBeforeTimeout) throw new Error("face-worker-ready-timeout");
    if (!isCurrent(generation) || !faceWorker) return;
    faceScheduler = new LatestFrameScheduler<ImageBitmap>({
      captureEpoch: generation,
      onSubmit(scheduled: ScheduledVisualFrame<ImageBitmap>) {
        if (!faceWorker) throw new Error("face-worker-unavailable");
        const message = createVisualWorkerFrameMessage(scheduled, {
          tMs: Math.max(0, scheduled.acquisitionTimestampMs - observationStartedAtPerformanceMs),
          taskContext: AMBIENT_FACE_TASK_CONTEXT,
          calibration: faceCalibration
        });
        faceWorker.postMessage(message, [scheduled.frame]);
      }
    });
    facePump = new VideoFramePump<ImageBitmap>({
      source: cameraPreview,
      scheduler: faceScheduler,
      capture: async () => createImageBitmap(cameraPreview),
      taskContextAtAcquisition: () => AMBIENT_FACE_TASK_CONTEXT
    });
    facePump.start();
  } catch (error) {
    if (!isCurrent(generation)) return;
    faceLaneFailureReason = readableFailure(error, "face-processor-unavailable");
    console.error("Face lane setup failed:", error);
    faceOverlay.markUnavailable();
    faceCalibrationResolved = true;
    dispatch({
      type: "calibration-resolved",
      generation,
      lane: "face",
      measurable: false,
      atMs: performance.now()
    });
  }
}

function attachRuntimeHandles(generation: number): void {
  const streams: MediaStream[] = [];
  if (audioStream) streams.push(audioStream);
  if (videoStream) streams.push(videoStream);
  runtime.attach({
    stopFacePump: () => facePump?.stop(),
    stopVoicePipeline: async () => voicePipeline?.stop(),
    disposeFaceWorker: () => faceWorkerDisposed(generation),
    streams,
    video: cameraPreview,
    disconnectAudio: () => undefined,
    ...(audioContext ? { audioContext } : {}),
    cancelTimers: clearTimers
  });
}

async function beginCalibration(generation: number): Promise<void> {
  const modalities = [
    ...(workflow.audioLane === "calibrating" ? ["voice" as const] : []),
    ...(workflow.faceLane === "calibrating" ? ["face" as const] : [])
  ];
  if (journal && modalities.length > 0) {
    journal.append({
      sessionId,
      subjectRef,
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      actor: { kind: "application", id: "capture-web", version: "1.0.0" },
      type: "capture.calibration.started",
      stage: "calibrating",
      summary: "Technical calibration started for available local signals.",
      payload: { modalities },
      evidenceRefs: []
    });
  }
  attachRuntimeHandles(generation);
  setupTimer = setTimeout(() => {
    if (!isCurrent(generation)) return;
    dispatch({ type: "setup-timeout", generation, atMs: performance.now() });
  }, AMBIENT_SETUP_TIMEOUT_MS);
  const starts: Promise<void>[] = [];
  if (workflow.audioLane === "calibrating") starts.push(startAudioLane(generation));
  if (workflow.faceLane === "calibrating") starts.push(startFaceLane(generation));
  await Promise.allSettled(starts);
  attachRuntimeHandles(generation);
}

function beginObservation(generation: number): void {
  if (!isCurrent(generation)) return;
  if (setupTimer !== null) clearTimeout(setupTimer);
  setupTimer = null;
  observationStartedAtIso = nowIso();
  observationStartedAtPerformanceMs = performance.now();
  voiceObservationOriginMs = lastVoiceFrameTMs;
  voicePipeline?.setTask(AMBIENT_VOICE_TASK_CONTEXT);
  journal?.append({
    sessionId,
    subjectRef,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    actor: { kind: "application", id: "capture-web", version: "1.0.0" },
    type: "capture.started",
    stage: "observing",
    summary: "Ambient local observation started.",
    payload: { startedAt: observationStartedAtIso },
    evidenceRefs: []
  });
  updateClock();
  clockTimer = setInterval(updateClock, 250);
  captureLimitTimer = setTimeout(() => {
    dispatch({ type: "capture-limit-reached", generation });
  }, AMBIENT_CAPTURE_LIMIT_MS);
}

function updateClock(): void {
  const elapsed = workflow.phase === "observing"
    ? Math.min(AMBIENT_CAPTURE_LIMIT_MS, performance.now() - observationStartedAtPerformanceMs)
    : 0;
  const totalSeconds = Math.floor(elapsed / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  sessionClock.textContent = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  sessionClock.dateTime = `PT${totalSeconds}S`;
}

function clearSessionReferences(): void {
  audioStream = null;
  videoStream = null;
  audioContext = null;
  voicePipeline = null;
  faceWorker = null;
  faceScheduler = null;
  facePump = null;
  faceDisposedResolver = null;
  audioProvenance = null;
  visualProvenance = null;
  quietCalibrationRms = [];
  faceCalibrationFrames = [];
}

async function finalizeSession(generation: number): Promise<void> {
  liveVoiceVisualizer.reset();
  faceOverlay.clear();
  journal?.append({
    sessionId,
    subjectRef,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    actor: { kind: "application", id: "capture-web", version: "1.0.0" },
    type: "capture.finalizing",
    stage: "finalizing",
    summary: "Capture stopped before deterministic local finalization.",
    payload: {
      reason:
        workflow.terminalReason === "capture-limit-reached"
          ? "maximum-duration"
          : "manual"
    },
    evidenceRefs: []
  });
  observationEndedAtIso = nowIso();
  const durationMs = Math.min(
    AMBIENT_CAPTURE_LIMIT_MS,
    Math.max(0, performance.now() - observationStartedAtPerformanceMs)
  );
  const snapshot = await runtime.dispose(true);
  if (generation !== workflow.generation || workflow.phase !== "finalizing") return;
  if (!snapshot || !consentRecord) {
    dispatch({ type: "finalization-failed", generation, reason: "derived-snapshot-unavailable" });
    return;
  }
  try {
    const observation = buildAmbientObservation({
      sessionId,
      subjectRef,
      consent: consentRecord,
      startedAt: observationStartedAtIso || sessionStartedAtIso,
      endedAt: observationEndedAtIso,
      durationMs,
      voiceFrames: snapshot.voice as AmbientVoiceFrame[],
      faceFrames: snapshot.face as AmbientFacialFrame[],
      noiseCalibrationDurationMs,
      faceCalibration: faceCalibration
        ? {
            durationMs: faceCalibration.durationMs,
            baselineBoxWidthPixels: faceCalibration.baselineBoxWidthPixels,
            baselineBoxHeightPixels: faceCalibration.baselineBoxHeightPixels
          }
        : null,
      voiceLaneAvailable: workflow.audioLane === "measurable",
      faceLaneAvailable: workflow.faceLane === "measurable",
      processors: processorProvenance
    });
    for (const outcome of observation.metricOutcomes) {
      if (outcome.status === "measured") {
        const measurement = observation.measurements.find(
          (candidate) => candidate.aggregateId === outcome.aggregateId
        );
        if (!measurement) throw new Error(`Missing measurement for ${outcome.metricCode}`);
        journal?.append({
          sessionId,
          subjectRef,
          protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
          actor: {
            kind: "processor",
            id: outcome.modality === "voice" ? "voice-analysis" : "facial-analysis",
            version: outcome.algorithmVersion
          },
          type: "measurement.recorded",
          stage: "finalizing",
          summary: `${outcome.label} produced a technically qualified measurement.`,
          payload: {
            measurementId: measurement.measurementId,
            aggregateId: outcome.aggregateId,
            metricCode: outcome.metricCode
          },
          evidenceRefs: outcome.evidence.refs
        });
      } else {
        journal?.append({
          sessionId,
          subjectRef,
          protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
          actor: {
            kind: "processor",
            id: outcome.modality === "voice" ? "voice-analysis" : "facial-analysis",
            version: outcome.algorithmVersion
          },
          type: "measurement.withheld",
          stage: "finalizing",
          summary: `${outcome.label} was not measurable under the protocol contract.`,
          payload: {
            outcomeId: outcome.outcomeId,
            aggregateId: outcome.aggregateId,
            metricCode: outcome.metricCode,
            reasonCode: outcome.reasonCode
          },
          evidenceRefs: outcome.evidence.refs
        });
      }
    }
    journal?.append({
      sessionId,
      subjectRef,
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      actor: { kind: "application", id: "report-builder", version: "1.0.0" },
      type: "observation.created",
      stage: "finalizing",
      summary: "Validated ObservationV3 created in session memory.",
      payload: { observationId: observation.observationId },
      evidenceRefs: []
    });
    const report = buildPostEncounterReport(
      observation,
      AMBIENT_LOCAL_PROTOCOL_PACK,
      {
        generatedAt: observationEndedAtIso,
        events: [...(journal?.snapshot() ?? [])]
      }
    );
    journal?.append({
      sessionId,
      subjectRef,
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      actor: { kind: "application", id: "report-builder", version: "1.0.0" },
      type: "report.created",
      stage: "report",
      summary: "Deterministic post-encounter report created in session memory.",
      payload: { reportId: report.reportId, observationId: observation.observationId },
      evidenceRefs: []
    });
    renderReport(report);
    clearSessionReferences();
    dispatch({ type: "finalization-completed", generation });
  } catch (error) {
    console.error(error);
    clearSessionReferences();
    dispatch({ type: "finalization-failed", generation, reason: "report-validation-failed" });
  }
}

async function discardSession(): Promise<void> {
  liveVoiceVisualizer.reset();
  faceOverlay.clear();
  const reason = workflow.terminalReason === "consent-withdrawn"
    ? "consent-withdrawn"
    : workflow.terminalReason === "page-hidden" || workflow.terminalReason === "page-unloaded"
      ? "document-hidden"
      : "user-cancelled";
  if (journal && !journal.disposed) {
    journal.append({
      sessionId,
      subjectRef,
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      actor: { kind: "application", id: "capture-web", version: "1.0.0" },
      type: "capture.discarded",
      stage: "discarded",
      summary: "Session discarded and in-memory data cleared.",
      payload: { reason },
      evidenceRefs: []
    });
  }
  await runtime.dispose(false);
  journal?.dispose();
  journal = null;
  clearSessionReferences();
}

async function executeEffect(effect: AmbientWorkflowEffect): Promise<void> {
  if (effect.type === "request-media") {
    void requestLane(effect.generation, "audio");
    void requestLane(effect.generation, "face");
  } else if (effect.type === "begin-calibration") {
    await beginCalibration(effect.generation);
  } else if (effect.type === "begin-observation") {
    beginObservation(effect.generation);
  } else if (effect.type === "finalize") {
    await finalizeSession(effect.generation);
  } else if (effect.type === "dispose") {
    await discardSession();
  }
}

function formatValue(value: number, unit: string): string {
  if (unit === "ratio") return value.toFixed(3);
  if (unit.includes("second") || unit.includes("minute") || unit === "Hz") {
    return value.toFixed(2);
  }
  return value.toFixed(3);
}

function appendTraceItem(container: HTMLElement, label: string, value: string): void {
  const item = document.createElement("div");
  const name = document.createElement("span");
  const code = document.createElement("code");
  name.textContent = label;
  code.textContent = value;
  item.append(name, code);
  container.append(item);
}

function renderReport(report: PostEncounterReportV1): void {
  reportBoundary.textContent = `${REPORT_BOUNDARY_STATEMENT} Prototype measurements are not clinically validated.`;
  reportSource.textContent = REPORT_SOURCE_DISCLOSURE;
  reportSections.replaceChildren();
  for (const section of report.sections) {
    const card = document.createElement("article");
    card.className = "report-section";
    card.dataset.section = section.sectionId;
    const heading = document.createElement("h2");
    heading.textContent = section.label;
    card.append(heading);
    if (section.sectionId === "capture-quality") {
      const facts = document.createElement("div");
      facts.className = "quality-facts";
      for (const fact of section.qualityFacts) {
        const node = document.createElement("div");
        node.className = "quality-fact";
        const label = document.createElement("span");
        label.textContent = fact.label;
        const value = document.createElement("strong");
        value.textContent = `${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`;
        node.append(label, value);
        facts.append(node);
      }
      card.append(facts);
    } else {
      const list = document.createElement("div");
      list.className = "metric-list";
      for (const outcome of section.outcomes) {
        const row = document.createElement("article");
        row.className = "metric-row";
        row.dataset.metricCode = outcome.metricCode;
        const metricLabel = document.createElement("div");
        metricLabel.className = "metric-label";
        const label = document.createElement("strong");
        label.textContent = outcome.label;
        const context = document.createElement("span");
        context.textContent = outcome.context;
        metricLabel.append(label, context);
        const metricValue = document.createElement("div");
        metricValue.className = `metric-value${outcome.status === "withheld" ? " is-withheld" : ""}`;
        const value = document.createElement("strong");
        const unit = document.createElement("span");
        if (outcome.status === "measured") {
          value.textContent = formatValue(outcome.value, outcome.unit);
          unit.textContent = outcome.unit;
        } else {
          value.textContent = "Not measurable";
          unit.textContent = outcome.detail;
        }
        metricValue.append(value, unit);
        const evidence = document.createElement("div");
        evidence.className = "metric-evidence";
        evidence.textContent = `${(outcome.evidence.eligibleDurationMs / 1_000).toFixed(1)} s eligible · ${outcome.evidence.sampleCount} samples · ${outcome.evidence.windowCount} windows`;
        const details = document.createElement("details");
        details.className = "metric-details";
        const summary = document.createElement("summary");
        summary.textContent = "Measurement details";
        const trace = document.createElement("div");
        trace.className = "trace-grid";
        appendTraceItem(trace, "Aggregate ID", outcome.aggregateId);
        appendTraceItem(trace, "Algorithm", outcome.algorithmVersion);
        appendTraceItem(trace, "Processor", outcome.processorRef);
        appendTraceItem(trace, "Track segment", outcome.trackSegmentId);
        appendTraceItem(trace, "Technical quality", outcome.technicalQualityScore === null ? "Not available" : outcome.technicalQualityScore.toFixed(3));
        appendTraceItem(trace, "Technical dispersion", outcome.technicalDispersion === null ? "Not available" : outcome.technicalDispersion.toFixed(3));
        appendTraceItem(trace, "Evidence refs", outcome.evidence.refs.map((ref) => ref.kind === "event" ? ref.eventId : ref.kind === "window" ? ref.windowId : ref.kind === "measurement" ? ref.measurementId : ref.aggregateId).join(", "));
        if (outcome.status === "withheld") appendTraceItem(trace, "Withheld reason", outcome.reasonCode);
        details.append(summary, trace);
        row.append(metricLabel, metricValue, evidence, details);
        list.append(row);
      }
      card.append(list);
    }
    reportSections.append(card);
  }
}

function resetApplication(): void {
  journal?.dispose();
  journal = null;
  clearTimers();
  workflow = reduceAmbientWorkflow(workflow, { type: "reset" }).state;
  runtime = new CaptureRuntime();
  sessionId = "";
  subjectRef = "";
  consentRecord = null;
  sessionStartedAtIso = "";
  observationStartedAtIso = "";
  observationStartedAtPerformanceMs = 0;
  observationEndedAtIso = "";
  quietStartedAtMs = null;
  quietCalibrationRms = [];
  noiseCalibrationDurationMs = 0;
  faceCalibrationFrames = [];
  faceCalibration = null;
  lastFaceCalibrationAtMs = null;
  audioCalibrationResolved = false;
  faceCalibrationResolved = false;
  lastVoiceFrameTMs = 0;
  voiceObservationOriginMs = 0;
  processorProvenance = [];
  audioLaneFailureReason = null;
  faceLaneFailureReason = null;
  faceCalibrationGuidance = null;
  liveVoiceVisualizer.reset();
  faceOverlay.resetCanvas();
  consentCheckbox.checked = false;
  startButton.disabled = true;
  cameraPlaceholder.hidden = false;
  cameraPlaceholder.textContent = "Camera is preparing";
  sessionClock.textContent = "00:00";
  reportSections.replaceChildren();
  renderWorkflow();
}

consentCheckbox.addEventListener("change", () => {
  dispatch({ type: "consent-changed", consented: consentCheckbox.checked });
  startButton.disabled = !consentCheckbox.checked;
});

consentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!consentCheckbox.checked) return;
  createSessionIdentity();
  journal?.append({
    sessionId,
    subjectRef,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    actor: { kind: "application", id: "capture-web", version: "1.0.0" },
    type: "capture.permission.requested",
    stage: "requesting-permission",
    summary: "Requested local camera and microphone permission.",
    payload: { modalities: ["voice", "face"] },
    evidenceRefs: []
  });
  dispatch({ type: "start-requested", atMs: performance.now() });
});

finishButton.addEventListener("click", () => {
  dispatch({ type: "finish-requested", generation: workflow.generation });
});

discardButton.addEventListener("click", () => {
  dispatch({ type: "discard-requested", reason: "participant-discarded" });
});

resetButton.addEventListener("click", resetApplication);
messageResetButton.addEventListener("click", resetApplication);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) dispatch({ type: "visibility-lost" });
});

window.addEventListener("pagehide", () => {
  if (["requesting-permission", "calibrating", "observing", "finalizing"].includes(workflow.phase)) {
    dispatch({ type: "discard-requested", reason: "page-unloaded" });
  }
});

if (!window.isSecureContext) {
  captureStatus.textContent = "Camera and microphone require a secure context.";
}
if (staticManifestError) {
  captureStatus.textContent = `Local asset verification unavailable: ${staticManifestError}`;
}

renderWorkflow();
