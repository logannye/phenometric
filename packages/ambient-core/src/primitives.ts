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
  /**
   * Palpebral fissure dimensions per side, in shared inter-eye units.
   *
   * `eyeAperture` divides each eye's lid gap by that same eye's canthal width,
   * so a fissure that is uniformly smaller on one side -- the shape ptosis and
   * orbicularis weakness produce -- still yields a normal-looking ratio.
   * Measuring the dimensions separately against the shared facial scale keeps
   * that difference visible.
   *
   * Optional: frames from a build before this was derived do not carry it.
   */
  fissureWidth?: BilateralValue | null;
  fissureHeight?: BilateralValue | null;
  /**
   * Lateral offset of the mouth centre from the facial midline, signed toward
   * the subject's left. Distinct from corner asymmetry: a mouth pulled bodily
   * off-centre moves this without changing the height difference between the
   * corners, and a dropped corner moves that without changing this.
   */
  mouthMidlineOffset?: number | null;
  /**
   * Iris centre relative to the midpoint of that eye's canthi, so it describes
   * where the eye points independently of where the head is.
   *
   * Null when the model returns only the 468-point base mesh. A zeroed offset
   * would read as "looking straight ahead", which is a measurement that was
   * never made.
   */
  gazeOffset?: {
    left: NormalizedPoint;
    right: NormalizedPoint;
  } | null;
  /**
   * Limbus diameter per side, in inter-eye units. Near-constant within a
   * person, so this is a scale reference rather than a signal -- and NOT pupil
   * diameter, which this model does not expose.
   */
  irisDiameter?: BilateralValue | null;
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
