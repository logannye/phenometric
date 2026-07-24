import { describe, expect, it } from "vitest";
import {
  AMBIENT_LOCAL_PROTOCOL_PACK,
  type ConsentRecordV1,
  type MetricDefinition
} from "@phenometrix/contracts";
import {
  finalizeAmbientMetrics,
  type AmbientFacialFrame,
  type AmbientMetricOutcome,
  type AmbientVoiceFrame,
  type AmbientWithheldReasonCode
} from "@phenometrix/ambient-core";
import {
  buildPostEncounterReport,
  validateObservationProvenance
} from "@phenometrix/evidence-core";
import {
  buildAmbientObservation,
  contractReason,
  parseAmbientSourceWindowRef
} from "./ambient-core-adapter.js";

function consent(): ConsentRecordV1 {
  return {
    schemaVersion: "phenometric.consent-record.v1",
    consentId: "consent-session-adapter",
    sessionId: "session-adapter",
    documentVersion: "ambient-local-consent.v1",
    documentSha256: AMBIENT_LOCAL_PROTOCOL_PACK.consentDocument.contentSha256,
    recordedAt: "2026-07-20T17:00:00.000Z",
    scopes: {
      cameraCapture: true,
      microphoneCapture: true,
      localInMemoryAnalysis: true
    },
    localParticipantAssertion: true,
    withdrawnAt: null
  };
}

function definition(code: string): MetricDefinition {
  const value = AMBIENT_LOCAL_PROTOCOL_PACK.metrics.find(
    (candidate) => candidate.code === code
  );
  if (!value) throw new Error(`Missing test metric ${code}`);
  return value;
}

function emptyExtractionOutcome(code: string): AmbientMetricOutcome {
  const result = finalizeAmbientMetrics({
    identity: {
      sessionId: "session-adapter",
      protocolVersion: AMBIENT_LOCAL_PROTOCOL_PACK.version,
      protocolContentSha256: AMBIENT_LOCAL_PROTOCOL_PACK.contentSha256,
      sessionStartedAtMs: 0
    },
    voice: { frames: [], noiseCalibrationDurationMs: 2_000 },
    face: { frames: [], calibration: null }
  });
  const outcome = result.outcomes.find((candidate) => candidate.code === code);
  if (!outcome) throw new Error(`Missing extracted metric ${code}`);
  return outcome;
}

function outcomeWithReason(
  code: string,
  reasonCode: AmbientWithheldReasonCode
): AmbientMetricOutcome {
  const outcome = emptyExtractionOutcome(code);
  return {
    ...outcome,
    status: "withheld",
    reasonCode,
    detail: `Withheld for ${reasonCode}.`,
    technicalQualityScore: null,
    technicalDispersion: null
  };
}

function faceFrames(durationMs = 30_000, cadenceHz = 30): AmbientFacialFrame[] {
  const stepMs = 1_000 / cadenceHz;
  return Array.from(
    { length: Math.round(durationMs / stepMs) },
    (_, index) => {
      const tMs = index * stepMs;
      return {
        schemaVersion: "phenometric.facial-kinematics-frame.v1",
        tMs,
        acquiredAtMs: tMs,
        sequence: index + 1,
        captureEpoch: 1,
        taskContext: "ambient-frontal",
        faceCount: 1,
        trackSegmentId: "face:track:one",
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
        analyzedFrameRate: cadenceHz,
        interResultGapMs: index === 0 ? null : stepMs,
        skippedFrameFraction: 0,
        processingLatencyMs: 8,
        qualityReasons: [],
        processorRef: "mediapipe-face-landmarker@test"
      };
    }
  );
}

/**
 * Ambient speech where only part of each run is voiced. Real continuous speech
 * is roughly 40-70% periodic (unvoiced consonants, fricatives, stops), so
 * `periodic` must be allowed to diverge from `speechActive` — pinning them
 * equal hides any confusion between voicing coverage and timing coverage.
 */
function voiceFrames(
  voicedFraction: number,
  durationMs = 90_000,
  stepMs = 10
): AmbientVoiceFrame[] {
  return Array.from({ length: Math.floor(durationMs / stepMs) }, (_, index) => {
    const tMs = index * stepMs;
    const posInCycle = tMs % 2_500;
    const speechActive = posInCycle < 2_000;
    const periodic = speechActive && posInCycle < 2_000 * voicedFraction;
    return {
      schemaVersion: "phenometric.voice-signal-frame.v1",
      tMs,
      acquiredAtMs: tMs,
      captureEpoch: 1,
      sequence: index + 1,
      absoluteSampleIndex: Math.round(tMs * 48),
      taskContext: "ambient-speech-turn",
      speechActive,
      periodic,
      trackSegmentId: "local-microphone-1",
      rms: speechActive ? 0.08 : 0.0002,
      f0Hz: periodic ? 150 + Math.sin(tMs / 175) * 8 : null,
      f0Confidence: periodic ? 0.9 : 0,
      estimatorAgreement: periodic ? 0.9 : 0,
      syllabicNucleus: periodic && tMs % 500 === 0,
      clippedSampleFraction: 0,
      dcOffset: 0.001,
      snrDb: speechActive ? 26 : 0,
      sampleRateHz: 48_000,
      blockGapMs: stepMs,
      lostBlockFraction: 0,
      browserProcessing: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      qualityReasons: speechActive ? [] : ["signal-too-quiet"],
      processorRef: "browser-voice-dsp@1.0"
    };
  });
}

function voiceObservation(voicedFraction: number) {
  return buildAmbientObservation({
    sessionId: "session-adapter",
    subjectRef: "subject-session-adapter",
    consent: consent(),
    startedAt: "2026-07-20T17:00:00.000Z",
    endedAt: "2026-07-20T17:01:30.000Z",
    durationMs: 90_000,
    voiceFrames: voiceFrames(voicedFraction),
    faceFrames: [],
    noiseCalibrationDurationMs: 2_000,
    faceCalibration: null,
    voiceLaneAvailable: true,
    faceLaneAvailable: false,
    processors: []
  });
}

const TIMING_CODES = [
  "ambient.voice.speech_activity_fraction",
  "ambient.voice.pause_rate",
  "ambient.voice.pause_duration.median",
  "ambient.voice.speech_run_duration.median"
] as const;

describe("speech-timing evidence is gated on timing coverage, not voicing", () => {
  // Regression: `minimumTimingCoverage` (0.9) once resolved to `pitchCoverage`
  // (voiced fraction of active speech) because nothing emitted a
  // `timingCoverage` fact. Ordinary part-voiced speech then failed provenance
  // and the whole session was discarded — and only on the success path, since
  // evidence requirements are checked for measured outcomes only.
  it.each([1, 0.6, 0.4])(
    "builds a valid report when only %s of active speech is voiced",
    (voicedFraction) => {
      const observation = voiceObservation(voicedFraction);
      const timing = observation.metricOutcomes.filter((outcome) =>
        (TIMING_CODES as readonly string[]).includes(outcome.metricCode)
      );
      expect(timing).toHaveLength(TIMING_CODES.length);
      expect(timing.every((outcome) => outcome.status === "measured")).toBe(true);
      expect(
        validateObservationProvenance(observation, AMBIENT_LOCAL_PROTOCOL_PACK)
      ).toEqual({ status: "pass", errors: [] });
    }
  );

  it("reports timing coverage independently of pitch coverage", () => {
    const outcome = voiceObservation(0.6).metricOutcomes.find(
      (candidate) => candidate.metricCode === "ambient.voice.pause_rate"
    );
    expect(outcome?.evidence.qualityFacts.pitchCoverage).toBeCloseTo(0.6, 2);
    expect(
      outcome?.evidence.qualityFacts.timingCoverage
    ).toBeGreaterThanOrEqual(0.9);
  });
});

describe("expression evidence requirements resolve to emitted facts", () => {
  // Every published evidence requirement needs a fact behind it. When one has
  // none, `evidenceFactFor` returns undefined and the gate is silently
  // skipped — the same defect that let minimumTimingCoverage compare a timing
  // threshold against pitch coverage. Assert the facts exist at the source.
  it("emits the quality facts the expression requirements resolve from", () => {
    const observation = buildAmbientObservation({
      sessionId: "session-adapter",
      subjectRef: "subject-session-adapter",
      consent: consent(),
      startedAt: "2026-07-20T17:00:00.000Z",
      endedAt: "2026-07-20T17:00:30.000Z",
      durationMs: 30_000,
      voiceFrames: [],
      faceFrames: faceFrames(),
      noiseCalibrationDurationMs: 0,
      faceCalibration: {
        durationMs: 1_500,
        baselineBoxWidthPixels: 384,
        baselineBoxHeightPixels: 360
      },
      voiceLaneAvailable: false,
      faceLaneAvailable: true,
      processors: []
    });
    const rate = observation.metricOutcomes.find(
      (candidate) =>
        candidate.metricCode === "ambient.face.spontaneous_event_rate"
    );
    expect(rate?.evidence.qualityFacts.expressionEventCount).toBeDefined();
    expect(
      rate?.evidence.qualityFacts.coupledExpressionEventCount
    ).toBeDefined();
    // Provenance must still validate with the new requirements live.
    expect(
      validateObservationProvenance(observation, AMBIENT_LOCAL_PROTOCOL_PACK)
    ).toEqual({ status: "pass", errors: [] });
  });
});

describe("ambient observation adapter", () => {
  it("projects empty capture into 27 traceable withheld outcomes", () => {
    const observation = buildAmbientObservation({
      sessionId: "session-adapter",
      subjectRef: "subject-session-adapter",
      consent: consent(),
      startedAt: "2026-07-20T17:00:00.000Z",
      endedAt: "2026-07-20T17:00:01.000Z",
      durationMs: 1_000,
      voiceFrames: [],
      faceFrames: [],
      noiseCalibrationDurationMs: 0,
      faceCalibration: null,
      voiceLaneAvailable: false,
      faceLaneAvailable: false,
      processors: []
    });
    expect(observation.metricOutcomes).toHaveLength(27);
    expect(observation.metricOutcomes.every((outcome) => outcome.status === "withheld")).toBe(true);
    expect(
      validateObservationProvenance(
        observation,
        AMBIENT_LOCAL_PROTOCOL_PACK
      )
    ).toEqual({ status: "pass", errors: [] });

    const report = buildPostEncounterReport(
      observation,
      AMBIENT_LOCAL_PROTOCOL_PACK,
      { generatedAt: "2026-07-20T17:00:01.000Z" }
    );
    expect(report.sections.flatMap((section) => section.outcomes)).toHaveLength(27);
    expect(report.exportAvailable).toBe(false);
  });

  it("preserves current extractor reasons in outcomes and evidence windows", () => {
    const observation = buildAmbientObservation({
      sessionId: "session-adapter",
      subjectRef: "subject-session-adapter",
      consent: consent(),
      startedAt: "2026-07-20T17:00:00.000Z",
      endedAt: "2026-07-20T17:00:01.000Z",
      durationMs: 1_000,
      voiceFrames: [],
      faceFrames: [],
      noiseCalibrationDurationMs: 2_000,
      faceCalibration: null,
      voiceLaneAvailable: true,
      faceLaneAvailable: false,
      processors: []
    });
    const pitch = observation.metricOutcomes.find(
      (outcome) => outcome.metricCode === "ambient.voice.f0.median"
    );
    expect(pitch).toMatchObject({
      status: "withheld",
      reasonCode: "no-usable-signal"
    });
    const windowRef = pitch?.evidence.refs.find((ref) => ref.kind === "window");
    expect(windowRef?.kind).toBe("window");
    if (windowRef?.kind === "window") {
      expect(
        observation.windows.find((window) => window.windowId === windowRef.windowId)
          ?.reasonCodes
      ).toEqual(["no-usable-signal"]);
    }
  });

  it.each([
    ["ambient.voice.f0.median", "insufficient-pitched-speech"],
    ["ambient.voice.f0.variability", "insufficient-pitch-bins"],
    ["ambient.voice.pause_duration.median", "insufficient-events"],
    ["ambient.face.eye_aperture.left", "insufficient-bins"],
    ["ambient.face.eye_aperture.left", "multiple-faces"],
    ["ambient.face.blink_rate.bilateral", "insufficient-exposure"]
  ] as const)("preserves %s reason %s", (code, reasonCode) => {
    expect(
      contractReason(outcomeWithReason(code, reasonCode), definition(code), true)
    ).toBe(reasonCode);
  });

  it("fails closed when a reason is not registered for the metric", () => {
    expect(() =>
      contractReason(
        outcomeWithReason("ambient.voice.f0.median", "multiple-faces"),
        definition("ambient.voice.f0.median"),
        true
      )
    ).toThrow("is not registered");
  });

  it("projects each qualifying source bin onto its exact interval", () => {
    const observation = buildAmbientObservation({
      sessionId: "session-adapter",
      subjectRef: "subject-session-adapter",
      consent: consent(),
      startedAt: "2026-07-20T17:00:00.000Z",
      endedAt: "2026-07-20T17:00:30.000Z",
      durationMs: 30_000,
      voiceFrames: [],
      faceFrames: faceFrames(),
      noiseCalibrationDurationMs: 0,
      faceCalibration: {
        durationMs: 1_500,
        baselineBoxWidthPixels: 384,
        baselineBoxHeightPixels: 360
      },
      voiceLaneAvailable: false,
      faceLaneAvailable: true,
      processors: []
    });
    const outcome = observation.metricOutcomes.find(
      (candidate) => candidate.metricCode === "ambient.face.eye_aperture.left"
    );
    const windowIds = outcome?.evidence.refs.flatMap((ref) =>
      ref.kind === "window" ? [ref.windowId] : []
    ) ?? [];
    const intervals = windowIds.map((windowId) => {
      const window = observation.windows.find(
        (candidate) => candidate.windowId === windowId
      );
      return [window?.startMs, window?.endMs];
    });
    expect(intervals).toEqual([
      [0, 5_000],
      [5_000, 10_000],
      [10_000, 15_000],
      [15_000, 20_000],
      [20_000, 25_000],
      [25_000, 30_000]
    ]);
    expect(
      validateObservationProvenance(observation, AMBIENT_LOCAL_PROTOCOL_PACK)
    ).toEqual({ status: "pass", errors: [] });
  });

  it("parses track IDs containing colons and rejects invalid bounds", () => {
    expect(
      parseAmbientSourceWindowRef("face:2:track:with:colons:5000:10000", "face", 30_000)
    ).toEqual({
      modality: "face",
      captureEpoch: 2,
      trackSegmentId: "track:with:colons",
      startMs: 5_000,
      endMs: 10_000
    });
    expect(() =>
      parseAmbientSourceWindowRef("face:2:track:5000:31000", "face", 30_000)
    ).toThrow("Invalid ambient source window reference");
    expect(() =>
      parseAmbientSourceWindowRef("not-a-window", "face", 30_000)
    ).toThrow("Malformed ambient source window reference");
  });
});

describe("every published gate is verified on the success path", () => {
  // The requirement facts are only checked for MEASURED outcomes, so a missing
  // fact is invisible unless a test actually drives metrics to `measured`.
  // Eleven of the pack's requirements previously resolved to undefined and were
  // skipped in silence; they now fail provenance instead, which means this
  // dual-lane session is what proves the extractors emit them.
  function dualLaneObservation() {
    return buildAmbientObservation({
      sessionId: "session-adapter",
      subjectRef: "subject-session-adapter",
      consent: consent(),
      startedAt: "2026-07-20T17:00:00.000Z",
      endedAt: "2026-07-20T17:01:30.000Z",
      durationMs: 90_000,
      voiceFrames: voiceFrames(0.6),
      faceFrames: faceFrames(90_000),
      noiseCalibrationDurationMs: 2_000,
      faceCalibration: {
        durationMs: 1_500,
        baselineBoxWidthPixels: 384,
        baselineBoxHeightPixels: 360
      },
      voiceLaneAvailable: true,
      faceLaneAvailable: true,
      processors: []
    });
  }

  it("measures both lanes and still validates provenance", () => {
    const observation = dualLaneObservation();
    const measured = observation.metricOutcomes.filter(
      (outcome) => outcome.status === "measured"
    );
    // A static synthetic face produces no spontaneous expressions, so the three
    // event-gated expression metrics correctly abstain. Everything else must
    // measure, or this test is not exercising the path it claims to.
    expect(measured).toHaveLength(24);
    expect(
      validateObservationProvenance(observation, AMBIENT_LOCAL_PROTOCOL_PACK)
    ).toEqual({ status: "pass", errors: [] });
  });

  it("emits every worst-case gate fact the pack thresholds are checked against", () => {
    const observation = dualLaneObservation();
    const factsFor = (code: string) =>
      observation.metricOutcomes.find(
        (outcome) => outcome.metricCode === code
      )?.evidence.qualityFacts ?? {};

    // Face bin gates.
    const bin = factsFor("ambient.face.eye_aperture.left");
    expect(bin.dataPerBinMs).toBeDefined();
    expect(bin.samplesPerBin).toBeDefined();
    expect(bin.binSpanMs).toBeDefined();
    expect(bin.maximumFrameGapMs).toBeDefined();

    // Blink gates -- computed for the withhold decision since the blink work
    // landed, but never written onto the evidence until now.
    const blink = factsFor("ambient.face.blink_rate.bilateral");
    expect(blink.cadenceHz).toBeDefined();
    expect(blink.p95FrameGapMs).toBeDefined();

    // Voice estimator and per-segment gates.
    const pitch = factsFor("ambient.voice.f0.median");
    expect(pitch.estimatorQuality).toBeDefined();
    expect(pitch.estimatorAgreement).toBeDefined();
    const variability = factsFor("ambient.voice.f0.variability");
    expect(variability.validBinsPerSegment).toBeDefined();
    const timing = factsFor("ambient.voice.pause_rate");
    expect(timing.segmentSpanMs).toBeDefined();
    expect(timing.activeSpeechPerSegmentMs).toBeDefined();
  });

  it("counts only the events the metric is actually built from", () => {
    const observation = dualLaneObservation();
    const eventCountFor = (code: string) =>
      observation.metricOutcomes.find(
        (outcome) => outcome.metricCode === code
      )?.evidence.eventCount;

    // `eventCount` was a maximum over the pause, run, nucleus, and blink
    // counters, so a voice pause gate could be cleared by a syllable count and
    // -- once face events joined -- by a blink count. Each metric now reports
    // its own events, so these differ rather than collapsing to one number.
    const pauses = eventCountFor("ambient.voice.pause_rate");
    const nuclei = eventCountFor("ambient.voice.acoustic_nucleus_rate");
    const blinks = eventCountFor("ambient.face.blink_rate.bilateral");
    expect(pauses).toBeGreaterThan(0);
    expect(nuclei).toBeGreaterThan(0);
    expect(nuclei).not.toBe(pauses);
    expect(blinks).not.toBe(nuclei);
  });
});
