# PhenoMetric shared contracts

`@phenometric/contracts` is the runtime and TypeScript source of truth for the
standalone ambient prototype. These are engineering-prototype contracts, not
clinical schemas.

## Canonical v1/v3 contracts

- `AMBIENT_LOCAL_PROTOCOL_PACK` is the immutable
  `phenometric.protocol-pack.v1` registry. It defines the 16 supported metrics,
  one quality policy, report ordering, consent document digest, source policy,
  supported runtime, and the five-minute limit.
- `ObservationV3Schema` requires session-local anonymous subject and consent
  references, explicit source attribution, bounded retention assertions,
  processor provenance, typed evidence, and one measured or withheld terminal
  outcome per emitted metric.
- `EvidenceRefSchema` distinguishes window, measurement, aggregate, and event
  references. Each reference carries its session, observation, and exact
  protocol identity.
- `PostEncounterReportV1Schema` is a deterministic, structured, screen-only
  report. It has no narrative, clinical interpretation, review state,
  trajectory, persistence, or export shape.
- `WorkflowEventV1Schema` is a discriminated union with typed payloads for the
  local capture lifecycle. It uses a session-local anonymous subject reference
  rather than a participant identity claim.
- `createMeasurementId` and `createAggregateId` derive stable referential IDs
  from protocol, session, metric, context, unit, algorithm, processor, and track
  segment identity. They are not security hashes.

All public v1/v3 schemas are strict Zod schemas and all corresponding
TypeScript types are inferred from those schemas. Legacy or extra fields fail
runtime parsing.

The canonical measurement contexts are exactly:

- voice: `ambient-speech-turn`
- face: `ambient-frontal`

The canonical modalities are `voice` and `face`. Audio attribution is
`user-asserted-local-participant` with
`speakerAttribution: unverified-local-input`; facial attribution is
`single-visible-face` and never identity verification.

## Capture provenance versus v3 runtime schemas

`observation.ts` and `measurement.ts` hold the live capture-provenance and
audio-quality types (`AudioPipelineProvenance`, `AudioCaptureSettings`,
`VideoCaptureSettings`, `VisualPipelineProvenance`, `AudioStreamDiagnostics`,
`AudioQualityReasonCode`, `BrowserAudioProcessingState`). These describe how a
session was captured and are consumed by the workers and `primitives.ts`.

They are plain interfaces, not Zod schemas, and are not themselves accepted by
the v3 runtime schemas. New report, provenance, and event-journal code uses the
v3 schemas in `observation-v3.ts`.

The guided calibration interfaces remain for compile compatibility. The v2
observation, measurement, event, and trajectory interfaces were removed on
2026-07-24, along with the legacy evidence-card, generated-narrative,
review-decision, and grounding contracts.

Personal Trajectory remains internal and disconnected. Its legacy contract now
requires an explicit policy and protocol identity and can return
`not-comparable` when compatible prior evidence is insufficient.
