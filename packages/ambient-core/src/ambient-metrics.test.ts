import { describe, expect, it } from "vitest";
import { AMBIENT_LOCAL_PROTOCOL_PACK } from "@phenometric/contracts";
import { AMBIENT_METRIC_REGISTRY } from "./ambient-registry.js";
import { finalizeAmbientMetrics } from "./ambient-metrics.js";
import {
  AMBIENT_VOICE_ACTIVE_MIN_MS,
  AMBIENT_VOICE_ACTIVE_PER_SEGMENT_MIN_MS,
  AMBIENT_VOICE_MAX_F0_HZ,
  AMBIENT_VOICE_MAX_PAUSE_MS,
  AMBIENT_VOICE_MIN_ESTIMATOR_AGREEMENT,
  AMBIENT_VOICE_MIN_ESTIMATOR_QUALITY,
  AMBIENT_VOICE_MIN_F0_HZ,
  AMBIENT_VOICE_MIN_NUCLEUS_COUNT,
  AMBIENT_VOICE_MIN_PAUSE_MS,
  AMBIENT_VOICE_MIN_PAUSE_OR_RUN_COUNT,
  AMBIENT_VOICE_MIN_PITCH_COVERAGE,
  AMBIENT_VOICE_MIN_SEGMENT_COVERAGE,
  AMBIENT_VOICE_MIN_SEGMENTS,
  AMBIENT_VOICE_MIN_VALID_BINS_PER_SEGMENT,
  AMBIENT_VOICE_PITCH_BIN_MS,
  AMBIENT_VOICE_PITCH_MIN_MS,
  AMBIENT_VOICE_SEGMENT_MIN_MS,
  AMBIENT_VOICE_TIMING_MIN_MS
} from "./ambient-voice.js";
import {
  AMBIENT_BLINK_CLOSURE_FRACTION,
  AMBIENT_BLINK_MAX_P95_GAP_MS,
  AMBIENT_BLINK_MAX_RECOVERY_MS,
  AMBIENT_BLINK_MIN_CADENCE_HZ,
  AMBIENT_BLINK_MIN_CLOSURE_MS,
  AMBIENT_BLINK_MIN_EXPOSURE_MS,
  AMBIENT_BLINK_RECOVERY_FRACTION,
  AMBIENT_BLINK_REFRACTORY_MS,
  AMBIENT_FACE_BIN_MS,
  AMBIENT_FACE_MAX_FRAME_GAP_MS,
  AMBIENT_FACE_MIN_BIN_DATA_MS,
  AMBIENT_FACE_MIN_BIN_SPAN_MS,
  AMBIENT_FACE_MIN_BINS,
  AMBIENT_FACE_MIN_SAMPLES_PER_BIN,
  AMBIENT_FACE_MIN_SPAN_MS
} from "./ambient-face.js";

describe("finalizeAmbientMetrics", () => {
  it("returns every registered metric exactly once in registry order", () => {
    const result = finalizeAmbientMetrics({
      identity: {
        sessionId: "empty-ambient-session",
        protocolVersion: "1.0.0",
        protocolContentSha256: "empty-session-protocol",
        sessionStartedAtMs: 0
      },
      voice: { frames: [], noiseCalibrationDurationMs: 0 },
      face: { frames: [], calibration: null }
    });

    expect(result.outcomes.map((outcome) => outcome.code)).toEqual(
      AMBIENT_METRIC_REGISTRY.map((definition) => definition.code)
    );
    expect(new Set(result.outcomes.map((outcome) => outcome.code)).size).toBe(
      AMBIENT_METRIC_REGISTRY.length
    );
    expect(result.outcomes.every((outcome) => outcome.status === "withheld"))
      .toBe(true);
  });

  it("contains no guided, diagnostic, narrative, or deferred metric registrations", () => {
    const serialized = JSON.stringify(AMBIENT_METRIC_REGISTRY);

    expect(serialized).not.toMatch(
      /smile|eye.closure|vocal.fry|cpps|harmonics|jitter|shimmer|formant|ddk|diagnos|impair|normal.range|narrative/i
    );
  });

  it("deep-freezes the canonical registry", () => {
    expect(Object.isFrozen(AMBIENT_METRIC_REGISTRY)).toBe(true);
    expect(Object.isFrozen(AMBIENT_METRIC_REGISTRY[0])).toBe(true);
    expect(Object.isFrozen(AMBIENT_METRIC_REGISTRY[0].minimumEvidence)).toBe(
      true
    );
  });

  it("matches the contract protocol pack's public metric identity fields", () => {
    expect(
      AMBIENT_METRIC_REGISTRY.map((definition) => ({
        code: definition.code,
        label: definition.label,
        unit: definition.unit,
        modality: definition.modality,
        context: definition.context,
        reportSection: definition.group,
        algorithmVersion: definition.algorithmVersion,
        technicalVerification: definition.technicalVerification,
        clinicalValidation: definition.clinicalValidation
      }))
    ).toEqual(
      AMBIENT_LOCAL_PROTOCOL_PACK.metrics.map((definition) => ({
        code: definition.code,
        label: definition.label,
        unit: definition.unit,
        modality: definition.modality,
        context: definition.context,
        reportSection: definition.reportSection,
        algorithmVersion: definition.algorithmVersion,
        technicalVerification: definition.technicalVerification,
        clinicalValidation: definition.clinicalValidation
      }))
    );
  });

  /**
   * The contract pack publishes the evidence thresholds a reader is entitled
   * to assume; this package is what actually enforces them. Nothing else
   * compares the two, so a threshold could drift here and the pack would keep
   * advertising the old number — or, as happened with `minimumTimingCoverage`,
   * a published requirement could have no enforced counterpart at all and be
   * silently resolved from an unrelated statistic.
   */
  it("publishes exactly the evidence thresholds this package enforces", () => {
    const enforced: Record<string, number | Record<string, number>> = {
      // voice
      minimumSegments: AMBIENT_VOICE_MIN_SEGMENTS,
      minimumEligibleSpanMs: AMBIENT_VOICE_TIMING_MIN_MS,
      minimumActiveSpeechMs: AMBIENT_VOICE_ACTIVE_MIN_MS,
      minimumSegmentSpanMs: AMBIENT_VOICE_SEGMENT_MIN_MS,
      minimumActiveSpeechPerSegmentMs: AMBIENT_VOICE_ACTIVE_PER_SEGMENT_MIN_MS,
      minimumTimingCoverage: AMBIENT_VOICE_MIN_SEGMENT_COVERAGE,
      minimumPauseMs: AMBIENT_VOICE_MIN_PAUSE_MS,
      maximumPauseMs: AMBIENT_VOICE_MAX_PAUSE_MS,
      minimumEventsForMedian: AMBIENT_VOICE_MIN_PAUSE_OR_RUN_COUNT,
      minimumPitchedDurationMs: AMBIENT_VOICE_PITCH_MIN_MS,
      minimumPitchCoverage: AMBIENT_VOICE_MIN_PITCH_COVERAGE,
      minimumF0Hz: AMBIENT_VOICE_MIN_F0_HZ,
      maximumF0Hz: AMBIENT_VOICE_MAX_F0_HZ,
      minimumEstimatorQuality: AMBIENT_VOICE_MIN_ESTIMATOR_QUALITY,
      minimumEstimatorAgreement: AMBIENT_VOICE_MIN_ESTIMATOR_AGREEMENT,
      minimumValidBinsPerSegment: AMBIENT_VOICE_MIN_VALID_BINS_PER_SEGMENT,
      minimumNuclei: AMBIENT_VOICE_MIN_NUCLEUS_COUNT,
      // face
      minimumBins: AMBIENT_FACE_MIN_BINS,
      minimumObservationSpanMs: AMBIENT_FACE_MIN_SPAN_MS,
      minimumDataPerBinMs: AMBIENT_FACE_MIN_BIN_DATA_MS,
      minimumSamplesPerBin: AMBIENT_FACE_MIN_SAMPLES_PER_BIN,
      minimumBinSpanMs: AMBIENT_FACE_MIN_BIN_SPAN_MS,
      maximumFrameGapMs: AMBIENT_FACE_MAX_FRAME_GAP_MS,
      minimumExposureMs: AMBIENT_BLINK_MIN_EXPOSURE_MS,
      minimumCadenceHz: AMBIENT_BLINK_MIN_CADENCE_HZ,
      maximumP95FrameGapMs: AMBIENT_BLINK_MAX_P95_GAP_MS,
      minimumClosureMs: AMBIENT_BLINK_MIN_CLOSURE_MS,
      maximumRecoveryMs: AMBIENT_BLINK_MAX_RECOVERY_MS,
      refractoryMs: AMBIENT_BLINK_REFRACTORY_MS,
      closureFractionOfOpenReference: AMBIENT_BLINK_CLOSURE_FRACTION,
      recoveryFractionOfOpenReference: AMBIENT_BLINK_RECOVERY_FRACTION,
      // the analysis bin differs by modality
      binDurationMs: {
        voice: AMBIENT_VOICE_PITCH_BIN_MS,
        face: AMBIENT_FACE_BIN_MS
      }
    };

    const mismatches: string[] = [];
    const unmapped = new Set<string>();

    for (const metric of AMBIENT_LOCAL_PROTOCOL_PACK.metrics) {
      for (const [key, published] of Object.entries(
        metric.evidenceRequirements ?? {}
      )) {
        const entry = enforced[key];
        if (entry === undefined) {
          unmapped.add(key);
          continue;
        }
        const expected =
          typeof entry === "number" ? entry : entry[metric.modality];
        if (published !== expected) {
          mismatches.push(
            `${metric.code}.${key}: pack publishes ${published}, ` +
              `ambient-core enforces ${expected}`
          );
        }
      }
    }

    // An unmapped key means the pack advertises a requirement with no known
    // enforcement point — exactly the shape of the minimumTimingCoverage bug.
    expect([...unmapped]).toEqual([]);
    expect(mismatches).toEqual([]);
  });

  it("keeps terminal output free of raw signal and landmark arrays", () => {
    const result = finalizeAmbientMetrics({
      identity: {
        sessionId: "privacy-boundary-session",
        protocolVersion: "1.0.0",
        protocolContentSha256: "privacy-boundary-protocol",
        sessionStartedAtMs: 0
      },
      voice: { frames: [], noiseCalibrationDurationMs: 0 },
      face: { frames: [], calibration: null }
    });

    expect(JSON.stringify(result)).not.toMatch(
      /pcm|waveform|landmarks|mouthCorners|eyeAperture|imageBitmap|embedding|voiceprint/i
    );
  });
});
