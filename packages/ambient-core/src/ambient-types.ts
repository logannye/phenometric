import type {
  FacialKinematicsFrameV1,
  VoiceSignalFrameV1
} from "./primitives.js";

export const AMBIENT_PROTOCOL_ID = "ambient-local-observation" as const;
export const AMBIENT_VOICE_TASK_CONTEXT = "ambient-speech-turn" as const;
export const AMBIENT_FACE_TASK_CONTEXT = "ambient-frontal" as const;
export const AMBIENT_MAX_CAPTURE_DURATION_MS = 300_000;

export type AmbientTaskContext =
  | typeof AMBIENT_VOICE_TASK_CONTEXT
  | typeof AMBIENT_FACE_TASK_CONTEXT;

export type AmbientMetricModality = "voice" | "face";

export type AmbientMetricGroup =
  | "pitch"
  | "speech-timing"
  | "eye-geometry"
  | "mouth-geometry"
  | "symmetry"
  | "expression-dynamics"
  | "brow-geometry"
  | "movement"
  | "blink-behavior";

export type AmbientVoiceMetricCode =
  | "ambient.voice.f0.median"
  | "ambient.voice.f0.variability"
  | "ambient.voice.speech_activity_fraction"
  | "ambient.voice.pause_rate"
  | "ambient.voice.pause_duration.median"
  | "ambient.voice.speech_run_duration.median"
  | "ambient.voice.acoustic_nucleus_rate";

export type AmbientFaceMetricCode =
  | "ambient.face.eye_aperture.left"
  | "ambient.face.eye_aperture.right"
  | "ambient.face.eye_aperture.asymmetry"
  | "ambient.face.mouth_width"
  | "ambient.face.mouth_aperture.median"
  | "ambient.face.mouth_aperture.p90"
  | "ambient.face.mouth_corner_position.asymmetry"
  | "ambient.face.landmark_speed.p90"
  | "ambient.face.blink_rate.bilateral"
  | "ambient.face.rest_mouth_corner_asymmetry.signed"
  | "ambient.face.rest_eye_aperture_asymmetry.signed"
  | "ambient.face.spontaneous_event_rate"
  | "ambient.face.spontaneous_excursion.p90"
  | "ambient.face.spontaneous_excursion_asymmetry.median"
  | "ambient.face.oculo_oral_synkinesis_index"
  | "ambient.face.brow_height.left"
  | "ambient.face.brow_height.right"
  | "ambient.face.brow_height_asymmetry.signed"
  | "ambient.face.lid_closure_completeness.left"
  | "ambient.face.lid_closure_completeness.right";

export type AmbientMetricCode =
  | AmbientVoiceMetricCode
  | AmbientFaceMetricCode;

export type AmbientWithheldReasonCode =
  | "processor-unavailable"
  | "quality-threshold-failed"
  | "no-usable-signal"
  | "insufficient-segments"
  | "insufficient-duration"
  | "insufficient-active-speech"
  | "insufficient-pitched-speech"
  | "insufficient-pitch-bins"
  | "insufficient-events"
  | "insufficient-nuclei"
  | "insufficient-bins"
  | "insufficient-exposure"
  | "insufficient-frame-cadence"
  | "multiple-faces";

export interface AmbientMetricDefinition {
  code: AmbientMetricCode;
  label: string;
  unit: string;
  modality: AmbientMetricModality;
  group: AmbientMetricGroup;
  context: AmbientTaskContext;
  algorithmVersion: string;
  qualityInputs: readonly string[];
  minimumEvidence: Readonly<Record<string, number>>;
  validationStatus: "not-clinically-validated";
  technicalVerification: "automated-test";
  clinicalValidation: "none";
}

/** Ambient voice frames require explicit activity, periodicity, and track attribution. */
export type AmbientVoiceFrame = VoiceSignalFrameV1;

/**
 * Ambient facial attribution is fail-closed: acquisition must report a face
 * count and a track segment rather than allowing the extractor to infer them.
 */
export type AmbientFacialFrame = FacialKinematicsFrameV1 & {
  faceCount?: number;
  trackSegmentId?: string;
};

export interface AmbientIdentityInput {
  sessionId: string;
  protocolId?: typeof AMBIENT_PROTOCOL_ID;
  protocolVersion: string;
  protocolContentSha256: string;
  sessionStartedAtMs: number;
}

export interface AmbientFaceCalibration {
  durationMs: number;
  baselineBoxWidthPixels: number;
  baselineBoxHeightPixels: number;
}

export interface AmbientVoiceExtractionOptions extends AmbientIdentityInput {
  noiseCalibrationDurationMs: number;
}

export interface AmbientFaceExtractionOptions extends AmbientIdentityInput {
  calibration: AmbientFaceCalibration | null;
}

export interface AmbientMetricEvidence {
  observedStartMs: number | null;
  observedEndMs: number | null;
  eligibleDurationMs: number;
  sampleCount: number;
  segmentCount: number;
  qualifyingBinCount: number;
  activeSpeechDurationMs?: number;
  pitchedDurationMs?: number;
  /** Voiced share of active speech. A property of phonation, not of capture. */
  pitchCoverage?: number;
  /**
   * Worst per-segment acquisition coverage — min(cadence, 1 - lost blocks) —
   * across the segments backing the metric. This is what bounds the
   * reliability of duration and rate measurements, and is deliberately
   * distinct from {@link pitchCoverage}.
   */
  timingCoverage?: number;
  pauseCount?: number;
  speechRunCount?: number;
  nucleusCount?: number;
  frontalExposureMs?: number;
  blinkCount?: number;
  /** Spontaneous expression events detected in the session. */
  expressionEventCount?: number;
  /** Events where both sides moved enough to measure oculo-oral coupling. */
  coupledExpressionEventCount?: number;

  /*
   * Gate-verification facts.
   *
   * Each is the WORST value observed across the accepted units backing the
   * metric — a minimum where the pack states a `minimum*` threshold, a maximum
   * where it states a `maximum*` one. That polarity is what lets the report
   * layer re-verify a gate on the same statistic the extractor enforced,
   * rather than inferring it from a neighbouring quantity. Every accepted unit
   * already cleared the gate, so if the worst one satisfies the threshold, all
   * of them did.
   *
   * Absence is meaningful: a metric measured without the fact its own pack
   * entry requires is a provenance error, not a pass.
   */

  /** Voice: lowest pitch-estimator confidence among pitch-usable frames. */
  estimatorQuality?: number;
  /** Voice: lowest agreement between the two pitch estimators. */
  estimatorAgreement?: number;
  /** Voice: shortest accepted segment. */
  segmentSpanMs?: number;
  /** Voice: least active speech contributed by any one accepted segment. */
  activeSpeechPerSegmentMs?: number;
  /** Voice: fewest valid 500 ms pitch subwindows in any accepted segment. */
  validBinsPerSegment?: number;

  /** Face: lowest analyzed cadence among accepted bins. */
  cadenceHz?: number;
  /** Face: 95th-percentile inter-frame gap across accepted bins. */
  p95FrameGapMs?: number;
  /** Face: largest inter-frame gap across accepted bins. */
  maximumFrameGapMs?: number;
  /** Face: least analyzed data contributed by any one accepted bin. */
  dataPerBinMs?: number;
  /** Face: fewest frames in any accepted bin. */
  samplesPerBin?: number;
  /** Face: shortest wall-clock span of any accepted bin. */
  binSpanMs?: number;
  processorRefs: readonly string[];
  trackSegmentIds: readonly string[];
  sourceWindowRefs: readonly string[];
}

export interface AmbientMetricIdentity {
  outcomeId: string;
  identityKey: string;
  sessionId: string;
  protocolId: typeof AMBIENT_PROTOCOL_ID;
  protocolVersion: string;
  protocolContentSha256: string;
  context: AmbientTaskContext;
  algorithmVersion: string;
  processorRefs: readonly string[];
  trackSegmentIds: readonly string[];
}

interface AmbientMetricOutcomeBase {
  code: AmbientMetricCode;
  label: string;
  unit: string;
  modality: AmbientMetricModality;
  group: AmbientMetricGroup;
  evidence: AmbientMetricEvidence;
  identity: AmbientMetricIdentity;
}

export interface AmbientMeasuredMetric extends AmbientMetricOutcomeBase {
  status: "measured";
  value: number;
  technicalQualityScore: number;
  technicalDispersion: number | null;
}

export interface AmbientWithheldMetric extends AmbientMetricOutcomeBase {
  status: "withheld";
  reasonCode: AmbientWithheldReasonCode;
  detail: string;
  technicalQualityScore: null;
  technicalDispersion: null;
}

export type AmbientMetricOutcome =
  | AmbientMeasuredMetric
  | AmbientWithheldMetric;

export interface AmbientExtractionResult<
  Outcome extends AmbientMetricOutcome = AmbientMetricOutcome
> {
  outcomes: Outcome[];
  ignoredFrameCount: number;
}

export interface AmbientSessionExtractionInput {
  identity: AmbientIdentityInput;
  voice: {
    frames: readonly AmbientVoiceFrame[];
    noiseCalibrationDurationMs: number;
  };
  face: {
    frames: readonly AmbientFacialFrame[];
    calibration: AmbientFaceCalibration | null;
  };
}
