import {
  AMBIENT_LOCAL_PROTOCOL_PACK,
  ObservationV3Schema,
  PostEncounterReportV1Schema,
  ProtocolPackV1Schema,
  REPORT_BOUNDARY_STATEMENT,
  REPORT_SOURCE_DISCLOSURE,
  protocolPackDigestInput,
  WorkflowEventV1Schema,
  type EvidenceRef,
  type MetricDefinition,
  type MetricOutcomeV1,
  type ObservationV3,
  type PostEncounterReportV1,
  type ProtocolPackV1,
  type ProtocolRef,
  type ReportSectionId,
  type WorkflowEventV1
} from "@phenometrix/contracts";

export interface ProvenanceValidationResult {
  status: "pass" | "fail";
  errors: string[];
}

export interface BuildPostEncounterReportOptions {
  generatedAt: string;
  reportId?: string;
  events?: WorkflowEventV1[];
}

const SECTION_LABELS: Readonly<Record<ReportSectionId, string>> = {
  "capture-quality": "Capture quality",
  pitch: "Pitch",
  "speech-timing": "Speech timing",
  "eye-geometry": "Eye geometry",
  "mouth-geometry": "Mouth geometry",
  symmetry: "Symmetry",
  "expression-dynamics": "Expression dynamics",
  "brow-geometry": "Brow geometry",
  movement: "Movement",
  "blink-behavior": "Blink behavior"
};

function sameProtocol(left: ProtocolRef, right: ProtocolRef): boolean {
  return (
    left.packId === right.packId &&
    left.version === right.version &&
    left.contentSha256 === right.contentSha256
  );
}

function definitionErrors(
  outcome: MetricOutcomeV1,
  definition: MetricDefinition
): string[] {
  const errors: string[] = [];
  const exactFields = [
    ["label", outcome.label, definition.label],
    ["modality", outcome.modality, definition.modality],
    ["context", outcome.context, definition.context],
    ["unit", outcome.unit, definition.unit],
    ["report section", outcome.reportSection, definition.reportSection],
    ["algorithm version", outcome.algorithmVersion, definition.algorithmVersion],
    [
      "technical verification",
      outcome.technicalVerification,
      definition.technicalVerification
    ],
    ["clinical validation", outcome.clinicalValidation, definition.clinicalValidation]
  ] as const;
  for (const [label, actual, expected] of exactFields) {
    if (actual !== expected) {
      errors.push(
        `${outcome.metricCode} ${label} does not match the protocol registry.`
      );
    }
  }
  if (
    !definition.withheldReasonCodes.includes(
      outcome.status === "withheld" ? outcome.reasonCode : ""
    ) &&
    outcome.status === "withheld"
  ) {
    errors.push(
      `${outcome.metricCode} uses a withheld reason not registered by the protocol.`
    );
  }
  return errors;
}

const ALGORITHM_PARAMETER_REQUIREMENTS = new Set([
  "binDurationMs",
  "minimumPauseMs",
  "maximumPauseMs",
  "closureFractionOfOpenReference",
  "minimumClosureMs",
  "recoveryFractionOfOpenReference",
  "maximumRecoveryMs",
  "refractoryMs",
  // The movement floor below which oculo-oral coupling is not divided; an
  // algorithm parameter, not a property of the session's evidence.
  "minimumCouplingElevation"
]);

/**
 * Exported for the pack-coverage test, which asserts that every requirement the
 * pack declares is either listed here as an algorithm parameter or resolvable
 * by {@link evidenceFactFor}. Without that pairing a new requirement can be
 * published and never checked.
 */
export const ALGORITHM_PARAMETER_REQUIREMENT_KEYS: ReadonlySet<string> =
  ALGORITHM_PARAMETER_REQUIREMENTS;

/**
 * Exported for the pack-coverage test. A requirement the pack declares but this
 * function cannot resolve is a gate nothing verifies at the report boundary, so
 * the test asserts every declared key is reachable here.
 */
export function evidenceFactFor(
  outcome: MetricOutcomeV1,
  requirement: string
): number | undefined {
  const qualityNumber = (name: string): number | undefined => {
    const value = outcome.evidence.qualityFacts[name];
    return typeof value === "number" ? value : undefined;
  };
  switch (requirement) {
    case "minimumSegments":
      return outcome.evidence.segmentCount;
    case "minimumPitchedDurationMs":
      return qualityNumber("pitchedDurationMs");
    case "minimumPitchCoverage":
      return qualityNumber("pitchCoverage") ?? outcome.evidence.coverage ?? undefined;
    case "minimumF0Hz":
    case "maximumF0Hz":
      return outcome.status === "measured" ? outcome.value : undefined;
    case "minimumEstimatorQuality":
      return qualityNumber("estimatorQuality");
    case "minimumEstimatorAgreement":
      return qualityNumber("estimatorAgreement");
    case "minimumValidBinsPerSegment":
      return qualityNumber("validBinsPerSegment");
    case "minimumEligibleSpanMs":
    case "minimumObservationSpanMs":
    case "minimumExposureMs":
      return outcome.evidence.eligibleDurationMs;
    case "minimumActiveSpeechMs":
      return outcome.evidence.activeDurationMs;
    case "minimumSegmentSpanMs":
      return qualityNumber("segmentSpanMs");
    case "minimumActiveSpeechPerSegmentMs":
      return qualityNumber("activeSpeechPerSegmentMs");
    case "minimumTimingCoverage":
      // No fallback to `evidence.coverage`: that field carries pitch coverage,
      // a voicing statistic, and comparing it against a timing threshold
      // failed provenance for ordinary part-voiced speech.
      return qualityNumber("timingCoverage");
    case "minimumEventsForMedian":
      // Resolved from the metric's OWN counter. `evidence.eventCount` used to
      // be a maximum over the pause, run, nucleus, and blink counts, so a
      // pause-count gate could be cleared by a syllable count.
      return qualityNumber(
        outcome.metricCode === "ambient.voice.speech_run_duration.median"
          ? "speechRunCount"
          : "pauseCount"
      );
    case "minimumNuclei":
      return qualityNumber("nucleusCount");
    case "minimumExpressionEvents":
      return qualityNumber("expressionEventCount");
    case "minimumCoupledExpressionEvents":
      return qualityNumber("coupledExpressionEventCount");
    case "minimumDataPerBinMs":
      return qualityNumber("dataPerBinMs");
    case "minimumSamplesPerBin":
      return qualityNumber("samplesPerBin");
    case "minimumBinSpanMs":
      return qualityNumber("binSpanMs");
    case "maximumFrameGapMs":
      return qualityNumber("maximumFrameGapMs");
    case "minimumBins":
      return outcome.evidence.binCount;
    case "minimumCadenceHz":
      return qualityNumber("cadenceHz");
    case "maximumP95FrameGapMs":
      return qualityNumber("p95FrameGapMs");
    default:
      return undefined;
  }
}

function measuredEvidenceErrors(
  outcome: MetricOutcomeV1,
  definition: MetricDefinition
): string[] {
  if (outcome.status !== "measured") return [];
  const errors: string[] = [];
  if (
    outcome.evidence.eligibleDurationMs <= 0 ||
    outcome.evidence.sampleCount <= 0
  ) {
    errors.push(
      `${outcome.metricCode} measured outcome requires positive eligible evidence and samples.`
    );
  }
  for (const [requirement, threshold] of Object.entries(
    definition.evidenceRequirements
  )) {
    if (ALGORITHM_PARAMETER_REQUIREMENTS.has(requirement)) continue;
    const actual = evidenceFactFor(outcome, requirement);
    if (actual === undefined) {
      // A measured outcome that cannot produce the evidence its own pack entry
      // demands has not satisfied that gate — it has merely failed to report
      // on it, which is the one outcome this system must never treat as a
      // pass. This previously skipped silently, leaving 11 of the pack's
      // declared requirements unverified at the report boundary while the
      // report still claimed provenance over them.
      errors.push(
        `${outcome.metricCode} is missing the evidence fact for requirement ${requirement}.`
      );
      continue;
    }
    const satisfied = requirement.startsWith("maximum")
      ? actual <= threshold
      : requirement.startsWith("minimum")
        ? actual >= threshold
        : actual === threshold;
    if (!satisfied) {
      errors.push(
        `${outcome.metricCode} does not satisfy evidence requirement ${requirement}.`
      );
    }
  }
  return errors;
}

function refErrors(
  ref: EvidenceRef,
  outcome: MetricOutcomeV1,
  observation: ObservationV3,
  events: WorkflowEventV1[]
): string[] {
  const errors: string[] = [];
  const prefix = `${outcome.metricCode} ${ref.kind} evidence`;
  if (
    ref.sessionId !== observation.sessionId ||
    ref.observationId !== observation.observationId ||
    !sameProtocol(ref.protocolRef, observation.protocolRef)
  ) {
    errors.push(`${prefix} is bound to a different observation context.`);
    return errors;
  }
  if (ref.kind === "window") {
    const window = observation.windows.find(
      (candidate) => candidate.windowId === ref.windowId
    );
    if (!window) return [`${prefix} does not resolve.`];
    if (
      window.sessionId !== ref.sessionId ||
      window.modality !== ref.modality ||
      window.context !== ref.context ||
      window.trackSegmentId !== ref.trackSegmentId ||
      ref.modality !== outcome.modality ||
      ref.context !== outcome.context ||
      ref.trackSegmentId !== outcome.trackSegmentId
    ) {
      errors.push(`${prefix} metadata does not match its resolved window.`);
    }
  } else if (ref.kind === "measurement") {
    const measurement = observation.measurements.find(
      (candidate) => candidate.measurementId === ref.measurementId
    );
    if (!measurement) return [`${prefix} does not resolve.`];
    if (
      measurement.sessionId !== ref.sessionId ||
      measurement.aggregateId !== outcome.aggregateId ||
      measurement.metricCode !== ref.metricCode ||
      measurement.metricCode !== outcome.metricCode ||
      measurement.modality !== ref.modality ||
      measurement.modality !== outcome.modality ||
      measurement.context !== ref.context ||
      measurement.context !== outcome.context ||
      measurement.unit !== ref.unit ||
      measurement.unit !== outcome.unit ||
      measurement.trackSegmentId !== ref.trackSegmentId ||
      measurement.trackSegmentId !== outcome.trackSegmentId
    ) {
      errors.push(`${prefix} metadata does not match its resolved measurement.`);
    }
  } else if (ref.kind === "aggregate") {
    const aggregate = observation.metricOutcomes.find(
      (candidate) => candidate.aggregateId === ref.aggregateId
    );
    if (!aggregate) return [`${prefix} does not resolve.`];
    if (
      aggregate.aggregateId !== outcome.aggregateId ||
      aggregate.metricCode !== ref.metricCode ||
      aggregate.metricCode !== outcome.metricCode ||
      aggregate.modality !== ref.modality ||
      aggregate.context !== ref.context ||
      aggregate.unit !== ref.unit ||
      aggregate.trackSegmentId !== ref.trackSegmentId
    ) {
      errors.push(`${prefix} metadata does not match its resolved aggregate.`);
    }
  } else {
    const event = events.find((candidate) => candidate.eventId === ref.eventId);
    if (!event) return [`${prefix} does not resolve.`];
    if (
      event.sessionId !== observation.sessionId ||
      event.subjectRef !== observation.subjectRef ||
      !sameProtocol(event.protocolRef, observation.protocolRef)
    ) {
      errors.push(`${prefix} metadata does not match its resolved event.`);
    }
    if (
      (event.type === "measurement.recorded" ||
        event.type === "measurement.withheld") &&
      event.payload.metricCode !== outcome.metricCode
    ) {
      errors.push(`${prefix} resolves to a different metric event.`);
    }
  }
  return errors;
}

export function validateObservationProvenance(
  observationInput: ObservationV3,
  protocolInput: ProtocolPackV1,
  eventInputs: WorkflowEventV1[] = []
): ProvenanceValidationResult {
  const parsedObservation = ObservationV3Schema.safeParse(observationInput);
  const parsedProtocol = ProtocolPackV1Schema.safeParse(protocolInput);
  const parsedEvents = eventInputs.map((event) =>
    WorkflowEventV1Schema.safeParse(event)
  );
  const errors: string[] = [];
  if (!parsedObservation.success) {
    errors.push("ObservationV3 failed runtime schema validation.");
  }
  if (!parsedProtocol.success) {
    errors.push("ProtocolPackV1 failed runtime schema validation.");
  }
  parsedEvents.forEach((event, index) => {
    if (!event.success) errors.push(`Workflow event ${index} is invalid.`);
  });
  if (!parsedObservation.success || !parsedProtocol.success) {
    return { status: "fail", errors };
  }

  const observation = parsedObservation.data;
  const protocol = parsedProtocol.data;
  const events = parsedEvents.flatMap((event) =>
    event.success ? [event.data] : []
  );
  const expectedRef = {
    packId: protocol.packId,
    version: protocol.version,
    contentSha256: protocol.contentSha256
  };
  if (
    protocol.contentSha256 !== AMBIENT_LOCAL_PROTOCOL_PACK.contentSha256 ||
    protocolPackDigestInput(protocol) !==
      protocolPackDigestInput(AMBIENT_LOCAL_PROTOCOL_PACK)
  ) {
    errors.push("Supplied protocol pack is not the canonical active pack.");
  }
  if (!sameProtocol(observation.protocolRef, expectedRef)) {
    errors.push("Observation protocol reference does not match the supplied pack.");
  }
  if (
    observation.consent.documentVersion !== protocol.consentDocument.version ||
    observation.consent.documentSha256 !==
      protocol.consentDocument.contentSha256
  ) {
    errors.push("Observation consent does not match the protocol consent document.");
  }
  if (observation.metricOutcomes.length !== protocol.metrics.length) {
    errors.push("Observation must contain one terminal outcome per registered metric.");
  }

  const definitions = new Map(
    protocol.metrics.map((definition) => [definition.code, definition])
  );
  const outcomeCodes = new Set(
    observation.metricOutcomes.map((outcome) => outcome.metricCode)
  );
  for (const definition of protocol.metrics) {
    if (!outcomeCodes.has(definition.code)) {
      errors.push(`Missing terminal outcome for ${definition.code}.`);
    }
  }
  const processorRefs = new Set(
    observation.processors.map((processor) => processor.processorRef)
  );
  for (const outcome of observation.metricOutcomes) {
    const definition = definitions.get(outcome.metricCode);
    if (!definition) {
      errors.push(`Unregistered metric outcome ${outcome.metricCode}.`);
      continue;
    }
    errors.push(...definitionErrors(outcome, definition));
    errors.push(...measuredEvidenceErrors(outcome, definition));
    if (!processorRefs.has(outcome.processorRef)) {
      errors.push(`${outcome.metricCode} processor reference does not resolve.`);
    }
    if (
      outcome.status === "measured" &&
      !outcome.evidence.refs.some((ref) => ref.kind === "measurement")
    ) {
      errors.push(
        `${outcome.metricCode} measured outcome requires a measurement reference.`
      );
    }
    for (const ref of outcome.evidence.refs) {
      errors.push(...refErrors(ref, outcome, observation, events));
    }
  }

  for (const measurement of observation.measurements) {
    const aggregate = observation.metricOutcomes.find(
      (outcome) => outcome.aggregateId === measurement.aggregateId
    );
    if (
      !aggregate ||
      aggregate.status !== "measured" ||
      measurement.sessionId !== observation.sessionId ||
      aggregate.metricCode !== measurement.metricCode ||
      aggregate.label !== measurement.label ||
      aggregate.modality !== measurement.modality ||
      aggregate.context !== measurement.context ||
      aggregate.unit !== measurement.unit ||
      aggregate.algorithmVersion !== measurement.algorithmVersion ||
      aggregate.processorRef !== measurement.processorRef ||
      aggregate.trackSegmentId !== measurement.trackSegmentId
    ) {
      errors.push(
        `Measurement ${measurement.measurementId} does not resolve to its exact terminal aggregate.`
      );
    }
    for (const windowId of measurement.sourceWindowRefs) {
      const window = observation.windows.find(
        (candidate) => candidate.windowId === windowId
      );
      if (
        !window ||
        window.modality !== measurement.modality ||
        window.context !== measurement.context ||
        window.processorRef !== measurement.processorRef ||
        window.trackSegmentId !== measurement.trackSegmentId
      ) {
        errors.push(
          `Measurement ${measurement.measurementId} has an incompatible source window.`
        );
      }
    }
  }

  return {
    status: errors.length === 0 ? "pass" : "fail",
    errors
  };
}

export function buildPostEncounterReport(
  observationInput: ObservationV3,
  protocolInput: ProtocolPackV1,
  options: BuildPostEncounterReportOptions
): PostEncounterReportV1 {
  const observation = ObservationV3Schema.parse(observationInput);
  const protocol = ProtocolPackV1Schema.parse(protocolInput);
  const events = (options.events ?? []).map((event) =>
    WorkflowEventV1Schema.parse(event)
  );
  const provenance = validateObservationProvenance(
    observation,
    protocol,
    events
  );
  if (provenance.status === "fail") {
    throw new Error(
      `Cannot build report from invalid provenance: ${provenance.errors.join(" ")}`
    );
  }

  const definitionOrder = new Map(
    protocol.metrics.map((definition) => [
      definition.code,
      definition.reportOrder
    ])
  );
  const sections = protocol.reportSections.map((sectionId) => ({
    sectionId,
    label: SECTION_LABELS[sectionId],
    qualityFacts:
      sectionId === "capture-quality"
        ? [
            {
              code: "session-duration" as const,
              label: "Session duration",
              value: observation.durationMs,
              unit: "milliseconds"
            },
            {
              code: "voice-lane" as const,
              label: "Voice lane",
              value: observation.qualitySummary.voice.state,
              unit: null
            },
            {
              code: "face-lane" as const,
              label: "Face lane",
              value: observation.qualitySummary.face.state,
              unit: null
            },
            {
              code: "eligible-windows" as const,
              label: "Eligible windows",
              value: observation.qualitySummary.eligibleWindowCount,
              unit: "windows"
            },
            {
              code: "withheld-windows" as const,
              label: "Withheld windows",
              value: observation.qualitySummary.withheldWindowCount,
              unit: "windows"
            }
          ]
        : [],
    outcomes: observation.metricOutcomes
      .filter((outcome) => outcome.reportSection === sectionId)
      .sort(
        (left, right) =>
          (definitionOrder.get(left.metricCode) ?? 0) -
          (definitionOrder.get(right.metricCode) ?? 0)
      )
  }));

  return PostEncounterReportV1Schema.parse({
    schemaVersion: "phenometric.post-encounter-report.v1",
    reportId: options.reportId ?? `report-${observation.observationId}`,
    observationId: observation.observationId,
    sessionId: observation.sessionId,
    subjectRef: observation.subjectRef,
    protocolRef: observation.protocolRef,
    generatedAt: options.generatedAt,
    source: observation.source,
    sections,
    boundaryStatement: REPORT_BOUNDARY_STATEMENT,
    sourceDisclosure: REPORT_SOURCE_DISCLOSURE,
    persistence: "session-memory-only",
    exportAvailable: false
  });
}
