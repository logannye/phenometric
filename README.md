# PhenoMetric

> Nonclinical research prototype. Not a medical device. Not for diagnosis,
> treatment, emergency detection, or use with protected health information.

PhenoMetric is a local browser prototype for deriving bounded, quality-aware
face and voice engineering measurements during an ordinary conversation. It is
designed around a simple rule: measure only technically qualified signal,
report `Not measurable` otherwise, and dispose of the media before showing the
report.

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
  blendshapes, and transformation matrices remain inside that boundary. The
  worker draws its complete 478-point mesh and contours directly onto a
  transferred presentation canvas, while only compact
  `FacialKinematicsFrameV1` geometry and quality values are emitted.

Permission, calibration, measurement, and abstention are independent by
modality. One lane can continue when the other is unavailable.

### Active metric registry

The immutable `ambient-local-observation@1.0.0` protocol pack contains exactly
16 nonclinical metrics.

Voice (7):

- median fundamental frequency;
- fundamental-frequency variability;
- speech-activity fraction;
- pause rate;
- median pause duration;
- median speech-run duration; and
- acoustic nucleus rate estimate.

Face (9):

- left and right open-eye aperture;
- open-eye aperture asymmetry;
- mouth width;
- median and P90 mouth aperture;
- mouth-corner positional asymmetry;
- P90 regional landmark speed; and
- bilateral blink rate.

Every metric carries its unit, context, algorithm version, evidence
requirements, permitted withheld reasons, technical-verification status, and
`clinicalValidation: "none"`.

### Observation and report

`buildAmbientObservation()` converts extractor outcomes into the strict
`phenometric.encounter-observation.v3` schema. Each terminal metric outcome is
either measured or withheld and resolves to exact evidence windows, processor
and track provenance, and a deterministic aggregate identity.

`buildPostEncounterReport()` validates that provenance against the active
protocol pack and creates an eight-section structured report. The report is
screen-only, exists only in session memory, and has no narrative, review,
trajectory, persistence, or export shape.

## Capability status

PhenoMetric retains exactly three named product capabilities:

1. **Ambient Capture:** implemented as the local v3 prototype described above.
2. **Personal Trajectory:** a tested v2-only package retained for research, but
   not connected to the live application or v3 observation.
3. **Clinician Evidence Card:** represented today only by the deterministic
   structured report. Narrative drafting, clinician approval, and durable
   review state are not implemented.

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

`pnpm test` runs structure and static-asset checks, all unit tests, TypeScript
typechecking, and the production build. Browser smoke tests and the optional
Python service remain separate CI jobs.

## Repository map

```text
apps/capture-web/          static ambient browser application
apps/clinician-review/     documentation-only future surface
packages/ambient-core/     deterministic face and voice extractors
packages/contracts/        v3 runtime schemas plus temporary v2 compatibility
packages/evidence-core/    provenance validation and report builder
packages/event-log/        session-only workflow journal
packages/trajectory-core/  disconnected legacy v2 trajectory package
services/voice-inference/  optional disconnected WavLM research service
agents/                    exactly three capability boundary documents
protocols/ and examples/   archival guided/v2 demo artifacts
```

See `docs/architecture.md`, `docs/safety.md`, and `docs/validation.md` before
changing an active boundary.
