# PhenoMetrix architecture

This document describes the implemented ambient-v3 prototype. Long-term
platform ideas in `telehealth-platform-vision.md` are not shipping behavior.

## Implemented flow

```mermaid
flowchart LR
    CONSENT["Explicit local consent"] --> PERMISSION["Independent camera and microphone permission"]
    PERMISSION --> CAL["Bounded technical calibration"]
    CAL --> CAPTURE["Ambient observation, at most five minutes"]
    CAPTURE --> VOICE["Audio worklet and voice worker"]
    CAPTURE --> FACE["MediaPipe face worker"]
    VOICE --> EXTRACT["Deterministic ambient extractors"]
    FACE --> EXTRACT
    EXTRACT --> OBS["ObservationV3"]
    OBS --> REPORT["Session-only structured report"]
    REPORT --> DISPOSE["Clear devices, workers, frames, and journal"]
```

The browser is a static Vite application. It has no application server and
makes no measurement or report API request.

## Capture boundary

Audio and face processing are independent.

The audio worklet transfers 20 ms PCM blocks to a worker. The worker maintains
a bounded two-second ring and emits only content-free signal frames. PCM,
waveforms, FFT bins, cepstra, MFCCs, formant tracks, transcripts,
spectrograms, embeddings, voiceprints, and device identifiers cannot enter an
observation.

The browser projects those compact frames into an eight-second, 800-sample
live energy/pitch history. Canvas painting is animation-frame throttled and the
history is cleared on finalization, discard, permission failure, reset, or page
exit. It does not feed an extractor or report.

The face worker owns MediaPipe inference. Native bitmaps, 478 landmarks,
blendshapes, and transformation matrices are scoped to worker processing and
are not returned. The application receives normalized geometry, pose, compact
image-quality facts, cadence, processor provenance, face count, and track
continuity only.

For presentation, the application transfers a canvas to the face worker once
per session. The worker draws all 478 points, 2,556 tessellation edges, and the
eye, iris, brow, lip, and oval contours at inference cadence capped at 24 Hz.
The surface clears for zero or multiple faces and on every teardown path; its
pixels and landmark coordinates never enter application state.

## Calibration and lifecycle

After consent, camera and microphone permissions resolve separately. Available
lanes calibrate independently:

- audio requires a two-second technically quiet interval;
- face requires a 1.5-second stable, frontal, single-face interval; and
- setup terminalizes after 15 seconds.

At least one capture-capable lane is required to continue. A timed-out lane is
shown as not measurable rather than blocking the other lane. The ambient
observation can run for at most 300 seconds and can be ended or discarded at
any time.

Finish stops acquisition before creating the report. Discard, page hiding,
page unload, and stale asynchronous media resolution all use the same
generation-guarded disposal path. There is no separate in-session withdraw
control; during an active session, consent withdrawal is performed through
Discard, which routes to that same disposal path.

## Measurement and abstention

`@phenometrix/ambient-core` owns the frozen 16-metric registry and deterministic
extractors. Extractors receive derived frames only. They screen evidence into
qualified voice segments or five-second face bins, then return one terminal
outcome for every registered metric.

Abstention is first-class. Withheld reasons are closed, metric-specific protocol
values such as `no-usable-signal`, `insufficient-pitched-speech`,
`insufficient-bins`, `insufficient-exposure`, and `multiple-faces`. The adapter
must preserve these reasons exactly; an unregistered extractor reason is an
invariant failure, not a generic fallback.

## Observation and evidence

`buildAmbientObservation()` creates a strict ObservationV3 containing:

- anonymous session and subject references;
- the exact protocol and consent document digests;
- explicit, non-identity-verified source attribution;
- processor and asset-integrity provenance;
- exact source-window intervals;
- measured values only when evidence and attribution qualify; and
- one measured or withheld terminal outcome for all 16 metrics.

The in-memory workflow journal records consent, permission, calibration,
capture, measurement/withholding, observation, and report lifecycle events.
It is not a durable audit log.

`@phenometrix/evidence-core` validates the observation against the canonical
protocol registry and resolves evidence references before building the report.
The report contains capture quality plus seven metric sections. It has no
generated prose or clinical claim.

## Static assets

The browser verifies a committed SHA-256 manifest for the face model, voice
worklet, and MediaPipe WASM assets before device processing. Missing or changed
assets cause the affected lane to fail closed.

## Retained legacy boundaries

The guided calibration interfaces remain for compile compatibility and research
tests. They are disconnected from ObservationV3 and the live application.

`@phenometrix/trajectory-core` and the v2 observation, measurement, and event
interfaces were removed on 2026-07-24. The package compared one session scalar
against an unordered bag of priors, was built on superseded v2 contracts, and
had no importers. The capture-provenance types it shared a file with
(`AudioPipelineProvenance`, `VideoCaptureSettings`, and siblings) are live and
were kept.

The Python WavLM sidecar is restored as an optional loopback research service.
It is disabled by default, separately tested, and has no browser consumer.

Top-level guided protocol and example files are archival. They are not runtime
inputs and are not part of the active structure gate.

## Deferred

Persistence, multi-visit trajectory, retained snippets, narrative synthesis,
clinician review, export, PHI workflows, identity verification, analytical
validation, and clinical validation are intentionally absent.
