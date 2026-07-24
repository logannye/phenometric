import type { VisualTaskContext } from "@phenometrix/contracts";
import type {
  FacialKinematicsFrameV1,
  VoiceSignalFrameV1
} from "./primitives.js";

const SYNTHETIC_FACE_PROCESSOR_REF =
  "mediapipe-face-landmarker@0.10.35+synthetic-model";

export function syntheticVoiceFrame(
  tMs: number,
  overrides: Partial<VoiceSignalFrameV1> = {}
): VoiceSignalFrameV1 {
  return {
    schemaVersion: "phenometric.voice-signal-frame.v1",
    tMs,
    acquiredAtMs: tMs,
    captureEpoch: 1,
    sequence: Math.floor(tMs / 10) + 1,
    absoluteSampleIndex: Math.round(tMs * 48),
    taskContext: "ambient-speech-turn",
    speechActive: true,
    periodic: true,
    trackSegmentId: "local-microphone-1",
    rms: 0.08,
    f0Hz: 140 + Math.sin(tMs / 200) * 5,
    f0Confidence: 0.92,
    estimatorAgreement: 0.95,
    syllabicNucleus: tMs % 400 < 10,
    clippedSampleFraction: 0,
    dcOffset: 0.001,
    snrDb: 26,
    sampleRateHz: 48_000,
    blockGapMs: 10,
    lostBlockFraction: 0,
    browserProcessing: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    qualityReasons: [],
    processorRef: "browser-voice-dsp@1.0",
    ...overrides
  };
}

export function syntheticFacialFrame(
  tMs: number,
  taskContext: VisualTaskContext,
  overrides: Partial<FacialKinematicsFrameV1> = {}
): FacialKinematicsFrameV1 {
  return {
    schemaVersion: "phenometric.facial-kinematics-frame.v1",
    tMs,
    acquiredAtMs: tMs,
    sequence: Math.round(tMs / 50),
    captureEpoch: 1,
    taskContext,
    faceVisible: true,
    boundingBox: {
      x: 0.35,
      y: 0.2,
      width: 0.3,
      height: 0.5,
      widthPixels: 384,
      heightPixels: 360,
      edgeMarginFraction: 0.1
    },
    anatomicalLaterality: "subject-anatomical",
    pose: { yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 },
    eyeAperture: { left: 0.3, right: 0.3 },
    browHeight: { left: 0.55, right: 0.55 },
    mouthCorners: {
      left: { x: 0.3, y: 0.1 },
      right: { x: -0.3, y: 0.1 }
    },
    mouthApertureRatio: 0.08,
    regionalMovementSpeed: 0.02,
    imageQuality: {
      illuminationMean: 0.55,
      darkClippingFraction: 0.02,
      brightClippingFraction: 0.02,
      sharpness: 0.002
    },
    analyzedFrameRate: 30,
    interResultGapMs: tMs === 0 ? null : 50,
    skippedFrameFraction: 0,
    processingLatencyMs: 8,
    qualityReasons: [],
    processorRef: SYNTHETIC_FACE_PROCESSOR_REF,
    ...overrides
  };
}
