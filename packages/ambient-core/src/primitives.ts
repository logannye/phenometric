import type {
  AudioQualityReasonCode,
  BrowserAudioProcessingState,
  VoiceTaskContext,
  VisualQualityReasonCode,
  VisualTaskContext
} from "@phenometric/contracts";

export interface VoiceSignalFrameV1 {
  schemaVersion: "phenometric.voice-signal-frame.v1";
  tMs: number;
  acquiredAtMs: number;
  captureEpoch: number;
  sequence: number;
  absoluteSampleIndex: number;
  taskContext: VoiceTaskContext;
  /** Ambient speech activity; distinct from periodic phonation. */
  speechActive: boolean;
  /** Whether the frame contains reliable periodic phonation. */
  periodic: boolean;
  /** Changes whenever acquisition continuity or the local input track changes. */
  trackSegmentId: string;
  rms: number;
  f0Hz: number | null;
  f0Confidence: number;
  estimatorAgreement: number;
  /**
   * Rectified spectral change since the previous window; 0 for the first.
   * Already drove voice-activity and syllable detection but was never recorded,
   * so nothing downstream could reuse it.
   *
   * Optional because a frame produced by an earlier build does not carry it.
   */
  spectralFlux?: number;
  /**
   * Cepstral peak prominence in dB, the best-validated acoustic correlate of
   * dysphonia, computed on the full-rate signal.
   *
   * Null distinguishes "no harmonic structure was measurable here" -- silence,
   * or a window too short -- from a measured zero, which means the window was
   * analysed and found to have none.
   */
  cepstralPeakProminenceDb?: number | null;
  syllabicNucleus: boolean;
  clippedSampleFraction: number;
  dcOffset: number;
  snrDb: number;
  sampleRateHz: number;
  blockGapMs: number;
  lostBlockFraction: number;
  browserProcessing: BrowserAudioProcessingState;
  qualityReasons: AudioQualityReasonCode[];
  processorRef: string;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface FacialBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  widthPixels: number;
  heightPixels: number;
  edgeMarginFraction: number;
}

export interface FacialPose {
  yawDegrees: number;
  pitchDegrees: number;
  rollDegrees: number;
}

export interface BilateralValue {
  left: number;
  right: number;
}

export interface FacialKinematicsFrameV1 {
  schemaVersion: "phenometric.facial-kinematics-frame.v1";
  tMs: number;
  acquiredAtMs: number;
  sequence: number;
  captureEpoch: number;
  taskContext: VisualTaskContext;
  /** Detector count capped at two; ambient extraction requires exactly one. */
  faceCount?: number;
  /** Changes after loss, reacquisition, or processor continuity breaks. */
  trackSegmentId?: string;
  faceVisible: boolean;
  boundingBox: FacialBoundingBox | null;
  anatomicalLaterality: "subject-anatomical";
  pose: FacialPose | null;
  eyeAperture: BilateralValue | null;
  /**
   * Brow arc height above the inter-eye axis, per side, in inter-eye units.
   * Frontalis is the zone that separates upper- from lower-motor-neuron
   * facial weakness, so it is measured separately from the eye.
   */
  browHeight: BilateralValue | null;
  mouthCorners: {
    left: NormalizedPoint;
    right: NormalizedPoint;
  } | null;
  mouthApertureRatio: number | null;
  regionalMovementSpeed: number | null;
  imageQuality: {
    illuminationMean: number;
    darkClippingFraction: number;
    brightClippingFraction: number;
    sharpness: number;
  };
  analyzedFrameRate: number;
  interResultGapMs: number | null;
  skippedFrameFraction: number;
  processingLatencyMs: number;
  qualityReasons: VisualQualityReasonCode[];
  processorRef: string;
}
