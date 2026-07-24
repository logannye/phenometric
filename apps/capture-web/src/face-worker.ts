/// <reference lib="webworker" />

import {
  FaceLandmarker,
  FilesetResolver
} from "@mediapipe/tasks-vision";
import {
  AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA,
  AMBIENT_FACE_MAX_FRAME_GAP_MS,
  AMBIENT_FACE_MAX_PITCH_DEGREES,
  AMBIENT_FACE_MAX_ROLL_DEGREES,
  AMBIENT_FACE_MAX_YAW_DEGREES,
  type FacialKinematicsFrameV1
} from "@phenometric/ambient-core";
import {
  boundingBoxForLandmarks,
  deriveFaceFeature,
  type FaceFeatureState
} from "./face-features.js";
import { FaceMeshGLRenderer } from "./face-mesh-gl.js";
import {
  FaceMeshOverlayRenderer,
  faceMeshPresentationEligible
} from "./face-mesh-overlay.js";
import type { FaceMeshRenderer } from "./face-mesh-renderer.js";
import { LocalizeIntro } from "./localize-intro.js";
import {
  VISUAL_WORKER_MESSAGE_VERSION,
  visualPipelineProvenance,
  type VisualWorkerErrorMessage,
  type VisualWorkerFrameMessage,
  type VisualWorkerRequest,
  type VisualWorkerResponse
} from "./face-worker-protocol.js";
import { computeFaceImageQuality } from "./visual-image-quality.js";

const QUALITY_ROI_SIZE = 64;
const CADENCE_WINDOW_MS = 2_000;

let landmarker: FaceLandmarker | null = null;
let provenance: ReturnType<typeof visualPipelineProvenance> | null = null;
let activeCaptureEpoch = 0;
let lastSequence = 0;
let lastAcquiredAtMs: number | null = null;
let featureState: FaceFeatureState = {
  normalizedMotionPoints: null,
  acquiredAtMs: null
};
let analyzedAcquisitionTimes: number[] = [];
let initializing: Promise<void> | null = null;
let activeModelAsset = "";
let activeModelSha256 = "";
// Presentation-only mesh renderer chosen at attach-overlay (WebGL2 first, 2D
// fallback). Landmarks are cached inside the renderer for the rAF redraw loop
// and are NEVER posted to the main thread.
let meshRenderer: FaceMeshRenderer | null = null;
let meshOverlayCaptureEpoch: number | null = null;
let overlayCanvas: OffscreenCanvas | null = null;
let overlayMaxRenderHz = 24;
let rafHandle: number | null = null;
let hasLandmarks = false;
const localizeIntro = new LocalizeIntro();

// Honor the OS "reduce motion" setting. matchMedia does NOT exist in a
// DedicatedWorkerGlobalScope, so the main thread detects the preference and
// passes it in via the attach-overlay message; this flag is (re)set from that
// message on every attach. Reduced motion forces the mesh into a static frame
// (no hue drift, twinkle, or intro animation). Defaults to full motion.
let prefersReducedMotion = false;

// Adaptive performance governor: an EMA of the rAF inter-frame time drives an
// effectLevel (0..1) that the renderer uses to shed effects (bloom -> hue
// drift) under load and recover them when frame time is comfortable again.
const GOVERNOR_EMA_ALPHA = 0.1;
const GOVERNOR_SHED_THRESHOLD_MS = 20;
const GOVERNOR_RECOVER_THRESHOLD_MS = 14;
const GOVERNOR_SHED_STEP = 0.05;
const GOVERNOR_RECOVER_STEP = 0.02;
let governorEmaDtMs = 16;
let governorEffectLevel = 1;
let lastDrawNowMs: number | null = null;
const qualityCanvas = new OffscreenCanvas(
  QUALITY_ROI_SIZE,
  QUALITY_ROI_SIZE
);
const qualityContext = qualityCanvas.getContext("2d", {
  willReadFrequently: true
});

function post(message: VisualWorkerResponse): void {
  self.postMessage(message);
}

// Try WebGL2 first, fall back to the 2D overlay. FaceMeshGLRenderer.attach()
// never throws on GL-init failure (it returns false), so the boolean is
// sufficient; the try/catch is defensive belt-and-suspenders.
function selectRenderer(
  canvas: OffscreenCanvas,
  maxRenderHz: number
): FaceMeshRenderer | null {
  try {
    const gl = new FaceMeshGLRenderer();
    if (gl.attach(canvas, maxRenderHz)) {
      return gl;
    }
  } catch {
    // fall through to the 2D fallback
  }
  try {
    const twoD = new FaceMeshOverlayRenderer();
    if (twoD.attach(canvas, maxRenderHz)) {
      return twoD;
    }
  } catch {
    // no renderer available
  }
  return null;
}

// DedicatedWorkerGlobalScope implements AnimationFrameProvider, so
// requestAnimationFrame/cancelAnimationFrame exist here (OffscreenCanvas
// animation). The rAF clock shares performance.now(), so the intro's
// start/progress times stay consistent with the draw timestamps.
function startRenderLoop(): void {
  if (rafHandle !== null) {
    return;
  }
  // Fresh governor pacing for each loop (re)start (e.g. after context restore).
  lastDrawNowMs = null;
  governorEmaDtMs = 16;
  governorEffectLevel = 1;
  const tick = (now: number): void => {
    rafHandle = requestAnimationFrame(tick);
    if (!meshRenderer || !hasLandmarks) {
      // Pause frame-time pacing while nothing is drawn so an idle gap does not
      // corrupt the EMA when drawing resumes.
      lastDrawNowMs = null;
      return;
    }
    // Update the frame-time EMA from the interval since the last drawn frame and
    // adjust the shed level: over budget -> shed toward 0; comfortable -> recover
    // toward 1; the hysteresis band in between holds the current level steady.
    if (lastDrawNowMs !== null) {
      const dtMs = now - lastDrawNowMs;
      if (Number.isFinite(dtMs) && dtMs > 0 && dtMs < 1_000) {
        governorEmaDtMs =
          governorEmaDtMs * (1 - GOVERNOR_EMA_ALPHA) + dtMs * GOVERNOR_EMA_ALPHA;
        if (governorEmaDtMs > GOVERNOR_SHED_THRESHOLD_MS) {
          governorEffectLevel = Math.max(0, governorEffectLevel - GOVERNOR_SHED_STEP);
        } else if (governorEmaDtMs < GOVERNOR_RECOVER_THRESHOLD_MS) {
          governorEffectLevel = Math.min(1, governorEffectLevel + GOVERNOR_RECOVER_STEP);
        }
      }
    }
    lastDrawNowMs = now;
    // Reduced motion collapses the intro to its resting state (no animation).
    const introProgress = prefersReducedMotion ? 1 : localizeIntro.presence(now);
    // Presentation only: a redraw failure must never propagate into the
    // measurement path, so it is contained here.
    try {
      meshRenderer.drawFrame(now, introProgress, {
        reducedMotion: prefersReducedMotion,
        effectLevel: governorEffectLevel
      });
    } catch {
      // drop the frame; the next tick retries
    }
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopRenderLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function resetDerivedState(captureEpoch: number): void {
  meshRenderer?.clear();
  hasLandmarks = false;
  localizeIntro.reset();
  if (meshRenderer?.isAttached()) {
    meshOverlayCaptureEpoch = captureEpoch;
  }
  activeCaptureEpoch = captureEpoch;
  lastSequence = 0;
  lastAcquiredAtMs = null;
  analyzedAcquisitionTimes = [];
  featureState = {
    normalizedMotionPoints: null,
    acquiredAtMs: null
  };
}

function errorMessage(
  message: string,
  input: {
    code: VisualWorkerErrorMessage["code"];
    recoverable: boolean;
    sequence?: number;
    acquiredAtMs?: number;
    captureEpoch?: number;
  }
): VisualWorkerErrorMessage {
  return {
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    type: "error",
    captureEpoch: input.captureEpoch ?? activeCaptureEpoch,
    sequence: input.sequence ?? null,
    acquiredAtMs: input.acquiredAtMs ?? null,
    code: input.code,
    message,
    recoverable: input.recoverable
  };
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function continuityEligible(
  frame: FacialKinematicsFrameV1,
  calibration: VisualWorkerFrameMessage["calibration"]
): boolean {
  if (
    frame.qualityReasons.length > 0 ||
    frame.pose === null ||
    frame.boundingBox === null ||
    Math.abs(frame.pose.yawDegrees) > AMBIENT_FACE_MAX_YAW_DEGREES ||
    Math.abs(frame.pose.pitchDegrees) > AMBIENT_FACE_MAX_PITCH_DEGREES ||
    Math.abs(frame.pose.rollDegrees) > AMBIENT_FACE_MAX_ROLL_DEGREES ||
    (frame.interResultGapMs !== null &&
      frame.interResultGapMs > AMBIENT_FACE_MAX_FRAME_GAP_MS)
  ) {
    return false;
  }
  if (!calibration) return true;
  const widthRatio =
    frame.boundingBox.widthPixels / calibration.baselineBoxWidthPixels;
  const heightRatio =
    frame.boundingBox.heightPixels / calibration.baselineBoxHeightPixels;
  return (
    Number.isFinite(widthRatio) &&
    Number.isFinite(heightRatio) &&
    Math.abs(widthRatio - 1) <= AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA &&
    Math.abs(heightRatio - 1) <= AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA
  );
}

async function initialize(
  message: Extract<VisualWorkerRequest, { type: "initialize" }>
): Promise<void> {
  resetDerivedState(message.captureEpoch);
  if (landmarker && provenance) {
    post({
      schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
      type: "ready",
      captureEpoch: activeCaptureEpoch,
      provenance,
      videoCaptureSettings: message.videoCaptureSettings
    });
    return;
  }
  if (initializing) {
    await initializing;
    if (provenance) {
      post({
        schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
        type: "ready",
        captureEpoch: activeCaptureEpoch,
        provenance,
        videoCaptureSettings: message.videoCaptureSettings
      });
    }
    return;
  }

  initializing = (async () => {
    const vision = await FilesetResolver.forVisionTasks(
      message.assets.mediaPipeRootUrl,
      true
    );
    const options = {
      runningMode: "VIDEO",
      numFaces: 2,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      /*
       * Off deliberately, and this is a measurement decision rather than a
       * performance one.
       *
       * The 52 coefficients are the obvious shortcut to "Action Unit
       * intensities", and they are the wrong instrument twice over. The rig is
       * trained for avatar retargeting, which carries a symmetry prior --
       * it suppresses exactly the left-right difference this system exists to
       * measure. And a 52-dimensional expression vector is identity-adjacent
       * in a way per-side geometry is not, which is why the frame privacy
       * assertion names `blendshapes` outright.
       *
       * Action Units are derived geometrically from landmarks instead. This
       * also stops paying for coefficients that were computed every frame and
       * discarded at the worker boundary.
       */
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true
    } as const;
    try {
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: {
          modelAssetPath: message.assets.modelUrl,
          delegate: "GPU"
        }
      });
      activeModelAsset = message.assets.modelUrl;
      activeModelSha256 = message.assets.modelSha256;
      provenance = visualPipelineProvenance(
        "GPU",
        activeModelAsset,
        activeModelSha256
      );
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: {
          modelAssetPath: message.assets.modelUrl,
          delegate: "CPU"
        }
      });
      activeModelAsset = message.assets.modelUrl;
      activeModelSha256 = message.assets.modelSha256;
      provenance = visualPipelineProvenance(
        "CPU",
        activeModelAsset,
        activeModelSha256
      );
    }
  })();

  try {
    await initializing;
    if (!provenance) {
      throw new Error("Face Landmarker did not report processor provenance.");
    }
    post({
      schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
      type: "ready",
      captureEpoch: activeCaptureEpoch,
      provenance,
      videoCaptureSettings: message.videoCaptureSettings
    });
  } finally {
    initializing = null;
  }
}

function imageQualityFor(
  bitmap: ImageBitmap,
  box: ReturnType<typeof boundingBoxForLandmarks>
) {
  if (!qualityContext) {
    return {
      illuminationMean: 0,
      darkClippingFraction: 1,
      brightClippingFraction: 0,
      sharpness: 0
    };
  }

  const x = box ? Math.max(0, box.x * bitmap.width) : 0;
  const y = box ? Math.max(0, box.y * bitmap.height) : 0;
  const width = box
    ? Math.max(1, Math.min(bitmap.width - x, box.width * bitmap.width))
    : bitmap.width;
  const height = box
    ? Math.max(1, Math.min(bitmap.height - y, box.height * bitmap.height))
    : bitmap.height;
  qualityContext.clearRect(0, 0, QUALITY_ROI_SIZE, QUALITY_ROI_SIZE);
  qualityContext.drawImage(
    bitmap,
    x,
    y,
    width,
    height,
    0,
    0,
    QUALITY_ROI_SIZE,
    QUALITY_ROI_SIZE
  );
  return computeFaceImageQuality(
    qualityContext.getImageData(
      0,
      0,
      QUALITY_ROI_SIZE,
      QUALITY_ROI_SIZE
    )
  );
}

function cadenceFor(acquiredAtMs: number): {
  analyzedFrameRate: number;
  interResultGapMs: number | null;
} {
  const interResultGapMs =
    lastAcquiredAtMs === null
      ? null
      : acquiredAtMs - lastAcquiredAtMs;
  analyzedAcquisitionTimes.push(acquiredAtMs);
  const floor = acquiredAtMs - CADENCE_WINDOW_MS;
  analyzedAcquisitionTimes = analyzedAcquisitionTimes.filter(
    (timestamp) => timestamp >= floor
  );
  const analyzedFrameRate =
    analyzedAcquisitionTimes.length < 2
      ? 0
      : ((analyzedAcquisitionTimes.length - 1) * 1_000) /
        Math.max(
          1,
          acquiredAtMs - analyzedAcquisitionTimes[0]
        );
  return { analyzedFrameRate, interResultGapMs };
}

function processFrame(message: VisualWorkerFrameMessage): void {
  if (
    message.captureEpoch !== activeCaptureEpoch
  ) {
    message.bitmap.close();
    post({
      schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
      type: "discarded",
      captureEpoch: message.captureEpoch,
      sequence: message.sequence,
      acquiredAtMs: message.acquiredAtMs,
      reason: "capture-epoch-mismatch"
    });
    return;
  }
  if (
    message.sequence <= lastSequence ||
    (lastAcquiredAtMs !== null &&
      message.acquiredAtMs <= lastAcquiredAtMs)
  ) {
    message.bitmap.close();
    post({
      schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
      type: "discarded",
      captureEpoch: message.captureEpoch,
      sequence: message.sequence,
      acquiredAtMs: message.acquiredAtMs,
      reason: "non-monotonic-sequence"
    });
    return;
  }
  if (!landmarker || !provenance) {
    message.bitmap.close();
    meshRenderer?.clear();
    hasLandmarks = false;
    post(
      errorMessage("Face Landmarker is not ready.", {
        code: "worker-not-ready",
        recoverable: true,
        captureEpoch: message.captureEpoch,
        sequence: message.sequence,
        acquiredAtMs: message.acquiredAtMs
      })
    );
    return;
  }

  const processingStartedAtMs = performance.now();
  try {
    // Native landmarks, blendshapes, and the transform remain scoped to this
    // synchronous turn and are never included in a worker response.
    const nativeResult = landmarker.detectForVideo(
      message.bitmap,
      message.acquiredAtMs
    );
    const faceCount = nativeResult.faceLandmarks.length;
    const nativeLandmarks = faceCount === 1
      ? nativeResult.faceLandmarks[0]
      : undefined;
    if (faceCount !== 1) {
      featureState = {
        normalizedMotionPoints: null,
        acquiredAtMs: null
      };
    }
    const box = nativeLandmarks
      ? boundingBoxForLandmarks(
          nativeLandmarks,
          message.width,
          message.height
        )
      : null;
    const imageQuality = imageQualityFor(message.bitmap, box);
    const cadence = cadenceFor(message.acquiredAtMs);
    const singleFaceResult = faceCount === 1
      ? nativeResult
      : {
          ...nativeResult,
          faceLandmarks: [],
          faceBlendshapes: [],
          facialTransformationMatrixes: []
        };
    const derived = deriveFaceFeature(singleFaceResult, {
      tMs: message.tMs,
      acquiredAtMs: message.acquiredAtMs,
      sequence: message.sequence,
      captureEpoch: message.captureEpoch,
      taskContext: message.taskContext,
      frameWidth: message.width,
      frameHeight: message.height,
      imageQuality,
      analyzedFrameRate: cadence.analyzedFrameRate,
      interResultGapMs: cadence.interResultGapMs,
      skippedFrameFraction: message.stream.busyDropFraction,
      processingLatencyMs:
        performance.now() - processingStartedAtMs,
      processorRef: provenance.processorRef,
      calibration: message.calibration,
      state: featureState
    });
    featureState = continuityEligible(derived.frame, message.calibration)
      ? derived.nextState
      : {
          normalizedMotionPoints: null,
          acquiredAtMs: null
        };
    lastSequence = message.sequence;
    lastAcquiredAtMs = message.acquiredAtMs;
    if (
      nativeLandmarks &&
      faceMeshPresentationEligible(
        faceCount,
        message.captureEpoch,
        meshOverlayCaptureEpoch
      )
    ) {
      // Cache the latest landmarks in-worker for the rAF redraw loop; the
      // synchronous draw is owned by the loop, not this frame turn.
      meshRenderer?.updateLandmarks({
        landmarks: nativeLandmarks,
        taskContext: message.taskContext,
        width: message.width,
        height: message.height,
        acquiredAtMs: message.acquiredAtMs
      });
      if (!hasLandmarks) {
        hasLandmarks = true;
        // Begin the come-into-focus intro on the first lock, driven by the
        // worker's own performance.now() clock (shared with rAF timestamps).
        localizeIntro.start(performance.now());
      }
    } else {
      meshRenderer?.clear();
      hasLandmarks = false;
      localizeIntro.reset();
    }
    post({
      schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
      type: "frame",
      captureEpoch: message.captureEpoch,
      sequence: message.sequence,
      acquiredAtMs: message.acquiredAtMs,
      faceCount,
      frame: derived.frame,
      boundingBox: derived.boundingBox,
      stream: message.stream
    });
  } catch (error) {
    meshRenderer?.clear();
    hasLandmarks = false;
    post(
      errorMessage(readableError(error, "Face inference failed."), {
        code: "inference-failed",
        recoverable: true,
        captureEpoch: message.captureEpoch,
        sequence: message.sequence,
        acquiredAtMs: message.acquiredAtMs
      })
    );
  } finally {
    message.bitmap.close();
  }
}

function dispose(captureEpoch: number): void {
  stopRenderLoop();
  meshRenderer?.detach();
  meshRenderer = null;
  overlayCanvas = null;
  hasLandmarks = false;
  localizeIntro.reset();
  meshOverlayCaptureEpoch = null;
  landmarker?.close();
  landmarker = null;
  provenance = null;
  activeModelAsset = "";
  activeModelSha256 = "";
  resetDerivedState(captureEpoch);
  post({
    schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
    type: "disposed",
    captureEpoch
  });
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const candidate = event.data as Partial<VisualWorkerRequest> | null;
  if (
    !candidate ||
    candidate.schemaVersion !== VISUAL_WORKER_MESSAGE_VERSION ||
    typeof candidate.type !== "string"
  ) {
    if (
      candidate &&
      candidate.type === "frame" &&
      "bitmap" in candidate &&
      candidate.bitmap instanceof ImageBitmap
    ) {
      candidate.bitmap.close();
    }
    post(
      errorMessage("Unsupported visual worker message.", {
        code: "invalid-message",
        recoverable: false
      })
    );
    return;
  }

  const message = candidate as VisualWorkerRequest;
  if (message.type === "initialize") {
    void initialize(message).catch((error) => {
      meshRenderer?.clear();
      post(
        errorMessage(
          readableError(
            error,
            "Face Landmarker could not initialize."
          ),
          {
            code: "initialization-failed",
            recoverable: false,
            captureEpoch: message.captureEpoch
          }
        )
      );
    });
    return;
  }
  if (message.type === "reset") {
    resetDerivedState(message.captureEpoch);
    return;
  }
  if (message.type === "attach-overlay") {
    if (message.captureEpoch < activeCaptureEpoch) {
      post({
        schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
        type: "overlay-status",
        captureEpoch: message.captureEpoch,
        attached: false
      });
      return;
    }
    // Re-attach: free any previously attached renderer + stop its loop before
    // selecting a new one, so a second attach-overlay never leaks a GL context.
    stopRenderLoop();
    meshRenderer?.detach();
    overlayCanvas = message.canvas;
    overlayMaxRenderHz = message.maxRenderHz;
    // Presentation preference detected on the main thread (worker has no
    // matchMedia); re-set on every attach so the mesh honors the OS setting.
    prefersReducedMotion = message.reducedMotion;
    meshRenderer = selectRenderer(message.canvas, message.maxRenderHz);
    const attached = meshRenderer !== null;
    meshOverlayCaptureEpoch = attached ? message.captureEpoch : null;
    hasLandmarks = false;
    localizeIntro.reset();
    if (attached) {
      startRenderLoop();
    }
    // WebGL context-loss handling (no-op on the 2D backend, which never emits
    // these events). preventDefault keeps the context restorable; on restore we
    // re-select the renderer and restart the loop.
    message.canvas.addEventListener?.("webglcontextlost", (event) => {
      event.preventDefault();
      stopRenderLoop();
    });
    message.canvas.addEventListener?.("webglcontextrestored", () => {
      if (!overlayCanvas) {
        return;
      }
      meshRenderer = selectRenderer(overlayCanvas, overlayMaxRenderHz);
      if (meshRenderer) {
        startRenderLoop();
      }
    });
    post({
      schemaVersion: VISUAL_WORKER_MESSAGE_VERSION,
      type: "overlay-status",
      captureEpoch: message.captureEpoch,
      attached
    });
    return;
  }
  if (message.type === "clear-overlay") {
    if (message.captureEpoch === meshOverlayCaptureEpoch) {
      meshRenderer?.clear();
      hasLandmarks = false;
      localizeIntro.reset();
    }
    return;
  }
  if (message.type === "dispose") {
    dispose(message.captureEpoch);
    return;
  }
  processFrame(message);
});
