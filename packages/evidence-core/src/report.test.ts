import { describe, expect, it } from "vitest";
import {
  AMBIENT_LOCAL_PROTOCOL_PACK,
  AMBIENT_LOCAL_PROTOCOL_REF,
  createAggregateId,
  createMeasurementId,
  type MetricOutcomeV1,
  type ObservationV3
} from "@phenometrix/contracts";
import {
  ALGORITHM_PARAMETER_REQUIREMENT_KEYS,
  buildPostEncounterReport,
  evidenceFactFor,
  validateObservationProvenance
} from "./report.js";

function createObservation(): ObservationV3 {
  const windows = [
    {
      windowId: "voice-unavailable-window",
      sessionId: "session-report",
      modality: "voice" as const,
      context: "ambient-speech-turn" as const,
      trackSegmentId: "voice-track-1",
      processorRef: "voice-dsp@1.0.0",
      startMs: 0,
      endMs: 1,
      technicalQualityScore: 0,
      status: "withheld" as const,
      reasonCodes: ["modality-unavailable"]
    },
    {
      windowId: "face-unavailable-window",
      sessionId: "session-report",
      modality: "face" as const,
      context: "ambient-frontal" as const,
      trackSegmentId: "face-track-1",
      processorRef: "face-geometry@1.0.0",
      startMs: 0,
      endMs: 1,
      technicalQualityScore: 0,
      status: "withheld" as const,
      reasonCodes: ["modality-unavailable"]
    }
  ];
  const metricOutcomes: MetricOutcomeV1[] =
    AMBIENT_LOCAL_PROTOCOL_PACK.metrics.map((definition) => {
      const trackSegmentId =
        definition.modality === "voice" ? "voice-track-1" : "face-track-1";
      const windowId =
        definition.modality === "voice"
          ? "voice-unavailable-window"
          : "face-unavailable-window";
      const processorRef =
        definition.modality === "voice"
          ? "voice-dsp@1.0.0"
          : "face-geometry@1.0.0";
      const aggregateId = createAggregateId({
        protocolPackId: AMBIENT_LOCAL_PROTOCOL_REF.packId,
        protocolVersion: AMBIENT_LOCAL_PROTOCOL_REF.version,
        sessionId: "session-report",
        metricCode: definition.code,
        context: definition.context,
        unit: definition.unit,
        algorithmVersion: definition.algorithmVersion,
        processorRef,
        trackSegmentId
      });
      return {
        outcomeId: `outcome-${definition.code}`,
        aggregateId,
        metricCode: definition.code,
        label: definition.label,
        modality: definition.modality,
        context: definition.context,
        unit: definition.unit,
        reportSection: definition.reportSection,
        algorithmVersion: definition.algorithmVersion,
        processorRef,
        trackSegmentId,
        technicalVerification: "automated-test",
        clinicalValidation: "none",
        status: "withheld",
        reasonCode: "modality-unavailable",
        detail: "The modality was not available during this session.",
        technicalQualityScore: null,
        technicalDispersion: null,
        evidence: {
          eligibleDurationMs: 0,
          activeDurationMs: 0,
          segmentCount: 0,
          windowCount: 0,
          binCount: 0,
          eventCount: 0,
          sampleCount: 0,
          coverage: null,
          qualityFacts: {},
          refs: [
            {
              schemaVersion: "phenometric.evidence-ref.v1",
              kind: "window",
              sessionId: "session-report",
              observationId: "observation-report",
              protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
              windowId,
              modality: definition.modality,
              context: definition.context,
              trackSegmentId
            }
          ]
        }
      };
    });

  return {
    schemaVersion: "phenometric.encounter-observation.v3",
    containsPHI: false,
    retention: {
      rawMedia: false,
      rawAudio: false,
      rawVideo: false,
      transcript: false,
      embeddings: false,
      persisted: false
    },
    observationId: "observation-report",
    sessionId: "session-report",
    subjectRef: "subject-session-report",
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    consent: {
      schemaVersion: "phenometric.consent-record.v1",
      consentId: "consent-report",
      sessionId: "session-report",
      documentVersion: "ambient-local-consent.v1",
      documentSha256:
        AMBIENT_LOCAL_PROTOCOL_PACK.consentDocument.contentSha256,
      recordedAt: "2026-07-20T16:00:00.000Z",
      scopes: {
        cameraCapture: true,
        microphoneCapture: true,
        localInMemoryAnalysis: true
      },
      localParticipantAssertion: true,
      withdrawnAt: null
    },
    source: {
      role: "local-participant",
      sourceSessionRef: "session-report",
      audioAttribution: "user-asserted-local-participant",
      speakerAttribution: "unverified-local-input",
      audioInput: "microphone",
      faceAttribution: "single-visible-face",
      identityVerified: false
    },
    startedAt: "2026-07-20T16:00:00.000Z",
    endedAt: "2026-07-20T16:00:01.000Z",
    durationMs: 1_000,
    captureAdapter: { id: "browser", version: "1.0.0" },
    processors: [
      {
        modality: "voice",
        processorRef: "voice-dsp@1.0.0",
        runtime: "audio-worklet-worker",
        runtimeVersion: "1.0.0",
        assetPath: null,
        assetSha256: null,
        assetIntegrityVerified: true
      },
      {
        modality: "face",
        processorRef: "face-geometry@1.0.0",
        runtime: "mediapipe-tasks-vision",
        runtimeVersion: "0.10.35",
        assetPath: "assets/face_landmarker.task",
        assetSha256: "0".repeat(64),
        assetIntegrityVerified: true
      }
    ],
    windows,
    measurements: [],
    metricOutcomes,
    qualitySummary: {
      voice: {
        state: "unavailable",
        eligibleDurationMs: 0,
        technicalQualityScore: null,
        reasonCodes: ["modality-unavailable"]
      },
      face: {
        state: "unavailable",
        eligibleDurationMs: 0,
        technicalQualityScore: null,
        reasonCodes: ["modality-unavailable"]
      },
      totalWindowCount: 2,
      eligibleWindowCount: 0,
      withheldWindowCount: 2
    }
  };
}

function createQualifiedZeroPauseRateObservation(): ObservationV3 {
  const observation = createObservation();
  observation.endedAt = "2026-07-20T16:00:30.000Z";
  observation.durationMs = 30_000;
  observation.windows[0] = {
    ...observation.windows[0],
    endMs: 30_000,
    technicalQualityScore: 0.95,
    status: "eligible",
    reasonCodes: []
  };
  observation.qualitySummary.voice = {
    state: "ready",
    eligibleDurationMs: 30_000,
    technicalQualityScore: 0.95,
    reasonCodes: []
  };
  observation.qualitySummary.eligibleWindowCount = 1;
  observation.qualitySummary.withheldWindowCount = 1;

  const outcomeIndex = observation.metricOutcomes.findIndex(
    (outcome) => outcome.metricCode === "ambient.voice.pause_rate"
  );
  const withheld = observation.metricOutcomes[outcomeIndex];
  const identity = {
    protocolPackId: observation.protocolRef.packId,
    protocolVersion: observation.protocolRef.version,
    sessionId: observation.sessionId,
    metricCode: withheld.metricCode,
    context: withheld.context,
    unit: withheld.unit,
    algorithmVersion: withheld.algorithmVersion,
    processorRef: withheld.processorRef,
    trackSegmentId: withheld.trackSegmentId
  };
  const measurementId = createMeasurementId(
    identity,
    "voice-unavailable-window",
    0
  );
  observation.measurements.push({
    measurementId,
    aggregateId: withheld.aggregateId,
    sessionId: observation.sessionId,
    metricCode: withheld.metricCode,
    label: withheld.label,
    modality: withheld.modality,
    context: withheld.context,
    unit: withheld.unit,
    value: 0,
    technicalQualityScore: 0.95,
    algorithmVersion: withheld.algorithmVersion,
    processorRef: withheld.processorRef,
    trackSegmentId: withheld.trackSegmentId,
    ordinal: 0,
    sourceWindowRefs: ["voice-unavailable-window"]
  });
  observation.metricOutcomes[outcomeIndex] = {
    outcomeId: withheld.outcomeId,
    aggregateId: withheld.aggregateId,
    metricCode: withheld.metricCode,
    label: withheld.label,
    modality: withheld.modality,
    context: withheld.context,
    unit: withheld.unit,
    reportSection: withheld.reportSection,
    algorithmVersion: withheld.algorithmVersion,
    processorRef: withheld.processorRef,
    trackSegmentId: withheld.trackSegmentId,
    technicalVerification: "automated-test",
    clinicalValidation: "none",
    status: "measured",
    value: 0,
    technicalQualityScore: 0.95,
    technicalDispersion: 0,
    evidence: {
      eligibleDurationMs: 30_000,
      activeDurationMs: 15_000,
      segmentCount: 3,
      windowCount: 1,
      binCount: 0,
      eventCount: 0,
      sampleCount: 3_000,
      coverage: 0.9,
      qualityFacts: {
        timingCoverage: 0.9,
        activeSpeechDurationMs: 15_000,
        segmentCount: 3,
        // Named for the statistic, not the gate: these are the worst observed
        // per-segment values, which the pack's `minimum*` thresholds are then
        // checked against.
        segmentSpanMs: 2_000,
        activeSpeechPerSegmentMs: 1_000
      },
      refs: [
        {
          schemaVersion: "phenometric.evidence-ref.v1",
          kind: "measurement",
          sessionId: observation.sessionId,
          observationId: observation.observationId,
          protocolRef: observation.protocolRef,
          measurementId,
          metricCode: withheld.metricCode,
          modality: withheld.modality,
          context: withheld.context,
          unit: withheld.unit,
          trackSegmentId: withheld.trackSegmentId
        }
      ]
    }
  };
  return observation;
}

describe("post-encounter report", () => {
  it("projects all registered metrics exactly once without narrative", () => {
    const observation = createObservation();
    const report = buildPostEncounterReport(
      observation,
      AMBIENT_LOCAL_PROTOCOL_PACK,
      { generatedAt: "2026-07-20T16:00:02.000Z" }
    );
    const outcomes = report.sections.flatMap((section) => section.outcomes);

    expect(report.sections).toHaveLength(10);
    expect(outcomes).toHaveLength(27);
    expect(new Set(outcomes.map((outcome) => outcome.metricCode)).size).toBe(
      27
    );
    expect(outcomes.every((outcome) => outcome.status === "withheld")).toBe(
      true
    );
    expect(report).not.toHaveProperty("headline");
    expect(report).not.toHaveProperty("summary");
    expect(report.exportAvailable).toBe(false);
  });

  it("rejects evidence that only matches the metric code", () => {
    const observation = createObservation();
    const first = observation.metricOutcomes[0];
    const ref = first.evidence.refs[0];
    if (ref.kind !== "window") throw new Error("Expected window evidence.");
    ref.context = "ambient-frontal";

    const result = validateObservationProvenance(
      observation,
      AMBIENT_LOCAL_PROTOCOL_PACK
    );
    expect(result.status).toBe("fail");
    expect(result.errors.join(" ")).toMatch(/metadata|registry/);
  });

  it("rejects missing and duplicate terminal metric outcomes", () => {
    const observation = createObservation();
    observation.metricOutcomes.pop();
    expect(
      validateObservationProvenance(
        observation,
        AMBIENT_LOCAL_PROTOCOL_PACK
      ).status
    ).toBe("fail");

    const duplicated = createObservation();
    duplicated.metricOutcomes[1] = structuredClone(
      duplicated.metricOutcomes[0]
    );
    expect(
      validateObservationProvenance(
        duplicated,
        AMBIENT_LOCAL_PROTOCOL_PACK
      ).status
    ).toBe("fail");
  });

  it("accepts a qualified zero but rejects the same value without its denominator", () => {
    const qualified = createQualifiedZeroPauseRateObservation();
    expect(
      validateObservationProvenance(
        qualified,
        AMBIENT_LOCAL_PROTOCOL_PACK
      ).status
    ).toBe("pass");
    const report = buildPostEncounterReport(
      qualified,
      AMBIENT_LOCAL_PROTOCOL_PACK,
      { generatedAt: "2026-07-20T16:00:31.000Z" }
    );
    expect(
      report.sections
        .flatMap((section) => section.outcomes)
        .find((outcome) => outcome.metricCode === "ambient.voice.pause_rate")
    ).toMatchObject({ status: "measured", value: 0 });

    const insufficient = createQualifiedZeroPauseRateObservation();
    const pauseRate = insufficient.metricOutcomes.find(
      (outcome) => outcome.metricCode === "ambient.voice.pause_rate"
    );
    if (!pauseRate) throw new Error("Missing pause-rate outcome.");
    pauseRate.evidence.eligibleDurationMs = 29_999;
    const validation = validateObservationProvenance(
      insufficient,
      AMBIENT_LOCAL_PROTOCOL_PACK
    );
    expect(validation.status).toBe("fail");
    expect(validation.errors.join(" ")).toMatch(/minimumEligibleSpanMs/);
  });

  it("rejects a tampered pack even when its declared digest is unchanged", () => {
    const tampered = structuredClone(AMBIENT_LOCAL_PROTOCOL_PACK);
    tampered.metrics[0].evidenceRequirements.minimumSegments = 1;
    const result = validateObservationProvenance(
      createObservation(),
      tampered
    );
    expect(result.status).toBe("fail");
    expect(result.errors).toContain(
      "Supplied protocol pack is not the canonical active pack."
    );
  });
});

describe("pack requirement coverage", () => {
  /**
   * Every fact the adapter can emit, set to a value that satisfies any
   * threshold in either direction. The point is not whether a gate passes but
   * whether the requirement is *reachable* at all.
   */
  const ALL_FACTS: Record<string, number> = {
    eligibleDurationMs: 1,
    sampleCount: 1,
    segmentCount: 1,
    qualifyingBinCount: 1,
    activeSpeechDurationMs: 1,
    pitchedDurationMs: 1,
    pitchCoverage: 1,
    timingCoverage: 1,
    pauseCount: 1,
    speechRunCount: 1,
    nucleusCount: 1,
    frontalExposureMs: 1,
    blinkCount: 1,
    expressionEventCount: 1,
    coupledExpressionEventCount: 1,
    estimatorQuality: 1,
    estimatorAgreement: 1,
    segmentSpanMs: 1,
    activeSpeechPerSegmentMs: 1,
    validBinsPerSegment: 1,
    cadenceHz: 1,
    p95FrameGapMs: 1,
    maximumFrameGapMs: 1,
    dataPerBinMs: 1,
    samplesPerBin: 1,
    binSpanMs: 1
  };

  function fullyEvidencedOutcome(metricCode: string): MetricOutcomeV1 {
    return {
      status: "measured",
      value: 100,
      metricCode,
      evidence: {
        eligibleDurationMs: 1,
        activeDurationMs: 1,
        segmentCount: 1,
        windowCount: 1,
        binCount: 1,
        eventCount: 1,
        sampleCount: 1,
        coverage: 1,
        qualityFacts: ALL_FACTS,
        refs: []
      }
    } as unknown as MetricOutcomeV1;
  }

  it("resolves every requirement the pack declares", () => {
    const unreachable: string[] = [];
    for (const metric of AMBIENT_LOCAL_PROTOCOL_PACK.metrics) {
      for (const requirement of Object.keys(metric.evidenceRequirements)) {
        if (ALGORITHM_PARAMETER_REQUIREMENT_KEYS.has(requirement)) continue;
        const fact = evidenceFactFor(
          fullyEvidencedOutcome(metric.code),
          requirement
        );
        if (fact === undefined) {
          unreachable.push(`${metric.code}:${requirement}`);
        }
      }
    }
    // A requirement the pack publishes but the report cannot resolve is a gate
    // nothing enforces at this boundary. Since a missing fact now fails
    // provenance rather than passing silently, an unreachable requirement
    // would withhold every metric that declares it.
    expect(unreachable).toEqual([]);
  });

  it("declares every algorithm parameter that the pack actually uses", () => {
    const declared = new Set<string>();
    for (const metric of AMBIENT_LOCAL_PROTOCOL_PACK.metrics) {
      for (const requirement of Object.keys(metric.evidenceRequirements)) {
        declared.add(requirement);
      }
    }
    // Guards the other direction: an algorithm-parameter exemption left behind
    // after its requirement was removed would silently exempt a future
    // requirement that happened to reuse the name.
    const stale = [...ALGORITHM_PARAMETER_REQUIREMENT_KEYS].filter(
      (key) => !declared.has(key)
    );
    expect(stale).toEqual([]);
  });
});
