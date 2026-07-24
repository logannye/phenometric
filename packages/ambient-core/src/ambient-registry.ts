import {
  AMBIENT_FACE_TASK_CONTEXT,
  AMBIENT_VOICE_TASK_CONTEXT,
  type AmbientMetricCode,
  type AmbientMetricDefinition
} from "./ambient-types.js";

const AMBIENT_EXPRESSION_MIN_EVENTS = 3;

export const AMBIENT_VOICE_ALGORITHM_VERSION =
  "1.0.0";
export const AMBIENT_FACE_ALGORITHM_VERSION =
  "1.0.0";

const voiceQualityInputs = Object.freeze([
  "noise-calibration-duration",
  "sample-rate",
  "frame-continuity",
  "lost-block-fraction",
  "clipping",
  "dc-offset",
  "speech-active-snr"
]);

const faceQualityInputs = Object.freeze([
  "face-count",
  "frame-continuity",
  "visual-quality",
  "frontal-pose",
  "calibrated-face-size",
  "within-bin-face-size-stability",
  "processor-and-track-continuity"
]);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const AMBIENT_METRIC_REGISTRY: readonly AmbientMetricDefinition[] =
  deepFreeze([
    {
      code: "ambient.voice.f0.median",
      label: "Median fundamental frequency",
      unit: "Hz",
      modality: "voice",
      group: "pitch",
      context: AMBIENT_VOICE_TASK_CONTEXT,
      algorithmVersion: AMBIENT_VOICE_ALGORITHM_VERSION,
      qualityInputs: voiceQualityInputs,
      minimumEvidence: {
        noiseCalibrationDurationMs: 2_000,
        segmentCount: 3,
        pitchedDurationMs: 10_000,
        pitchedDurationPerSegmentMs: 1_000,
        pitchCoverage: 0.6,
        f0Confidence: 0.55,
        estimatorAgreement: 0.7,
        minimumF0Hz: 50,
        maximumF0Hz: 700
      },
      validationStatus: "not-clinically-validated",
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.voice.f0.variability",
      label: "Fundamental-frequency variability",
      unit: "semitone-SD",
      modality: "voice",
      group: "pitch",
      context: AMBIENT_VOICE_TASK_CONTEXT,
      algorithmVersion: AMBIENT_VOICE_ALGORITHM_VERSION,
      qualityInputs: voiceQualityInputs,
      minimumEvidence: {
        segmentCount: 3,
        pitchedDurationMs: 10_000,
        pitchCoverage: 0.6,
        validSubwindowsPerSegment: 4,
        subwindowDurationMs: 500
      },
      validationStatus: "not-clinically-validated",
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.voice.speech_activity_fraction",
      label: "Speech-activity fraction",
      unit: "ratio",
      modality: "voice",
      group: "speech-timing",
      context: AMBIENT_VOICE_TASK_CONTEXT,
      algorithmVersion: AMBIENT_VOICE_ALGORITHM_VERSION,
      qualityInputs: voiceQualityInputs,
      minimumEvidence: {
        segmentCount: 3,
        eligibleDurationMs: 30_000,
        activeSpeechDurationMs: 15_000
      },
      validationStatus: "not-clinically-validated",
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.voice.pause_rate",
      label: "Pause rate",
      unit: "pauses/minute",
      modality: "voice",
      group: "speech-timing",
      context: AMBIENT_VOICE_TASK_CONTEXT,
      algorithmVersion: AMBIENT_VOICE_ALGORITHM_VERSION,
      qualityInputs: voiceQualityInputs,
      minimumEvidence: {
        segmentCount: 3,
        eligibleDurationMs: 30_000,
        activeSpeechDurationMs: 15_000,
        minimumPauseMs: 200,
        maximumPauseMs: 1_999
      },
      validationStatus: "not-clinically-validated",
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.voice.pause_duration.median",
      label: "Median pause duration",
      unit: "seconds",
      modality: "voice",
      group: "speech-timing",
      context: AMBIENT_VOICE_TASK_CONTEXT,
      algorithmVersion: AMBIENT_VOICE_ALGORITHM_VERSION,
      qualityInputs: voiceQualityInputs,
      minimumEvidence: {
        eligibleDurationMs: 30_000,
        activeSpeechDurationMs: 15_000,
        eventCount: 5,
        minimumPauseMs: 200,
        maximumPauseMs: 1_999
      },
      validationStatus: "not-clinically-validated",
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.voice.speech_run_duration.median",
      label: "Median speech-run duration",
      unit: "seconds",
      modality: "voice",
      group: "speech-timing",
      context: AMBIENT_VOICE_TASK_CONTEXT,
      algorithmVersion: AMBIENT_VOICE_ALGORITHM_VERSION,
      qualityInputs: voiceQualityInputs,
      minimumEvidence: {
        eligibleDurationMs: 30_000,
        activeSpeechDurationMs: 15_000,
        eventCount: 5
      },
      validationStatus: "not-clinically-validated",
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.voice.acoustic_nucleus_rate",
      label: "Acoustic nucleus rate estimate",
      unit: "nuclei/active-speech-second",
      modality: "voice",
      group: "speech-timing",
      context: AMBIENT_VOICE_TASK_CONTEXT,
      algorithmVersion: AMBIENT_VOICE_ALGORITHM_VERSION,
      qualityInputs: voiceQualityInputs,
      minimumEvidence: {
        segmentCount: 3,
        eligibleDurationMs: 30_000,
        activeSpeechDurationMs: 15_000,
        eventCount: 30
      },
      validationStatus: "not-clinically-validated",
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    ...faceDefinitions()
  ] satisfies AmbientMetricDefinition[]);

function faceDefinitions(): AmbientMetricDefinition[] {
  const shared = {
    modality: "face" as const,
    context: AMBIENT_FACE_TASK_CONTEXT,
    algorithmVersion: AMBIENT_FACE_ALGORITHM_VERSION,
    qualityInputs: faceQualityInputs,
    validationStatus: "not-clinically-validated" as const,
    technicalVerification: "automated-test" as const,
    clinicalValidation: "none" as const,
    minimumEvidence: {
      calibrationDurationMs: 1_500,
      qualifyingBinCount: 3,
      evidenceSpanMs: 30_000,
      binDurationMs: 5_000,
      minimumBinDataDurationMs: 4_000,
      minimumSamplesPerBin: 80,
      minimumBinSpanMs: 4_800,
      maximumFrameGapMs: 200,
      maximumYawDegrees: 7,
      maximumPitchDegrees: 10,
      maximumRollDegrees: 5,
      maximumCalibrationSizeDelta: 0.2,
      maximumWithinBinSizeRatio: 1.15
    }
  };
  return [
    {
      ...shared,
      code: "ambient.face.eye_aperture.left",
      label: "Left open-eye aperture",
      unit: "eye-width-ratio",
      group: "eye-geometry"
    },
    {
      ...shared,
      code: "ambient.face.eye_aperture.right",
      label: "Right open-eye aperture",
      unit: "eye-width-ratio",
      group: "eye-geometry"
    },
    {
      ...shared,
      code: "ambient.face.eye_aperture.asymmetry",
      label: "Open-eye aperture asymmetry",
      unit: "eye-width-ratio",
      group: "symmetry"
    },
    {
      ...shared,
      code: "ambient.face.mouth_width",
      label: "Mouth width",
      unit: "inter-eye-normalized-distance",
      group: "mouth-geometry"
    },
    {
      ...shared,
      code: "ambient.face.mouth_aperture.median",
      label: "Median mouth aperture",
      unit: "mouth-width-ratio",
      group: "mouth-geometry"
    },
    {
      ...shared,
      code: "ambient.face.mouth_aperture.p90",
      label: "P90 mouth aperture",
      unit: "mouth-width-ratio",
      group: "mouth-geometry"
    },
    {
      ...shared,
      code: "ambient.face.mouth_corner_position.asymmetry",
      label: "Mouth-corner positional asymmetry",
      unit: "inter-eye-normalized-distance",
      group: "symmetry"
    },
    {
      ...shared,
      code: "ambient.face.landmark_speed.p90",
      label: "P90 regional landmark speed",
      unit: "inter-eye-distances/second",
      group: "movement"
    },
    {
      ...shared,
      code: "ambient.face.blink_rate.bilateral",
      label: "Bilateral blink rate",
      unit: "events/minute",
      group: "blink-behavior",
      minimumEvidence: {
        ...shared.minimumEvidence,
        frontalExposureMs: 60_000,
        minimumCadenceHz: 24,
        maximumP95GapMs: 75,
        closureFractionOfOpenReference: 0.6,
        recoveryFractionOfOpenReference: 0.8,
        minimumClosureMs: 50,
        maximumRecoveryMs: 800,
        refractoryMs: 150
      }
    },
    {
      ...shared,
      code: "ambient.face.rest_mouth_corner_asymmetry.signed",
      label: "Signed resting mouth-corner asymmetry",
      unit: "inter-eye-normalized-distance",
      group: "symmetry"
    },
    {
      ...shared,
      code: "ambient.face.rest_eye_aperture_asymmetry.signed",
      label: "Signed resting eye-aperture asymmetry",
      unit: "eye-width-ratio",
      group: "symmetry"
    },
    {
      ...shared,
      code: "ambient.face.spontaneous_event_rate",
      label: "Spontaneous expression rate",
      unit: "events/minute",
      group: "expression-dynamics"
    },
    {
      ...shared,
      code: "ambient.face.spontaneous_excursion.p90",
      label: "P90 spontaneous expression excursion",
      unit: "inter-eye-normalized-distance",
      group: "expression-dynamics",
      minimumEvidence: {
        ...shared.minimumEvidence,
        expressionEventCount: AMBIENT_EXPRESSION_MIN_EVENTS
      }
    },
    {
      ...shared,
      code: "ambient.face.spontaneous_excursion_asymmetry.median",
      label: "Median spontaneous excursion asymmetry",
      unit: "signed-excursion-ratio",
      group: "expression-dynamics",
      minimumEvidence: {
        ...shared.minimumEvidence,
        expressionEventCount: AMBIENT_EXPRESSION_MIN_EVENTS
      }
    },
    {
      ...shared,
      code: "ambient.face.oculo_oral_synkinesis_index",
      label: "Oculo-oral coupling difference",
      unit: "signed-coupling-ratio",
      group: "expression-dynamics",
      minimumEvidence: {
        ...shared.minimumEvidence,
        expressionEventCount: AMBIENT_EXPRESSION_MIN_EVENTS,
        coupledExpressionEventCount: AMBIENT_EXPRESSION_MIN_EVENTS
      }
    },
    {
      ...shared,
      code: "ambient.face.brow_height.left",
      label: "Left brow height",
      unit: "inter-eye-normalized-distance",
      group: "brow-geometry"
    },
    {
      ...shared,
      code: "ambient.face.brow_height.right",
      label: "Right brow height",
      unit: "inter-eye-normalized-distance",
      group: "brow-geometry"
    },
    {
      ...shared,
      code: "ambient.face.brow_height_asymmetry.signed",
      label: "Signed brow-height asymmetry",
      unit: "inter-eye-normalized-distance",
      group: "brow-geometry"
    },
    {
      ...shared,
      code: "ambient.face.lid_closure_completeness.left",
      label: "Left lid closure completeness",
      unit: "closure-ratio",
      group: "blink-behavior"
    },
    {
      ...shared,
      code: "ambient.face.lid_closure_completeness.right",
      label: "Right lid closure completeness",
      unit: "closure-ratio",
      group: "blink-behavior"
    }
  ];
}

const definitionByCode = new Map(
  AMBIENT_METRIC_REGISTRY.map((definition) => [
    definition.code,
    definition
  ])
);

export function ambientMetricDefinition(
  code: AmbientMetricCode
): AmbientMetricDefinition {
  const definition = definitionByCode.get(code);
  if (!definition) throw new Error(`Unknown ambient metric code: ${code}`);
  return definition;
}
