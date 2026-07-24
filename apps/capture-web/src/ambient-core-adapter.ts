import {
  finalizeAmbientMetrics,
  type AmbientFaceCalibration,
  type AmbientFacialFrame,
  type AmbientMetricEvidence,
  type AmbientMetricOutcome,
  type AmbientVoiceFrame
} from "@phenometric/ambient-core";
import {
  AMBIENT_LOCAL_PROTOCOL_PACK,
  AMBIENT_LOCAL_PROTOCOL_REF,
  ObservationV3Schema,
  WithheldReasonCodeSchema,
  createAggregateId,
  createMeasurementId,
  type ConsentRecordV1,
  type EvidenceRef,
  type EvidenceWindowV1,
  type MetricCode,
  type MetricDefinition,
  type MetricOutcomeV1,
  type ObservationV3,
  type ProcessorProvenanceV1,
  type WithheldReasonCode
} from "@phenometric/contracts";

export interface AmbientObservationBuildInput {
  sessionId: string;
  subjectRef: string;
  consent: ConsentRecordV1;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  voiceFrames: readonly AmbientVoiceFrame[];
  faceFrames: readonly AmbientFacialFrame[];
  noiseCalibrationDurationMs: number;
  faceCalibration: AmbientFaceCalibration | null;
  voiceLaneAvailable: boolean;
  faceLaneAvailable: boolean;
  processors: readonly ProcessorProvenanceV1[];
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 150);
}

export interface ParsedAmbientSourceWindowRef {
  modality: "voice" | "face";
  captureEpoch: number;
  trackSegmentId: string;
  startMs: number;
  endMs: number;
}

export function parseAmbientSourceWindowRef(
  sourceRef: string,
  expectedModality: "voice" | "face",
  observationDurationMs: number
): ParsedAmbientSourceWindowRef {
  const parts = sourceRef.split(":");
  if (parts.length < 5) {
    throw new Error(`Malformed ambient source window reference: ${sourceRef}`);
  }
  const modality = parts[0];
  const captureEpoch = Number(parts[1]);
  const trackSegmentId = parts.slice(2, -2).join(":");
  const startMs = Number(parts.at(-2));
  const endMs = Number(parts.at(-1));
  if (
    (modality !== "voice" && modality !== "face") ||
    modality !== expectedModality ||
    !Number.isInteger(captureEpoch) ||
    captureEpoch < 0 ||
    trackSegmentId.length === 0 ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs > observationDurationMs
  ) {
    throw new Error(`Invalid ambient source window reference: ${sourceRef}`);
  }
  return {
    modality,
    captureEpoch,
    trackSegmentId,
    startMs,
    endMs
  };
}

function metricDefinition(code: string): MetricDefinition {
  const definition = AMBIENT_LOCAL_PROTOCOL_PACK.metrics.find(
    (candidate) => candidate.code === code
  );
  if (!definition) throw new Error(`Unregistered ambient metric: ${code}`);
  return definition;
}

function primaryProcessor(
  outcome: AmbientMetricOutcome,
  processors: readonly ProcessorProvenanceV1[]
): string {
  if (outcome.evidence.processorRefs.length === 1) {
    return outcome.evidence.processorRefs[0];
  }
  if (outcome.evidence.processorRefs.length > 1) {
    return `${outcome.modality}-mixed-provenance`;
  }
  return processors.find((processor) => processor.modality === outcome.modality)
    ?.processorRef ?? `${outcome.modality}-processor-unavailable`;
}

function primaryTrack(outcome: AmbientMetricOutcome): string {
  if (outcome.evidence.trackSegmentIds.length === 1) {
    return outcome.evidence.trackSegmentIds[0];
  }
  return outcome.evidence.trackSegmentIds.length > 1
    ? `${outcome.modality}-mixed-provenance`
    : `${outcome.modality}-track-unavailable`;
}

/**
 * The events this particular metric is built from.
 *
 * This was previously `Math.max` over the pause, speech-run, nucleus, and
 * blink counters, which conflated four unrelated counts into one number: a
 * voice pause gate could be satisfied by a syllable count, and once face
 * events joined the same maximum a facial count could satisfy a voice gate.
 * Counting only the metric's own events keeps the number honest and keeps
 * each gate answerable by its own evidence.
 */
function relevantEventCount(
  code: MetricCode,
  evidence: AmbientMetricEvidence
): number {
  switch (code) {
    case "ambient.voice.pause_rate":
    case "ambient.voice.pause_duration.median":
      return evidence.pauseCount ?? 0;
    case "ambient.voice.speech_run_duration.median":
      return evidence.speechRunCount ?? 0;
    case "ambient.voice.acoustic_nucleus_rate":
      return evidence.nucleusCount ?? 0;
    case "ambient.face.blink_rate.bilateral":
      return evidence.blinkCount ?? 0;
    case "ambient.face.spontaneous_event_rate":
    case "ambient.face.spontaneous_excursion.p90":
    case "ambient.face.spontaneous_excursion_asymmetry.median":
      return evidence.expressionEventCount ?? 0;
    case "ambient.face.oculo_oral_synkinesis_index":
      return evidence.coupledExpressionEventCount ?? 0;
    default:
      return 0;
  }
}

function qualityFacts(evidence: AmbientMetricEvidence): Record<string, number> {
  const facts: Record<string, number> = {
    eligibleDurationMs: evidence.eligibleDurationMs,
    sampleCount: evidence.sampleCount,
    segmentCount: evidence.segmentCount,
    qualifyingBinCount: evidence.qualifyingBinCount
  };
  const optional: Array<[string, number | undefined]> = [
    ["activeSpeechDurationMs", evidence.activeSpeechDurationMs],
    ["pitchedDurationMs", evidence.pitchedDurationMs],
    ["pitchCoverage", evidence.pitchCoverage],
    ["timingCoverage", evidence.timingCoverage],
    ["pauseCount", evidence.pauseCount],
    ["speechRunCount", evidence.speechRunCount],
    ["nucleusCount", evidence.nucleusCount],
    ["frontalExposureMs", evidence.frontalExposureMs],
    ["blinkCount", evidence.blinkCount],
    ["expressionEventCount", evidence.expressionEventCount],
    ["coupledExpressionEventCount", evidence.coupledExpressionEventCount],
    // Worst-case gate facts. Each is re-verified against the pack threshold in
    // evidence-core; a metric measured without the fact its own pack entry
    // requires now fails provenance rather than silently passing.
    ["estimatorQuality", evidence.estimatorQuality],
    ["estimatorAgreement", evidence.estimatorAgreement],
    ["segmentSpanMs", evidence.segmentSpanMs],
    ["activeSpeechPerSegmentMs", evidence.activeSpeechPerSegmentMs],
    ["validBinsPerSegment", evidence.validBinsPerSegment],
    ["cadenceHz", evidence.cadenceHz],
    ["p95FrameGapMs", evidence.p95FrameGapMs],
    ["maximumFrameGapMs", evidence.maximumFrameGapMs],
    ["dataPerBinMs", evidence.dataPerBinMs],
    ["samplesPerBin", evidence.samplesPerBin],
    ["binSpanMs", evidence.binSpanMs]
  ];
  for (const [name, value] of optional) {
    if (value !== undefined && Number.isFinite(value)) facts[name] = value;
  }
  return facts;
}

function windowsFor(
  outcome: AmbientMetricOutcome,
  definition: MetricDefinition,
  sessionId: string,
  processorRef: string,
  trackSegmentId: string,
  measured: boolean,
  withheldReason: WithheldReasonCode | null,
  observationDurationMs: number
): EvidenceWindowV1[] {
  const observedStart = Math.max(0, outcome.evidence.observedStartMs ?? 0);
  const observedEnd = Math.max(
    observedStart + 1,
    outcome.evidence.observedEndMs ?? observedStart + 1
  );
  const sources = outcome.evidence.sourceWindowRefs.length > 0
    ? outcome.evidence.sourceWindowRefs.map((sourceRef) => ({
        sourceRef,
        ...parseAmbientSourceWindowRef(
          sourceRef,
          definition.modality,
          observationDurationMs
        )
      }))
    : [{
        sourceRef: `${outcome.modality}-unavailable`,
        startMs: observedStart,
        endMs: Math.min(observationDurationMs, observedEnd)
      }];
  return sources.map((source, index) => ({
    windowId: safeId(`window:${definition.code}:${index}:${source.sourceRef}`),
    sessionId,
    modality: definition.modality,
    context: definition.context,
    trackSegmentId,
    processorRef,
    startMs: source.startMs,
    endMs: source.endMs,
    technicalQualityScore:
      measured && outcome.status === "measured" ? outcome.technicalQualityScore : 0,
    status: measured ? "eligible" : "withheld",
    reasonCodes: measured ? [] : [withheldReason ?? "quality-threshold-failed"]
  }));
}

export function contractReason(
  outcome: AmbientMetricOutcome,
  definition: MetricDefinition,
  laneAvailable: boolean
): WithheldReasonCode {
  if (!laneAvailable) return "modality-unavailable";
  if (outcome.status === "measured") return "quality-threshold-failed";
  const reason = WithheldReasonCodeSchema.parse(outcome.reasonCode);
  if (!definition.withheldReasonCodes.includes(reason)) {
    throw new Error(
      `Ambient extractor reason ${reason} is not registered for ${definition.code}.`
    );
  }
  return reason;
}

function outcomeArtifacts(
  outcome: AmbientMetricOutcome,
  input: AmbientObservationBuildInput
): {
  outcome: MetricOutcomeV1;
  windows: EvidenceWindowV1[];
  measurement: ObservationV3["measurements"][number] | null;
} {
  const definition = metricDefinition(outcome.code);
  const processorRef = primaryProcessor(outcome, input.processors);
  const trackSegmentId = primaryTrack(outcome);
  const exactAttribution =
    outcome.evidence.processorRefs.length === 1 &&
    outcome.evidence.trackSegmentIds.length === 1;
  const projectAsMeasured = outcome.status === "measured" && exactAttribution;
  const laneAvailable =
    definition.modality === "voice"
      ? input.voiceLaneAvailable
      : input.faceLaneAvailable;
  const withheldReason = projectAsMeasured
    ? null
    : contractReason(outcome, definition, laneAvailable);
  const identity = {
    protocolPackId: AMBIENT_LOCAL_PROTOCOL_PACK.packId,
    protocolVersion: AMBIENT_LOCAL_PROTOCOL_PACK.version,
    sessionId: input.sessionId,
    metricCode: definition.code,
    context: definition.context,
    unit: definition.unit,
    algorithmVersion: definition.algorithmVersion,
    processorRef,
    trackSegmentId
  };
  const aggregateId = createAggregateId(identity);
  const windows = windowsFor(
    outcome,
    definition,
    input.sessionId,
    processorRef,
    trackSegmentId,
    projectAsMeasured,
    withheldReason,
    Math.min(300_000, Math.max(0, input.durationMs))
  );
  const observationId = safeId(`observation:${input.sessionId}`);
  const windowRefs: EvidenceRef[] = windows.map((window) => ({
    schemaVersion: "phenometric.evidence-ref.v1",
    kind: "window",
    sessionId: input.sessionId,
    observationId,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    windowId: window.windowId,
    modality: definition.modality,
    context: definition.context,
    trackSegmentId
  }));
  const aggregateRef: EvidenceRef = {
    schemaVersion: "phenometric.evidence-ref.v1",
    kind: "aggregate",
    sessionId: input.sessionId,
    observationId,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    aggregateId,
    metricCode: definition.code,
    modality: definition.modality,
    context: definition.context,
    unit: definition.unit,
    trackSegmentId
  };
  const measurementId = createMeasurementId(identity, windows[0].windowId, 0);
  const measurementRef: EvidenceRef = {
    schemaVersion: "phenometric.evidence-ref.v1",
    kind: "measurement",
    sessionId: input.sessionId,
    observationId,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    measurementId,
    metricCode: definition.code,
    modality: definition.modality,
    context: definition.context,
    unit: definition.unit,
    trackSegmentId
  };
  const evidence = {
    eligibleDurationMs: outcome.evidence.eligibleDurationMs,
    activeDurationMs: outcome.evidence.activeSpeechDurationMs ?? 0,
    segmentCount: outcome.evidence.segmentCount,
    windowCount: outcome.evidence.sourceWindowRefs.length,
    binCount: outcome.evidence.qualifyingBinCount,
    eventCount: relevantEventCount(definition.code, outcome.evidence),
    sampleCount: outcome.evidence.sampleCount,
    coverage: outcome.evidence.pitchCoverage ?? null,
    qualityFacts: qualityFacts(outcome.evidence),
    refs:
      projectAsMeasured
        ? [...windowRefs, measurementRef, aggregateRef]
        : [...windowRefs, aggregateRef]
  };
  const common = {
    outcomeId: outcome.identity.outcomeId,
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
    technicalVerification: "automated-test" as const,
    clinicalValidation: "none" as const,
    evidence
  };
  if (projectAsMeasured && outcome.status === "measured") {
    return {
      outcome: {
        ...common,
        status: "measured",
        value: outcome.value,
        technicalQualityScore: outcome.technicalQualityScore,
        technicalDispersion: outcome.technicalDispersion
      },
      windows,
      measurement: {
        measurementId,
        ordinal: 0,
        aggregateId,
        sessionId: input.sessionId,
        metricCode: definition.code,
        label: definition.label,
        modality: definition.modality,
        context: definition.context,
        unit: definition.unit,
        value: outcome.value,
        technicalQualityScore: outcome.technicalQualityScore,
        algorithmVersion: definition.algorithmVersion,
        processorRef,
        trackSegmentId,
        sourceWindowRefs: windows.map((window) => window.windowId)
      }
    };
  }
  return {
    outcome: {
      ...common,
      status: "withheld",
      reasonCode: withheldReason ?? "quality-threshold-failed",
      detail: !laneAvailable
        ? `The ${definition.modality} modality was unavailable in this session.`
        : outcome.status === "measured"
          ? "Measurement was withheld because processor or track provenance was mixed or missing."
          : outcome.detail.slice(0, 240),
      technicalQualityScore: null,
      technicalDispersion: null
    },
    windows,
    measurement: null
  };
}

function ensureProcessorRefs(
  processors: readonly ProcessorProvenanceV1[],
  outcomes: readonly MetricOutcomeV1[]
): ProcessorProvenanceV1[] {
  const byRef = new Map(processors.map((processor) => [processor.processorRef, processor]));
  for (const outcome of outcomes) {
    if (byRef.has(outcome.processorRef)) continue;
    byRef.set(outcome.processorRef, {
      modality: outcome.modality,
      processorRef: outcome.processorRef,
      runtime: "unavailable",
      runtimeVersion: "1.0.0",
      assetPath: null,
      assetSha256: null,
      assetIntegrityVerified: false
    });
  }
  return [...byRef.values()];
}

export function buildAmbientObservation(
  input: AmbientObservationBuildInput
): ObservationV3 {
  const extraction = finalizeAmbientMetrics({
    identity: {
      sessionId: input.sessionId,
      protocolVersion: AMBIENT_LOCAL_PROTOCOL_PACK.version,
      protocolContentSha256: AMBIENT_LOCAL_PROTOCOL_PACK.contentSha256,
      sessionStartedAtMs: 0
    },
    voice: {
      frames: input.voiceFrames,
      noiseCalibrationDurationMs: input.noiseCalibrationDurationMs
    },
    face: {
      frames: input.faceFrames,
      calibration: input.faceCalibration
    }
  });
  const artifacts = extraction.outcomes.map((outcome) =>
    outcomeArtifacts(outcome, input)
  );
  const outcomes = artifacts.map((artifact) => artifact.outcome);
  const windows = artifacts.flatMap((artifact) => artifact.windows);
  const measurements = artifacts.flatMap((artifact) =>
    artifact.measurement ? [artifact.measurement] : []
  );
  const laneSummary = (modality: "voice" | "face", available: boolean) => {
    const laneOutcomes = outcomes.filter((outcome) => outcome.modality === modality);
    const measured = laneOutcomes.filter((outcome) => outcome.status === "measured");
    return {
      state: !available ? "unavailable" as const : measured.length > 0 ? "ready" as const : "withheld" as const,
      eligibleDurationMs: Math.max(0, ...laneOutcomes.map((outcome) => outcome.evidence.eligibleDurationMs)),
      technicalQualityScore:
        measured.length === 0
          ? null
          : measured.reduce((sum, outcome) => sum + outcome.technicalQualityScore, 0) /
            measured.length,
      reasonCodes: [...new Set(laneOutcomes.flatMap((outcome) =>
        outcome.status === "withheld" ? [outcome.reasonCode] : []
      ))]
    };
  };
  return ObservationV3Schema.parse({
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
    observationId: safeId(`observation:${input.sessionId}`),
    sessionId: input.sessionId,
    subjectRef: input.subjectRef,
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    consent: input.consent,
    source: {
      role: "local-participant",
      sourceSessionRef: input.sessionId,
      audioAttribution: "user-asserted-local-participant",
      speakerAttribution: "unverified-local-input",
      audioInput: "microphone",
      faceAttribution: "single-visible-face",
      identityVerified: false
    },
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.min(300_000, Math.max(0, input.durationMs)),
    captureAdapter: { id: "browser-local-media", version: "1.0.0" },
    processors: ensureProcessorRefs(input.processors, outcomes),
    windows,
    measurements,
    metricOutcomes: outcomes,
    qualitySummary: {
      voice: laneSummary("voice", input.voiceLaneAvailable),
      face: laneSummary("face", input.faceLaneAvailable),
      totalWindowCount: windows.length,
      eligibleWindowCount: windows.filter((window) => window.status === "eligible").length,
      withheldWindowCount: windows.filter((window) => window.status === "withheld").length
    }
  });
}
