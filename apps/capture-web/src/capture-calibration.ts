import {
  DEFAULT_CAPTURE_QUALITY_POLICY,
  evaluateVisualQuality,
  type FacialKinematicsFrameV1
} from "@phenometrix/ambient-core";
import type {
  AudioCalibration,
  CalibrationQuality,
  CaptureCalibration,
  FaceCalibration,
  VisualQualityAssessment,
  VisualQualityReasonCode
} from "@phenometrix/contracts";

export const PREFLIGHT_FACE_MINIMUM_DURATION_MS =
  DEFAULT_CAPTURE_QUALITY_POLICY.minimumFaceCalibrationDurationMs;
export const PREFLIGHT_FACE_MINIMUM_USABLE_FRACTION =
  DEFAULT_CAPTURE_QUALITY_POLICY.minimumFaceCalibrationUsableFraction;

export type FaceGuidance =
  | "Face ready"
  | "Move into view"
  | "Move closer"
  | "Move farther back"
  | "Center your face"
  | "Face the camera"
  | "Please turn on a light"
  | "Hold still"
  | "Camera needs a moment";

export interface CalibratedFaceFrame {
  frame: FacialKinematicsFrameV1;
  usable: boolean;
  guidance: FaceGuidance;
  assessment: VisualQualityAssessment;
}

export interface FaceCalibrationResult {
  quality: CalibrationQuality;
  calibration: FaceCalibration | null;
  usableFrameCount: number;
}

export function classifyAudioCalibration(
  reliablePitchFrames: number,
  speechEnergyFrames: number
): CalibrationQuality {
  if (reliablePitchFrames >= 8) return "strong";
  if (speechEnergyFrames > 0) return "limited";
  return "unavailable";
}

function median(values: number[]): number {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return 0;
  const sorted = [...finiteValues].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function chronological(
  frames: FacialKinematicsFrameV1[]
): FacialKinematicsFrameV1[] {
  const timestamped = frames.filter(
    (frame) =>
      Number.isFinite(frame.acquiredAtMs) &&
      frame.acquiredAtMs >= 0
  );
  const latestEpoch = timestamped.reduce(
    (latest, frame) => Math.max(latest, frame.captureEpoch),
    Number.NEGATIVE_INFINITY
  );
  return timestamped
    .filter((frame) => frame.captureEpoch === latestEpoch)
    .sort(
      (left, right) => left.acquiredAtMs - right.acquiredAtMs
    );
}

function durationMs(frames: FacialKinematicsFrameV1[]): number {
  return frames.length < 2
    ? 0
    : Math.max(
        0,
        frames.at(-1)!.acquiredAtMs - frames[0].acquiredAtMs
      );
}

function measuredFrameRate(
  frames: FacialKinematicsFrameV1[],
  duration: number
): number {
  if (frames.length >= 2 && duration > 0) {
    return ((frames.length - 1) * 1_000) / duration;
  }
  return median(frames.map((frame) => frame.analyzedFrameRate));
}

function guidanceForReasons(
  reasons: readonly VisualQualityReasonCode[]
): FaceGuidance {
  if (
    reasons.includes("face-not-visible") ||
    reasons.includes("camera-unavailable") ||
    reasons.includes("worker-unavailable") ||
    reasons.includes("document-hidden")
  ) {
    return "Move into view";
  }
  if (reasons.includes("pose-out-of-range")) return "Face the camera";
  if (reasons.includes("face-too-small")) return "Move closer";
  if (reasons.includes("face-too-large")) return "Move farther back";
  if (reasons.includes("face-edge-margin")) return "Center your face";
  if (reasons.includes("illumination-out-of-range")) {
    return "Please turn on a light";
  }
  if (reasons.includes("blur")) return "Hold still";
  if (
    reasons.includes("frame-rate-below-minimum") ||
    reasons.includes("visual-frame-gap") ||
    reasons.includes("too-many-skipped-frames")
  ) {
    return "Camera needs a moment";
  }
  return "Face ready";
}

export function preflightFaceGuidance(
  frame: FacialKinematicsFrameV1
): FaceGuidance {
  return guidanceForReasons(evaluateVisualQuality(frame).reasonCodes);
}

export function facePreflightPassed(
  frames: FacialKinematicsFrameV1[]
): boolean {
  return classifyFaceCalibration(frames).quality === "strong";
}

function baselineCandidates(
  frames: FacialKinematicsFrameV1[]
): {
  usable: FacialKinematicsFrameV1[];
  baseline: FacialKinematicsFrameV1[];
} {
  const usable = frames.filter(
    (frame) => evaluateVisualQuality(frame).usable
  );
  const visible = frames.filter(
    (frame) =>
      frame.faceVisible &&
      frame.boundingBox !== null &&
      frame.pose !== null &&
      frame.eyeAperture !== null &&
      frame.mouthCorners !== null
  );
  return {
    usable,
    baseline: usable.length > 0 ? usable : visible
  };
}

function buildFaceCalibration(
  frames: FacialKinematicsFrameV1[],
  usable: FacialKinematicsFrameV1[],
  baseline: FacialKinematicsFrameV1[]
): FaceCalibration {
  const duration = durationMs(frames);
  return {
    durationMs: duration,
    totalFrameCount: frames.length,
    usableFrameCount: usable.length,
    usableFraction:
      frames.length === 0 ? 0 : usable.length / frames.length,
    analyzedFrameRate: measuredFrameRate(frames, duration),
    baselineBoxWidthPixels: median(
      baseline.map((frame) => frame.boundingBox!.widthPixels)
    ),
    baselineBoxHeightPixels: median(
      baseline.map((frame) => frame.boundingBox!.heightPixels)
    ),
    baselineIlluminationMean: median(
      baseline.map((frame) => frame.imageQuality.illuminationMean)
    ),
    baselineSharpness: median(
      baseline.map((frame) => frame.imageQuality.sharpness)
    )
  };
}

export function createFaceCalibration(
  sourceFrames: FacialKinematicsFrameV1[]
): FaceCalibration {
  const frames = chronological(sourceFrames);
  const { usable, baseline } = baselineCandidates(frames);
  if (baseline.length === 0) {
    throw new Error("A visible facial baseline is required.");
  }
  const calibration = buildFaceCalibration(
    frames,
    usable,
    baseline
  );
  if (
    calibration.durationMs < PREFLIGHT_FACE_MINIMUM_DURATION_MS ||
    calibration.usableFraction <
      PREFLIGHT_FACE_MINIMUM_USABLE_FRACTION ||
    calibration.analyzedFrameRate <
      DEFAULT_CAPTURE_QUALITY_POLICY.minimumAnalyzedFrameRate
  ) {
    throw new Error(
      "A stable 1.5-second facial baseline is required."
    );
  }
  return calibration;
}

export function classifyFaceCalibration(
  sourceFrames: FacialKinematicsFrameV1[]
): FaceCalibrationResult {
  const frames = chronological(sourceFrames);
  const { usable, baseline } = baselineCandidates(frames);
  if (baseline.length === 0) {
    return {
      quality: "unavailable",
      calibration: null,
      usableFrameCount: 0
    };
  }
  const calibration = buildFaceCalibration(
    frames,
    usable,
    baseline
  );
  const strong =
    calibration.durationMs >= PREFLIGHT_FACE_MINIMUM_DURATION_MS &&
    calibration.usableFraction >=
      PREFLIGHT_FACE_MINIMUM_USABLE_FRACTION &&
    calibration.analyzedFrameRate >=
      DEFAULT_CAPTURE_QUALITY_POLICY.minimumAnalyzedFrameRate;
  return {
    quality: strong ? "strong" : "limited",
    calibration,
    usableFrameCount: usable.length
  };
}

export function calibrateFaceFrame(
  frame: FacialKinematicsFrameV1,
  calibration: FaceCalibration
): CalibratedFaceFrame {
  const assessment = evaluateVisualQuality(frame, calibration);
  return {
    frame: {
      ...frame,
      qualityReasons: assessment.reasonCodes
    },
    usable: assessment.usable,
    guidance: guidanceForReasons(assessment.reasonCodes),
    assessment
  };
}

export function createCaptureCalibration(
  audio: AudioCalibration,
  audioQuality: CalibrationQuality,
  faceResult: FaceCalibrationResult,
  profileId: CaptureCalibration["profileId"] = "visual-foundation-v1"
): CaptureCalibration {
  return {
    schemaVersion: "phenometric.capture-calibration.v2",
    profileId,
    calibratedAt: new Date().toISOString(),
    audio,
    audioQuality,
    face: faceResult.calibration,
    faceQuality: faceResult.quality
  };
}
