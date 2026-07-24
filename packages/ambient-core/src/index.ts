export const AMBIENT_CORE_VERSION = "0.1.0";
export {
  AMBIENT_FACE_TASK_CONTEXT,
  AMBIENT_MAX_CAPTURE_DURATION_MS,
  AMBIENT_PROTOCOL_ID,
  AMBIENT_VOICE_TASK_CONTEXT
} from "./ambient-types.js";
export type {
  AmbientExtractionResult,
  AmbientFaceCalibration,
  AmbientFaceExtractionOptions,
  AmbientFaceMetricCode,
  AmbientFacialFrame,
  AmbientIdentityInput,
  AmbientMeasuredMetric,
  AmbientMetricCode,
  AmbientMetricDefinition,
  AmbientMetricEvidence,
  AmbientMetricGroup,
  AmbientMetricIdentity,
  AmbientMetricModality,
  AmbientMetricOutcome,
  AmbientSessionExtractionInput,
  AmbientTaskContext,
  AmbientVoiceExtractionOptions,
  AmbientVoiceFrame,
  AmbientVoiceMetricCode,
  AmbientWithheldMetric,
  AmbientWithheldReasonCode
} from "./ambient-types.js";
export {
  AMBIENT_FACE_ALGORITHM_VERSION,
  AMBIENT_METRIC_REGISTRY,
  AMBIENT_VOICE_ALGORITHM_VERSION,
  ambientMetricDefinition
} from "./ambient-registry.js";
export {
  AMBIENT_VOICE_ACTIVE_MIN_MS,
  AMBIENT_VOICE_ACTIVE_PER_SEGMENT_MIN_MS,
  AMBIENT_VOICE_MAX_ABSOLUTE_DC_OFFSET,
  AMBIENT_VOICE_MAX_CLIPPED_FRACTION,
  AMBIENT_VOICE_MAX_GAP_MS,
  AMBIENT_VOICE_MAX_LOST_BLOCK_FRACTION,
  AMBIENT_VOICE_MAX_PAUSE_MS,
  AMBIENT_VOICE_MIN_NUCLEUS_COUNT,
  AMBIENT_VOICE_MIN_PAUSE_MS,
  AMBIENT_VOICE_MIN_PITCH_COVERAGE,
  AMBIENT_VOICE_MIN_SAMPLE_RATE_HZ,
  AMBIENT_VOICE_MIN_SEGMENTS,
  AMBIENT_VOICE_MIN_SPEECH_SNR_DB,
  AMBIENT_VOICE_PITCH_MIN_MS,
  AMBIENT_VOICE_SEGMENT_MAX_MS,
  AMBIENT_VOICE_SEGMENT_MIN_MS,
  AMBIENT_VOICE_TIMING_MIN_MS,
  extractAmbientVoiceMetrics
} from "./ambient-voice.js";
export {
  AMBIENT_BLINK_MAX_P95_GAP_MS,
  AMBIENT_BLINK_MIN_CADENCE_HZ,
  AMBIENT_BLINK_MIN_EXPOSURE_MS,
  AMBIENT_FACE_BIN_MS,
  AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA,
  AMBIENT_FACE_MAX_FRAME_GAP_MS,
  AMBIENT_FACE_MAX_PITCH_DEGREES,
  AMBIENT_FACE_MAX_ROLL_DEGREES,
  AMBIENT_FACE_MAX_WITHIN_BIN_SIZE_RATIO,
  AMBIENT_FACE_MAX_YAW_DEGREES,
  AMBIENT_FACE_MIN_BINS,
  AMBIENT_FACE_MIN_BIN_DATA_MS,
  AMBIENT_FACE_MIN_BIN_SPAN_MS,
  AMBIENT_FACE_MIN_SAMPLES_PER_BIN,
  AMBIENT_FACE_MIN_SPAN_MS,
  extractAmbientFaceMetrics
} from "./ambient-face.js";
export { finalizeAmbientMetrics } from "./ambient-metrics.js";
export type {
  VoiceSignalFrameV1,
  NormalizedPoint,
  FacialBoundingBox,
  FacialPose,
  BilateralValue,
  FacialKinematicsFrameV1
} from "./primitives.js";
export {
  browserAudioProcessingEnabled,
  evaluateVoiceQuality,
  VOICE_FINE_ACOUSTIC_SNR_FLOOR_DB,
  VOICE_GENERAL_SNR_FLOOR_DB,
  VOICE_MAXIMUM_ABSOLUTE_DC_OFFSET,
  VOICE_MAXIMUM_BLOCK_GAP_MS,
  VOICE_MAXIMUM_CLIPPED_SAMPLE_FRACTION,
  VOICE_MAXIMUM_LOST_BLOCK_FRACTION,
  VOICE_MINIMUM_SAMPLE_RATE_HZ,
  VOICE_MINIMUM_SIGNAL_RMS
} from "./voice-quality.js";
export type { VoiceQualityAssessment } from "./voice-quality.js";
export {
  DEFAULT_CAPTURE_QUALITY_POLICY,
  evaluateVisualQuality
} from "./visual-quality.js";

export {
  EXPRESSION_MIN_EVENTS,
  EXPRESSION_ONSET_ELEVATION,
  SYNKINESIS_MIN_ELEVATION,
  detectExpressionEvents,
  excursionAsymmetry,
  restingBaseline,
  summarizeExpressions,
  synkinesisIndex,
  type ExpressionBaseline,
  type ExpressionEvent,
  type ExpressionSummary
} from "./expression-events.js";
