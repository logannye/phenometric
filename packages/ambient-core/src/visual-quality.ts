import type {
  CaptureQualityPolicy,
  FaceCalibration,
  VisualQualityAssessment,
  VisualQualityReasonCode
} from "@phenometrix/contracts";
import type { FacialKinematicsFrameV1 } from "./primitives.js";

export const DEFAULT_CAPTURE_QUALITY_POLICY: CaptureQualityPolicy = {
  id: "visual-foundation-v1",
  speechOpenDebounceMs: 300,
  maximumSpeechPauseMs: 2_000,
  faceQualityDebounceMs: 750,
  minimumAnalyzedFrameRate: 20,
  maximumVisualFrameGapMs: 200,
  maximumSkippedFrameFraction: 0.25,
  rollingVisualQualityWindowMs: 2_000,
  minimumFaceWidthPixels: 180,
  minimumFaceHeightPixels: 220,
  maximumFaceWidthFraction: 0.7,
  maximumFaceHeightFraction: 0.9,
  minimumEdgeMarginFraction: 0.02,
  maximumFaceYawDegrees: 15,
  maximumFacePitchDegrees: 15,
  maximumFaceRollDegrees: 10,
  minimumIlluminationMean: 0.12,
  maximumIlluminationMean: 0.9,
  maximumDarkClippingFraction: 0.2,
  maximumBrightClippingFraction: 0.2,
  minimumSharpness: 0.0008,
  calibrationSharpnessFraction: 0.5,
  minimumFaceCalibrationDurationMs: 1_500,
  minimumFaceCalibrationUsableFraction: 0.8
};

const REASON_ORDER: readonly VisualQualityReasonCode[] = [
  "document-hidden",
  "camera-unavailable",
  "worker-unavailable",
  "face-not-visible",
  "face-too-small",
  "face-too-large",
  "face-edge-margin",
  "pose-out-of-range",
  "illumination-out-of-range",
  "blur",
  "frame-rate-below-minimum",
  "visual-frame-gap",
  "too-many-skipped-frames"
];

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function outsideMagnitude(value: number, maximum: number): boolean {
  return !finite(value) || Math.abs(value) > maximum;
}

export function evaluateVisualQuality(
  frame: FacialKinematicsFrameV1,
  calibration: FaceCalibration | null = null,
  policy: CaptureQualityPolicy = DEFAULT_CAPTURE_QUALITY_POLICY
): VisualQualityAssessment {
  const reasons = new Set<VisualQualityReasonCode>(frame.qualityReasons);
  const sharpnessFloor = Math.max(
    policy.minimumSharpness,
    (calibration?.baselineSharpness ?? 0) *
      policy.calibrationSharpnessFraction
  );

  if (
    !frame.faceVisible ||
    frame.boundingBox === null ||
    frame.pose === null ||
    frame.eyeAperture === null ||
    frame.mouthCorners === null
  ) {
    reasons.add("face-not-visible");
  } else {
    const box = frame.boundingBox;
    if (
      !finite(box.widthPixels) ||
      !finite(box.heightPixels) ||
      box.widthPixels < policy.minimumFaceWidthPixels ||
      box.heightPixels < policy.minimumFaceHeightPixels
    ) {
      reasons.add("face-too-small");
    }
    if (
      !finite(box.width) ||
      !finite(box.height) ||
      box.width > policy.maximumFaceWidthFraction ||
      box.height > policy.maximumFaceHeightFraction
    ) {
      reasons.add("face-too-large");
    }
    if (
      !finite(box.edgeMarginFraction) ||
      box.edgeMarginFraction < policy.minimumEdgeMarginFraction
    ) {
      reasons.add("face-edge-margin");
    }

    const pose = frame.pose;
    if (
      outsideMagnitude(pose.yawDegrees, policy.maximumFaceYawDegrees) ||
      outsideMagnitude(pose.pitchDegrees, policy.maximumFacePitchDegrees) ||
      outsideMagnitude(pose.rollDegrees, policy.maximumFaceRollDegrees)
    ) {
      reasons.add("pose-out-of-range");
    }
  }

  const image = frame.imageQuality;
  if (
    !finite(image.illuminationMean) ||
    image.illuminationMean < policy.minimumIlluminationMean ||
    image.illuminationMean > policy.maximumIlluminationMean ||
    !finite(image.darkClippingFraction) ||
    image.darkClippingFraction > policy.maximumDarkClippingFraction ||
    !finite(image.brightClippingFraction) ||
    image.brightClippingFraction > policy.maximumBrightClippingFraction
  ) {
    reasons.add("illumination-out-of-range");
  }
  if (!finite(image.sharpness) || image.sharpness < sharpnessFloor) {
    reasons.add("blur");
  }
  if (
    !finite(frame.analyzedFrameRate) ||
    frame.analyzedFrameRate < policy.minimumAnalyzedFrameRate
  ) {
    reasons.add("frame-rate-below-minimum");
  }
  if (
    frame.interResultGapMs !== null &&
    (!finite(frame.interResultGapMs) ||
      frame.interResultGapMs > policy.maximumVisualFrameGapMs)
  ) {
    reasons.add("visual-frame-gap");
  }
  if (
    !finite(frame.skippedFrameFraction) ||
    frame.skippedFrameFraction > policy.maximumSkippedFrameFraction
  ) {
    reasons.add("too-many-skipped-frames");
  }

  const reasonCodes = REASON_ORDER.filter((reason) => reasons.has(reason));
  return {
    usable: reasonCodes.length === 0,
    reasonCodes,
    sharpnessFloor
  };
}
