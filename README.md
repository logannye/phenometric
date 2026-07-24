# PhenoMetrix

> Nonclinical research prototype. Not a medical device. Not for diagnosis,
> treatment, emergency detection, or use with protected health information.

PhenoMetrix derives bounded, quality-aware face and voice measurements from an
ordinary conversation, in the browser, without recording it.

A clinician watching a video visit reads a great deal from how someone looks and
sounds — facial symmetry, blink rate, vocal effort, how long they can speak
before drawing breath. Almost none of it reaches the record, because it is hard
to quantify consistently and impossible to quantify the same way twice. The aim
here is to turn those transient observations into measurements that can be
compared: to the other side of the same face, to the start of the same session,
and eventually to the same patient last month.

Everything is built on one rule: **measure only technically qualified signal,
report `Not measurable` otherwise, and dispose of the media before showing the
report.** An abstention with a reason code is a first-class result, not a
failure.

## Why contrast, not absolute value

Every measurement here earns its keep by cancelling a confound rather than by
being accurate in isolation:

| Contrast | Cancels | Status |
|---|---|---|
| Left vs. right, within one frame | lighting, camera, distance, individual anatomy | implemented |
| Early vs. late, within one session | all of the above, plus mood, medication timing, effort | substrate in place |
| Visit N vs. visit N−1 | all of the above, plus individual baseline | not built |

Absolute values across people are where the confounds live. A measurement that
compares a face to itself does not have that problem, which is why the first
protocol pack targets unilateral facial nerve palsy — an indication where the
finding *is* an asymmetry.

## Current implementation

The implemented browser path is:

```text
consent
  → independent camera and microphone permission
  → bounded technical calibration
  → ambient observation (up to five minutes)
  → deterministic local extraction
  → ObservationV3
  → session-only structured report
  → disposal/reset
```

There are no exercises, scripted prompts, LLM calls, server APIs, retained
recordings, transcripts, embeddings, persistence, export, or clinical
interpretation in this path.

### Ambient Capture

`apps/capture-web` uses two independent local processing lanes:

- Audio is captured in 20 ms worklet blocks and analyzed in a worker using 40
  ms windows with a 10 ms hop. Only compact `VoiceSignalFrameV1` values cross
  into application state. Those same derived frames drive an eight-second live
  level and pitch display; the display is not a provisional report.
- MediaPipe Face Landmarker runs in a worker. Native video frames, landmarks,
  and transformation matrices remain inside that boundary. The worker draws its
  complete 478-point mesh and contours directly onto a transferred presentation
  canvas, while only compact `FacialKinematicsFrameV1` geometry and quality
  values are emitted.

  Blendshapes are deliberately **not** computed. They are the obvious shortcut
  to Action Unit intensities and the wrong instrument for this: the rig is
  trained for avatar retargeting and carries a symmetry prior that suppresses
  exactly the left-right difference being measured. Action Units are derived
  geometrically from landmarks instead.

Permission, calibration, measurement, and abstention are independent by
modality. One lane can continue when the other is unavailable.

### Three tiers

Session metrics are the smallest of three representations, not the only one:

| Tier | Rate | Content | Boundary |
|---|---|---|---|
| Substrate | ~100 Hz voice / analyzed cadence face | per-frame geometric and acoustic vectors | provider-side |
| Event | per blink, expression, breath-group | kinematic parameters | provider-side |
| Summary | per session | the 27 published metrics | crosses any boundary |

The organising principle is to **store physical quantities, not clinical
constructs**. A construct like a palsy grade is terminal; a quantity like
"nasolabial angle, left versus right, over time" recombines. Every clinical
scale is a function of quantities, so an archive of quantities can produce a
scale invented after the data was collected — an archive of constructs cannot.

Concretely: a blink is not a count. It is a closing edge, a closed interval, and
a reopening edge. Reduced rate is hypomimia, shallow depth is incomplete
closure, delayed reopening is fatigable — one waveform, three findings, none of
them recoverable from a number.

### Active metric registry

The immutable `ambient-local-observation` protocol pack is content-addressed by
a SHA-256 digest over its own canonical form, and contains exactly 27
nonclinical metrics across 10 report sections: pitch, speech timing, eye
geometry, mouth geometry, symmetry, expression dynamics, brow geometry,
movement, blink behaviour, and capture quality.

Every metric carries its unit, context, algorithm version, evidence
requirements, permitted withheld reasons, technical-verification status, and
`clinicalValidation: "none"`. Every evidence requirement the pack publishes is
re-verified at the report boundary against the same statistic the extractor
enforced; a metric that cannot produce the evidence its own pack entry demands
fails provenance rather than passing quietly.

### Observation and report

`buildAmbientObservation()` converts extractor outcomes into the strict
`phenometric.encounter-observation.v3` schema. Each terminal metric outcome is
either measured or withheld and resolves to exact evidence windows, processor
and track provenance, and a deterministic aggregate identity.

`buildPostEncounterReport()` validates that provenance against the active
protocol pack and creates a ten-section structured report. The report is
screen-only, exists only in session memory, and has no narrative, review,
trajectory, persistence, or export shape.

## Capability status

1. **Ambient Capture:** implemented as the local v3 prototype described above.
2. **Clinician Evidence Card:** represented today only by the deterministic
   structured report. Narrative drafting, clinician approval, and durable
   review state are not implemented.

Cross-visit comparison is not implemented. The v2 `trajectory-core` package that
once gestured at it was removed in July 2026: it compared one session scalar
against an unordered bag of priors, never treating time as an axis, and had no
importers.

The restored `services/voice-inference` WavLM service is an optional,
disabled-by-default research surface. The browser does not import or call it.

## Privacy and safety boundary

- Consent is required before device access.
- Camera and microphone permissions are requested separately.
- Raw media is not uploaded or written to storage.
- PCM, spectral arrays, transcripts, embeddings, native landmarks, and native
  video frames are excluded from ObservationV3 and report contracts.
- Device tracks, workers, audio nodes, timers, derived frame buffers, and the
  in-memory event journal are disposed on finish, discard (which is also the
  in-session consent-withdrawal path), visibility loss, or reset.
- Identity is not verified and speaker attribution is explicitly unverified.
- `Not measurable` is a valid terminal result; missing evidence is never
  imputed as a measurement.

## Deliberately not implemented

- multi-visit persistence or comparison;
- retained evidence snippets or clips;
- narrative generation or human approval/dismissal;
- authentication, PHI workflows, EHR/FHIR integration, or export;
- diagnosis, progression classification, risk prediction, or treatment advice;
- analytical or clinical validation against a reference standard;
- clinical validation of any protocol pack, including facial palsy;
- voluntary-movement grading (House-Brackmann / Sunnybrook equivalence).

## Refused capability

Acute stroke screening is a standing product boundary, not a gap. Forehead
sparing—the discriminator between central and peripheral facial weakness—is not
measurable here, and an ambient capture that abstains on low quality is the
wrong shape for an emergency instrument. See `docs/safety.md`.

## First protocol pack

The first clinical protocol pack is **unilateral facial nerve palsy**, measured
through spontaneous expression captured ambiently rather than elicited
movement. The measurement layer is implemented: eleven face metrics covering
signed resting geometry, spontaneous excursion asymmetry, an oculo-oral
synkinesis index, brow/frontalis geometry, and per-eye lid closure. No metric
is clinically validated, and the detection thresholds are engineering defaults
chosen from the geometry rather than calibrated against recordings.

Full design, including the new primitives required, the contract implications,
and why equivalence to House-Brackmann and Sunnybrook is explicitly not
claimed: `docs/superpowers/specs/2026-07-24-facial-palsy-protocol-pack-design.md`.

## Run locally

Requirements: Node.js 22+, pnpm 9.12.3, and current Chrome on macOS.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:4173`. Camera and microphone access requires localhost
or HTTPS. Consent, device start, session end/discard, and reset all happen in
Chrome. `Ctrl-C` stops the Vite development server.

The optional WavLM research service has separate instructions in
`services/voice-inference/README.md`; starting it does not alter browser
behavior.

## Validate

```bash
pnpm run check
pnpm test
pnpm test:browser
pnpm demo:smoke
uv sync --project services/voice-inference --extra dev --locked
uv run --project services/voice-inference --extra dev pytest services/voice-inference/tests
```

`pnpm test` runs structure and static-asset checks, the protocol-pack digest
check, all unit tests, TypeScript typechecking, and the production build.
Browser smoke tests and the optional Python service remain separate CI jobs.

The pack digest is regenerated with `npx tsx scripts/protocol-digest.mjs
--write` and enforced by `--check` in the repository gate. Changing any pack
content — including the consent wording, whose SHA is a field inside the pack —
requires regenerating it and bumping the pack version, deliberately.

## Repository map

```text
apps/capture-web/          static ambient browser application
apps/clinician-review/     documentation-only future surface
packages/ambient-core/     deterministic face and voice extractors
packages/contracts/        v3 runtime schemas plus capture provenance types
packages/evidence-core/    provenance validation and report builder
packages/event-log/        session-only workflow journal
services/voice-inference/  optional disconnected WavLM research service
agents/                    exactly three capability boundary documents
protocols/ and examples/   archival guided/v2 demo artifacts
```

See `docs/architecture.md`, `docs/safety.md`, and `docs/validation.md` before
changing an active boundary.
