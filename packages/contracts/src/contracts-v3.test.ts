import { describe, expect, it } from "vitest";
import {
  AMBIENT_LOCAL_CONSENT_TEXT,
  AMBIENT_LOCAL_PROTOCOL_PACK,
  AMBIENT_LOCAL_PROTOCOL_REF,
  calculateSha256Hex,
  createAggregateId,
  createMeasurementId,
  ObservationV3Schema,
  ProtocolPackV1Schema,
  verifyProtocolPackDigest
} from "./index.js";

describe("protocol pack v1", () => {
  it("is a complete immutable source of truth", () => {
    expect(
      ProtocolPackV1Schema.parse(AMBIENT_LOCAL_PROTOCOL_PACK).metrics
    ).toHaveLength(22);
    expect(Object.isFrozen(AMBIENT_LOCAL_PROTOCOL_PACK)).toBe(true);
    expect(Object.isFrozen(AMBIENT_LOCAL_PROTOCOL_PACK.metrics)).toBe(true);
    expect(
      new Set(
        AMBIENT_LOCAL_PROTOCOL_PACK.metrics.map((metric) => metric.code)
      ).size
    ).toBe(22);
  });

  it("binds the protocol and consent text to their SHA-256 digests", async () => {
    expect(await verifyProtocolPackDigest(AMBIENT_LOCAL_PROTOCOL_PACK)).toBe(
      true
    );
    expect(await calculateSha256Hex(AMBIENT_LOCAL_CONSENT_TEXT)).toBe(
      AMBIENT_LOCAL_PROTOCOL_PACK.consentDocument.contentSha256
    );
  });

  it("rejects duplicate metric registrations", () => {
    const invalid = structuredClone(AMBIENT_LOCAL_PROTOCOL_PACK);
    invalid.metrics[1] = invalid.metrics[0];
    expect(ProtocolPackV1Schema.safeParse(invalid).success).toBe(false);
  });
});

describe("observation v3", () => {
  const identity = {
    protocolPackId: AMBIENT_LOCAL_PROTOCOL_REF.packId,
    protocolVersion: AMBIENT_LOCAL_PROTOCOL_REF.version,
    sessionId: "session-1",
    metricCode: "ambient.voice.f0.median",
    context: "ambient-speech-turn",
    unit: "Hz",
    algorithmVersion: "1.0.0",
    processorRef: "voice-dsp@1.0.0",
    trackSegmentId: "voice-track-1"
  } as const;
  const aggregateId = createAggregateId(identity);
  const measurementId = createMeasurementId(identity, "window-1", 0);

  function observation() {
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
      observationId: "observation-1",
      sessionId: "session-1",
      subjectRef: "subject-session-1",
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      consent: {
        schemaVersion: "phenometric.consent-record.v1",
        consentId: "consent-1",
        sessionId: "session-1",
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
        sourceSessionRef: "session-1",
        audioAttribution: "user-asserted-local-participant",
        speakerAttribution: "unverified-local-input",
        audioInput: "microphone",
        faceAttribution: "single-visible-face",
        identityVerified: false
      },
      startedAt: "2026-07-20T16:00:00.000Z",
      endedAt: "2026-07-20T16:01:00.000Z",
      durationMs: 60_000,
      captureAdapter: { id: "browser", version: "1.0.0" },
      processors: [],
      windows: [
        {
          windowId: "window-1",
          sessionId: "session-1",
          modality: "voice",
          context: "ambient-speech-turn",
          trackSegmentId: "voice-track-1",
          processorRef: "voice-dsp@1.0.0",
          startMs: 0,
          endMs: 10_000,
          technicalQualityScore: 0.9,
          status: "eligible",
          reasonCodes: []
        }
      ],
      measurements: [
        {
          measurementId,
          aggregateId,
          sessionId: "session-1",
          metricCode: "ambient.voice.f0.median",
          label: "Median fundamental frequency",
          modality: "voice",
          context: "ambient-speech-turn",
          unit: "Hz",
          value: 121,
          technicalQualityScore: 0.9,
          algorithmVersion: "1.0.0",
          processorRef: "voice-dsp@1.0.0",
          trackSegmentId: "voice-track-1",
          ordinal: 0,
          sourceWindowRefs: ["window-1"]
        }
      ],
      metricOutcomes: [
        {
          outcomeId: "outcome-f0",
          aggregateId,
          metricCode: "ambient.voice.f0.median",
          label: "Median fundamental frequency",
          modality: "voice",
          context: "ambient-speech-turn",
          unit: "Hz",
          reportSection: "pitch",
          algorithmVersion: "1.0.0",
          processorRef: "voice-dsp@1.0.0",
          trackSegmentId: "voice-track-1",
          technicalVerification: "automated-test",
          clinicalValidation: "none",
          status: "measured",
          value: 121,
          technicalQualityScore: 0.9,
          technicalDispersion: 2.1,
          evidence: {
            eligibleDurationMs: 10_000,
            activeDurationMs: 10_000,
            segmentCount: 3,
            windowCount: 1,
            binCount: 0,
            eventCount: 0,
            sampleCount: 100,
            coverage: 0.8,
            qualityFacts: {
              pitchCoverage: 0.8,
              estimatorQuality: 0.9,
              estimatorAgreement: 0.9
            },
            refs: [
              {
                schemaVersion: "phenometric.evidence-ref.v1",
                kind: "measurement",
                sessionId: "session-1",
                observationId: "observation-1",
                protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
                measurementId,
                metricCode: "ambient.voice.f0.median",
                modality: "voice",
                context: "ambient-speech-turn",
                unit: "Hz",
                trackSegmentId: "voice-track-1"
              }
            ]
          }
        }
      ],
      qualitySummary: {
        voice: {
          state: "ready",
          eligibleDurationMs: 10_000,
          technicalQualityScore: 0.9,
          reasonCodes: []
        },
        face: {
          state: "unavailable",
          eligibleDurationMs: 0,
          technicalQualityScore: null,
          reasonCodes: ["modality-unavailable"]
        },
        totalWindowCount: 1,
        eligibleWindowCount: 1,
        withheldWindowCount: 0
      }
    };
  }

  it("accepts finite, session-bound observations", () => {
    expect(ObservationV3Schema.safeParse(observation()).success).toBe(true);
  });

  it("rejects legacy and nonfinite observations", () => {
    expect(
      ObservationV3Schema.safeParse({
        schemaVersion: "phenometric.encounter-observation.v2"
      }).success
    ).toBe(false);
    const invalid = observation();
    invalid.metricOutcomes[0].value = Number.NaN;
    expect(ObservationV3Schema.safeParse(invalid).success).toBe(false);
  });

  it("produces stable context-sensitive identities", () => {
    expect(createAggregateId(identity)).toBe(aggregateId);
    expect(
      createAggregateId({ ...identity, context: "ambient-frontal" })
    ).not.toBe(aggregateId);
    expect(createMeasurementId(identity, "window-1", 1)).not.toBe(
      measurementId
    );
  });
});
