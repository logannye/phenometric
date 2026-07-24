import type { FacialKinematicsFrameV1 } from "@phenometric/ambient-core";
import type {
  FaceCalibration,
  VideoCaptureSettings,
  VisualPipelineProvenance,
  VisualTaskContext
} from "@phenometric/contracts";
import type { FrameStreamDiagnostics } from "./visual-frame-pump.js";
import type { ScheduledVisualFrame } from "./visual-frame-pump.js";

export const VISUAL_WORKER_MESSAGE_VERSION =
  "phenometric.visual-worker-message.v2" as const;
export const MEDIAPIPE_TASKS_VISION_VERSION = "0.10.35" as const;
export const FACE_LANDMARKER_MODEL_PATH =
  "models/face_landmarker.task" as const;
export const FACE_LANDMARKER_MODEL_SHA256 =
  "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff" as const;
export const FACE_LANDMARKER_GEOMETRY_VERSION =
  "bilateral-geometry-v2" as const;

export function visualPipelineProvenance(
  delegate: "GPU" | "CPU",
  modelAsset: string = FACE_LANDMARKER_MODEL_PATH,
  modelSha256: string = FACE_LANDMARKER_MODEL_SHA256
): VisualPipelineProvenance {
  return {
    processorRef: [
      "mediapipe-face-landmarker",
      MEDIAPIPE_TASKS_VISION_VERSION,
      modelSha256.slice(0, 12),
      FACE_LANDMARKER_GEOMETRY_VERSION,
      delegate.toLowerCase()
    ].join(":"),
    runtime: "mediapipe-tasks-vision",
    mediaPipeVersion: MEDIAPIPE_TASKS_VISION_VERSION,
    modelAsset,
    modelSha256,
    delegate,
    geometryVersion: FACE_LANDMARKER_GEOMETRY_VERSION
  };
}

export interface VisualWorkerInitializeMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "initialize";
  captureEpoch: number;
  videoCaptureSettings: VideoCaptureSettings;
  assets: {
    mediaPipeRootUrl: string;
    modelUrl: string;
    modelSha256: string;
  };
}

export interface VisualWorkerResetMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "reset";
  captureEpoch: number;
}

export interface VisualWorkerAttachOverlayMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "attach-overlay";
  captureEpoch: number;
  canvas: OffscreenCanvas;
  maxRenderHz: number;
  // Presentation-only UI preference flowing INTO the worker (main -> worker).
  // matchMedia is unavailable in a DedicatedWorkerGlobalScope, so reduced-motion
  // must be detected on the main thread and passed in here. No native data.
  reducedMotion: boolean;
}

export interface VisualWorkerClearOverlayMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "clear-overlay";
  captureEpoch: number;
}

export interface VisualWorkerFrameMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "frame";
  captureEpoch: number;
  sequence: number;
  tMs: number;
  acquiredAtMs: number;
  taskContext: VisualTaskContext;
  width: number;
  height: number;
  bitmap: ImageBitmap;
  stream: FrameStreamDiagnostics;
  calibration: FaceCalibration | null;
}

export interface VisualWorkerDisposeMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "dispose";
  captureEpoch: number;
}

export type VisualWorkerRequest =
  | VisualWorkerInitializeMessage
  | VisualWorkerResetMessage
  | VisualWorkerAttachOverlayMessage
  | VisualWorkerClearOverlayMessage
  | VisualWorkerFrameMessage
  | VisualWorkerDisposeMessage;

export interface VisualWorkerReadyMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "ready";
  captureEpoch: number;
  provenance: VisualPipelineProvenance;
  videoCaptureSettings: VideoCaptureSettings;
}

export interface VisualWorkerResultMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "frame";
  captureEpoch: number;
  sequence: number;
  acquiredAtMs: number;
  faceCount: number;
  frame: FacialKinematicsFrameV1;
  boundingBox: FacialKinematicsFrameV1["boundingBox"];
  stream: FrameStreamDiagnostics;
}

export interface VisualWorkerDiscardedMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "discarded";
  captureEpoch: number;
  sequence: number;
  acquiredAtMs: number;
  reason: "capture-epoch-mismatch" | "non-monotonic-sequence";
}

export interface VisualWorkerErrorMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "error";
  captureEpoch: number;
  sequence: number | null;
  acquiredAtMs: number | null;
  code:
    | "initialization-failed"
    | "worker-not-ready"
    | "invalid-message"
    | "inference-failed";
  message: string;
  recoverable: boolean;
}

export interface VisualWorkerDisposedMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "disposed";
  captureEpoch: number;
}

export interface VisualWorkerOverlayStatusMessage {
  schemaVersion: typeof VISUAL_WORKER_MESSAGE_VERSION;
  type: "overlay-status";
  captureEpoch: number;
  attached: boolean;
}

export type VisualWorkerResponse =
  | VisualWorkerReadyMessage
  | VisualWorkerResultMessage
  | VisualWorkerDiscardedMessage
  | VisualWorkerErrorMessage
  | VisualWorkerOverlayStatusMessage
  | VisualWorkerDisposedMessage;

export function visualWorkerMessage<TMessage extends VisualWorkerRequest>(
  message: Omit<TMessage, "schemaVersion">
): TMessage {
  return {
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    ...message
  } as TMessage;
}

export function createVideoCaptureSettings(input: {
  width: number;
  height: number;
  frameRate?: number | null;
  facingMode?: string;
}): VideoCaptureSettings {
  return {
    requested: { width: 1280, height: 720, frameRate: 30 },
    actual: {
      width: input.width,
      height: input.height,
      frameRate: input.frameRate ?? null
    },
    ...(input.facingMode ? { facingMode: input.facingMode } : {}),
    coordinateSpace: "normalized-unmirrored-image",
    displayMirrored: true,
    lateralityConvention: "subject-anatomical"
  };
}

export function createVisualWorkerInitializeMessage(
  captureEpoch: number,
  videoCaptureSettings: VideoCaptureSettings,
  assets: VisualWorkerInitializeMessage["assets"]
): VisualWorkerInitializeMessage {
  return {
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    type: "initialize",
    captureEpoch,
    videoCaptureSettings,
    assets
  };
}

export function createVisualWorkerResetMessage(
  captureEpoch: number
): VisualWorkerResetMessage {
  return {
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    type: "reset",
    captureEpoch
  };
}

export function createVisualWorkerAttachOverlayMessage(
  captureEpoch: number,
  canvas: OffscreenCanvas,
  maxRenderHz = 24,
  reducedMotion = false
): VisualWorkerAttachOverlayMessage {
  return {
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    type: "attach-overlay",
    captureEpoch,
    canvas,
    maxRenderHz,
    reducedMotion
  };
}

export function createVisualWorkerClearOverlayMessage(
  captureEpoch: number
): VisualWorkerClearOverlayMessage {
  return {
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    type: "clear-overlay",
    captureEpoch
  };
}

export function createVisualWorkerFrameMessage(
  scheduled: ScheduledVisualFrame<ImageBitmap>,
  context: {
    tMs: number;
    taskContext: VisualTaskContext;
    calibration: FaceCalibration | null;
  }
): VisualWorkerFrameMessage {
  return {
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    type: "frame",
    captureEpoch: scheduled.captureEpoch,
    sequence: scheduled.sequence,
    tMs: context.tMs,
    acquiredAtMs: scheduled.acquisitionTimestampMs,
    taskContext: context.taskContext,
    width: scheduled.width,
    height: scheduled.height,
    bitmap: scheduled.frame,
    stream: scheduled.stream,
    calibration: context.calibration
  };
}
