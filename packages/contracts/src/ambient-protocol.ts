import type { ProtocolPackV1 } from "./protocol.js";
import {
  ProtocolPackV1Schema,
  protocolRefFor
} from "./protocol.js";

export const AMBIENT_LOCAL_CONSENT_TEXT =
  "PhenoMetrix processes camera and microphone signals locally in this browser and keeps derived results only in memory for this session. It does not upload or retain recordings, verify identity, diagnose a condition, or provide clinical interpretation. I confirm that I am the intended local participant and will use headphones when other voices may be audible.";

const COMMON_WITHHELD_REASONS = [
  "modality-unavailable",
  "processor-unavailable",
  "asset-integrity-failed",
  "quality-threshold-failed",
  "insufficient-duration",
  "session-ended-early"
] as const;

const VOICE_WITHHELD_REASONS = [
  ...COMMON_WITHHELD_REASONS,
  "no-usable-signal",
  "insufficient-segments",
  "insufficient-active-speech"
] as const;

const FACE_WITHHELD_REASONS = [
  ...COMMON_WITHHELD_REASONS,
  "no-usable-signal",
  "multiple-faces",
  "insufficient-bins",
  "pose-out-of-range",
  "face-scale-out-of-range"
] as const;

const rawProtocolPack = {
  schemaVersion: "phenometric.protocol-pack.v1",
  packId: "ambient-local-observation",
  // 3.1.0: renamed to PhenoMetrix. No metric, threshold, or algorithm changed,
  // but the consent text a participant reads carries the product name, so the
  // consent digest moves and the pack version has to move with it. Sessions
  // measured under 3.0.0 remain comparable on every measurement; what differs
  // is the exact wording that was agreed to.
  // 3.0.0: brow geometry and per-eye closure added (5 face metrics).
  // Sessions measured under different packs are not comparable, and the
  // content digest below makes that structurally visible rather than implicit.
  version: "3.1.0",
  // SHA-256 of the canonical pack content with this field omitted.
  contentSha256:
    "5d3ccce909f84b5a1f37e47f8d7e0b08f8cbcf6fea5cd2de09c3cf31261335a8",
  status: "nonclinical-prototype",
  maximumSessionDurationMs: 300_000,
  supportedTarget: {
    browser: "chrome",
    versions: "current-and-previous-stable",
    operatingSystem: "macos",
    requiresHttps: true
  },
  modalities: ["voice", "face"],
  sourcePolicy: {
    role: "local-participant",
    audioAttribution: "user-asserted-local-participant",
    speakerAttribution: "unverified-local-input",
    faceAttribution: "single-visible-face",
    performsIdentityVerification: false
  },
  consentDocument: {
    version: "ambient-local-consent.v1",
    contentSha256:
      "1003d8867bac07a86cf485f13a2b1d3afb120d67a01b47a1876050150634eba0"
  },
  qualityPolicy: {
    id: "ambient-local-quality.v1",
    maximumSessionDurationMs: 300_000,
    setupTimeoutMs: 15_000,
    audio: {
      quietCalibrationMs: 2_000,
      minimumSampleRateHz: 44_100,
      maximumFrameGapMs: 40,
      maximumLostBlockFraction: 0.05,
      maximumClippingFraction: 0.01,
      maximumAbsoluteDcOffset: 0.02,
      minimumSpeechSnrDb: 15,
      maximumRawAudioBufferMs: 2_000
    },
    face: {
      minimumCalibrationDurationMs: 1_500,
      minimumCalibrationUsableFraction: 0.8,
      binDurationMs: 5_000,
      minimumDataPerBinMs: 4_000,
      minimumSamplesPerBin: 80,
      minimumBinSpanMs: 4_800,
      maximumFrameGapMs: 200,
      maximumAbsoluteYawDegrees: 7,
      maximumAbsolutePitchDegrees: 10,
      maximumAbsoluteRollDegrees: 5,
      maximumCalibrationScaleDeviation: 0.2,
      maximumWithinBinScaleRatio: 1.15,
      minimumBins: 3,
      minimumObservationSpanMs: 30_000,
      maximumDetectedFaces: 2,
      requiredFaceCount: 1
    },
    blink: {
      minimumExposureMs: 60_000,
      minimumCadenceHz: 24,
      maximumP95FrameGapMs: 75,
      closureFractionOfOpenReference: 0.6,
      minimumClosureMs: 50,
      recoveryFractionOfOpenReference: 0.8,
      maximumRecoveryMs: 800,
      refractoryMs: 150
    }
  },
  reportSections: [
    "capture-quality",
    "pitch",
    "speech-timing",
    "eye-geometry",
    "mouth-geometry",
    "symmetry",
    "expression-dynamics",
    "brow-geometry",
    "movement",
    "blink-behavior"
  ],
  metrics: [
    {
      code: "ambient.voice.f0.median",
      label: "Median fundamental frequency",
      modality: "voice",
      context: "ambient-speech-turn",
      unit: "Hz",
      reportSection: "pitch",
      reportOrder: 0,
      algorithmId: "ambient-f0",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumSegments: 3,
        minimumPitchedDurationMs: 10_000,
        minimumPitchCoverage: 0.6,
        minimumF0Hz: 50,
        maximumF0Hz: 700,
        minimumEstimatorQuality: 0.55,
        minimumEstimatorAgreement: 0.7
      },
      qualityInputs: ["pitchCoverage", "estimatorQuality", "estimatorAgreement"],
      withheldReasonCodes: [
        ...VOICE_WITHHELD_REASONS,
        "insufficient-pitched-speech",
        "pitch-estimator-disagreement"
      ],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.voice.f0.variability",
      label: "Fundamental-frequency variability",
      modality: "voice",
      context: "ambient-speech-turn",
      unit: "semitone-SD",
      reportSection: "pitch",
      reportOrder: 1,
      algorithmId: "ambient-f0-variability",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumSegments: 3,
        minimumPitchedDurationMs: 10_000,
        minimumValidBinsPerSegment: 4,
        binDurationMs: 500,
        minimumPitchCoverage: 0.6
      },
      qualityInputs: ["pitchCoverage", "validPitchBins", "segmentCount"],
      withheldReasonCodes: [
        ...VOICE_WITHHELD_REASONS,
        "insufficient-pitched-speech",
        "insufficient-pitch-bins"
      ],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    ...[
      [
        "ambient.voice.speech_activity_fraction",
        "Speech-activity fraction",
        "ratio",
        0,
        "ambient-speech-activity"
      ],
      [
        "ambient.voice.pause_rate",
        "Pause rate",
        "pauses/minute",
        1,
        "ambient-pause-rate"
      ],
      [
        "ambient.voice.pause_duration.median",
        "Median pause duration",
        "seconds",
        2,
        "ambient-pause-duration"
      ],
      [
        "ambient.voice.speech_run_duration.median",
        "Median speech-run duration",
        "seconds",
        3,
        "ambient-speech-run-duration"
      ]
    ].map(([code, label, unit, reportOrder, algorithmId]) => ({
      code,
      label,
      modality: "voice",
      context: "ambient-speech-turn",
      unit,
      reportSection: "speech-timing",
      reportOrder,
      algorithmId,
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumSegments: 3,
        minimumEligibleSpanMs: 30_000,
        minimumActiveSpeechMs: 15_000,
        minimumSegmentSpanMs: 2_000,
        minimumActiveSpeechPerSegmentMs: 1_000,
        minimumTimingCoverage: 0.9,
        minimumPauseMs: 200,
        maximumPauseMs: 1_999,
        ...(code === "ambient.voice.pause_duration.median" ||
        code === "ambient.voice.speech_run_duration.median"
          ? { minimumEventsForMedian: 5 }
          : {})
      },
      qualityInputs: ["timingCoverage", "activeSpeechDurationMs", "segmentCount"],
      withheldReasonCodes: [
        ...VOICE_WITHHELD_REASONS,
        "insufficient-active-speech",
        "insufficient-segments",
        "insufficient-events"
      ],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    })),
    {
      code: "ambient.voice.acoustic_nucleus_rate",
      label: "Acoustic nucleus rate estimate",
      modality: "voice",
      context: "ambient-speech-turn",
      unit: "nuclei/active-speech-second",
      reportSection: "speech-timing",
      reportOrder: 4,
      algorithmId: "ambient-acoustic-nuclei",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumSegments: 3,
        minimumEligibleSpanMs: 30_000,
        minimumActiveSpeechMs: 15_000,
        minimumNuclei: 30
      },
      qualityInputs: ["activeSpeechDurationMs", "nucleusCount", "segmentCount"],
      withheldReasonCodes: [
        ...VOICE_WITHHELD_REASONS,
        "insufficient-active-speech",
        "insufficient-nuclei"
      ],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    ...[
      [
        "ambient.face.eye_aperture.left",
        "Left open-eye aperture",
        "eye-width-ratio",
        "eye-geometry",
        0,
        "ambient-eye-aperture"
      ],
      [
        "ambient.face.eye_aperture.right",
        "Right open-eye aperture",
        "eye-width-ratio",
        "eye-geometry",
        1,
        "ambient-eye-aperture"
      ],
      [
        "ambient.face.eye_aperture.asymmetry",
        "Open-eye aperture asymmetry",
        "eye-width-ratio",
        "symmetry",
        0,
        "ambient-eye-asymmetry"
      ],
      [
        "ambient.face.mouth_width",
        "Mouth width",
        "inter-eye-normalized-distance",
        "mouth-geometry",
        0,
        "ambient-mouth-width"
      ],
      [
        "ambient.face.mouth_aperture.median",
        "Median mouth aperture",
        "mouth-width-ratio",
        "mouth-geometry",
        1,
        "ambient-mouth-aperture"
      ],
      [
        "ambient.face.mouth_aperture.p90",
        "P90 mouth aperture",
        "mouth-width-ratio",
        "mouth-geometry",
        2,
        "ambient-mouth-aperture"
      ],
      [
        "ambient.face.mouth_corner_position.asymmetry",
        "Mouth-corner positional asymmetry",
        "inter-eye-normalized-distance",
        "symmetry",
        1,
        "ambient-mouth-corner-asymmetry"
      ],
      [
        "ambient.face.landmark_speed.p90",
        "P90 regional landmark speed",
        "inter-eye-distances/second",
        "movement",
        0,
        "ambient-landmark-speed"
      ]
    ].map(([code, label, unit, reportSection, reportOrder, algorithmId]) => ({
      code,
      label,
      modality: "face",
      context: "ambient-frontal",
      unit,
      reportSection,
      reportOrder,
      algorithmId,
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        binDurationMs: 5_000,
        minimumDataPerBinMs: 4_000,
        minimumSamplesPerBin: 80,
        minimumBinSpanMs: 4_800,
        maximumFrameGapMs: 200,
        minimumBins: 3,
        minimumObservationSpanMs: 30_000
      },
      qualityInputs: ["usableBins", "usableDurationMs", "poseCoverage", "scaleStability"],
      withheldReasonCodes: [
        ...FACE_WITHHELD_REASONS
      ],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    })),
    {
      code: "ambient.face.blink_rate.bilateral",
      label: "Bilateral blink rate",
      modality: "face",
      context: "ambient-frontal",
      unit: "events/minute",
      reportSection: "blink-behavior",
      reportOrder: 0,
      algorithmId: "ambient-bilateral-blink",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumExposureMs: 60_000,
        minimumCadenceHz: 24,
        maximumP95FrameGapMs: 75,
        closureFractionOfOpenReference: 0.6,
        minimumClosureMs: 50,
        recoveryFractionOfOpenReference: 0.8,
        maximumRecoveryMs: 800,
        refractoryMs: 150
      },
      qualityInputs: ["eligibleExposureMs", "cadenceHz", "p95FrameGapMs"],
      withheldReasonCodes: [
        ...FACE_WITHHELD_REASONS,
        "insufficient-exposure",
        "insufficient-frame-cadence"
      ],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    // Signed resting geometry. The existing *.asymmetry metrics report
    // magnitude only, which cannot distinguish a corner that has drooped from
    // one that has over-corrected into contracture. Sign carries that.
    {
      code: "ambient.face.rest_mouth_corner_asymmetry.signed",
      label: "Signed resting mouth-corner asymmetry",
      modality: "face",
      context: "ambient-frontal",
      unit: "inter-eye-normalized-distance",
      reportSection: "symmetry",
      reportOrder: 2,
      algorithmId: "ambient-rest-mouth-corner-signed",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000
      },
      qualityInputs: ["usableBins", "usableDurationMs", "poseCoverage"],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.face.rest_eye_aperture_asymmetry.signed",
      label: "Signed resting eye-aperture asymmetry",
      modality: "face",
      context: "ambient-frontal",
      unit: "eye-width-ratio",
      reportSection: "symmetry",
      reportOrder: 3,
      algorithmId: "ambient-rest-eye-aperture-signed",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000
      },
      qualityInputs: ["usableBins", "usableDurationMs", "poseCoverage"],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    // Spontaneous expression dynamics. Detected in ordinary conversation and
    // never prompted: volitional and spontaneous facial movement travel
    // different neural pathways, and asking for a smile makes it volitional.
    {
      code: "ambient.face.spontaneous_event_rate",
      label: "Spontaneous expression rate",
      modality: "face",
      context: "ambient-frontal",
      unit: "events/minute",
      reportSection: "expression-dynamics",
      reportOrder: 0,
      algorithmId: "ambient-spontaneous-expression",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000
      },
      qualityInputs: ["usableBins", "usableDurationMs", "expressionEventCount"],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.face.spontaneous_excursion.p90",
      label: "P90 spontaneous expression excursion",
      modality: "face",
      context: "ambient-frontal",
      unit: "inter-eye-normalized-distance",
      reportSection: "expression-dynamics",
      reportOrder: 1,
      algorithmId: "ambient-spontaneous-expression",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000,
        minimumExpressionEvents: 3
      },
      qualityInputs: ["usableBins", "usableDurationMs", "expressionEventCount"],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS, "insufficient-events"],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.face.spontaneous_excursion_asymmetry.median",
      label: "Median spontaneous excursion asymmetry",
      modality: "face",
      context: "ambient-frontal",
      unit: "signed-excursion-ratio",
      reportSection: "expression-dynamics",
      reportOrder: 2,
      algorithmId: "ambient-spontaneous-expression",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000,
        minimumExpressionEvents: 3
      },
      qualityInputs: ["usableBins", "usableDurationMs", "expressionEventCount"],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS, "insufficient-events"],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    {
      code: "ambient.face.oculo_oral_synkinesis_index",
      label: "Oculo-oral coupling difference",
      modality: "face",
      context: "ambient-frontal",
      unit: "signed-coupling-ratio",
      reportSection: "expression-dynamics",
      reportOrder: 3,
      algorithmId: "ambient-oculo-oral-coupling",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000,
        minimumExpressionEvents: 3,
        minimumCoupledExpressionEvents: 3,
        minimumCouplingElevation: 0.02
      },
      qualityInputs: [
        "usableBins",
        "usableDurationMs",
        "expressionEventCount",
        "coupledExpressionEventCount"
      ],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS, "insufficient-events"],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    },
    // Frontalis. Forehead sparing is what separates upper- from
    // lower-motor-neuron facial weakness, so the brow is graded as its own
    // zone rather than folded into eye geometry.
    ...[
      ["ambient.face.brow_height.left", "Left brow height", 0],
      ["ambient.face.brow_height.right", "Right brow height", 1],
      ["ambient.face.brow_height_asymmetry.signed", "Signed brow-height asymmetry", 2]
    ].map(([code, label, reportOrder]) => ({
      code,
      label,
      modality: "face",
      context: "ambient-frontal",
      unit: "inter-eye-normalized-distance",
      reportSection: "brow-geometry",
      reportOrder,
      algorithmId: "ambient-brow-geometry",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000
      },
      qualityInputs: ["usableBins", "usableDurationMs", "poseCoverage"],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    })),
    // Unilateral lagophthalmos is the corneal risk, and a bilateral blink
    // detector renders it as a global rate collapse. Closure is graded per eye.
    ...[
      ["ambient.face.lid_closure_completeness.left", "Left lid closure completeness", 1],
      ["ambient.face.lid_closure_completeness.right", "Right lid closure completeness", 2]
    ].map(([code, label, reportOrder]) => ({
      code,
      label,
      modality: "face",
      context: "ambient-frontal",
      unit: "closure-ratio",
      reportSection: "blink-behavior",
      reportOrder,
      algorithmId: "ambient-lid-closure-completeness",
      algorithmVersion: "1.0.0",
      evidenceRequirements: {
        minimumBins: 3,
        minimumObservationSpanMs: 30_000
      },
      qualityInputs: ["usableBins", "usableDurationMs", "poseCoverage"],
      withheldReasonCodes: [...FACE_WITHHELD_REASONS],
      technicalVerification: "automated-test",
      clinicalValidation: "none"
    }))
  ]
} as const;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function protocolPackDigestInput(pack: ProtocolPackV1): string {
  const { contentSha256: _contentSha256, ...content } = pack;
  return canonicalize(content);
}

export async function calculateSha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyProtocolPackDigest(
  pack: ProtocolPackV1
): Promise<boolean> {
  return (
    (await calculateSha256Hex(protocolPackDigestInput(pack))) ===
    pack.contentSha256
  );
}

export const AMBIENT_LOCAL_PROTOCOL_PACK = deepFreeze(
  ProtocolPackV1Schema.parse(rawProtocolPack)
);

export const AMBIENT_LOCAL_PROTOCOL_REF = deepFreeze(
  protocolRefFor(AMBIENT_LOCAL_PROTOCOL_PACK)
);
