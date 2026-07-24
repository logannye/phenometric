# Quantitative biomarker substrate — implementation plan

Date: 2026-07-24
Scope decision: **Layers 0–2** (no new Tier-3 metric codes)
Persistence decision: **Session RAM + explicit end-of-session export**

## Goal

Stop discarding what we already compute, and restructure the pipeline so that
clinical metrics become *views* over a retained substrate rather than the only
thing that survives capture.

## Design principle

**Store physical quantities, not clinical constructs.**

A construct ("House-Brackmann grade") is terminal. A quantity ("nasolabial
angle, left vs right, over time") recombines. Every clinical scale in the
literature is a function of quantities, so an archive of quantities can produce
any scale on demand — including scales published after the data was collected.
An archive of constructs can never be walked back.

The operational test for every decision in this plan: *if we learn in two years
that the right hypomimia measure is AU12 onset velocity rather than event rate,
can we recompute it on sessions already captured?*

## The three tiers

| Tier | Rate | Content | Boundary |
|---|---|---|---|
| 1 — Substrate | 100 Hz voice / analyzed cadence face | per-frame derived geometric + acoustic vectors | provider-side |
| 2 — Event | per blink / expression / breath-group | kinematic parameters | provider-side |
| 3 — Summary | per session | the existing 27 metrics, recomputed as views | crosses any boundary |

Tier 1 and Tier 2 stay provider-side, so **they need no `packages/contracts`
presence at all**. They live in `packages/ambient-core`, alongside the
`ExpressionEvent` type that already sets the precedent. This avoids
`ObservationV3Schema`'s ~150-line `superRefine`, the report machinery, and the
pack digest entirely.

## What already exists

Reconnaissance (2026-07-24, 8-agent sweep) established:

- **Tier 1 exists at runtime, unnamed.** `capture-runtime.ts:17-20` defines
  `DerivedCaptureSnapshot { voice: VoiceSignalFrameV1[], face:
  FacialKinematicsFrameV1[] }`. It accumulates every frame
  (`capture-runtime.ts:59-66`), deep-freezes at dispose (`:22-29, :95-97`), is
  consumed once at `main.ts:943-944`, then garbage collected. Roughly 70% built:
  the object is the right shape; it lacks channel breadth, a name, and a
  lifetime.
- **Tier 2 exists in one place, module-private.** `ExpressionEvent`
  (`expression-events.ts:58-69`) is a genuine kinematic record, reduced to two
  integers at `ambient-face.ts:821-822`. **Blinks have no event record at all**
  (`detectBlinks` returns `{count, perBinCounts}`, `ambient-face.ts:582-584`).
  Breath-groups exist transiently as the ordered `raw` run sequence
  (`ambient-voice.ts:321-327`), projected to two unordered duration arrays.
- **`packages/trajectory-core` is not a trajectory package.** It compares one
  session scalar against an *unordered bag* of priors (bucketed
  `trajectory.ts:341-344`, reduced to median/MAD `:392-396`); `occurredAt` is an
  admissibility filter (`:320`), never an axis. Built on superseded v2
  contracts, emits `workflow-event.v0.2` envelopes the live journal cannot
  accept (`event-log/src/journal.ts:184` writes `.v1`). Zero importers.
  `README.md:190` already labels it disconnected legacy.

## Prerequisite

**PR #25 (`feat/brow-and-eye-closure`) must land first.** This plan branches
from it. Building on an unmerged branch creates a stack, and stacked-PR merges
in this setup have a known failure mode where merging the base closes the
children. Merge #25 to main, then branch fresh.

---

## Layer 0 — foundations and fixes

No contract changes. All eight workstreams are independent and parallelizable.

### 0a. Real FFT primitive (`voice-dsp.ts`)

Radix-2 real FFT, pure function, fully tested. Note this is a *performance win*,
not a cost: the existing 16-band naive DFT burns 2×16×320 sin/cos evaluations
per frame ≈ 1.02M/s at 100 fps (`voice-dsp.ts:343-355`).

### 0b. Window functions, pre-emphasis, anti-aliased decimation

Prerequisite for CPPS and formants. **There is no window function anywhere in
the repo today**, and the existing `pitchInput` path is box-decimated to 8 kHz
with no anti-alias filter (`voice-dsp.ts:82-105`) — so formant analysis must
branch off `centered` (`:371-374`), not off `pitchInput`.

### 0c. Face geometry expansion (`face-features.ts:20-41`)

`FACE_LANDMARK_INDICES` currently holds 22 indices with a maximum of 387.
**Iris indices 468–477 are read nowhere.**

1. **Verify first**: confirm landmarks 468–477 are actually populated with
   non-degenerate values. `FACE_MESH_LANDMARK_COUNT = 478`
   (`face-mesh-renderer.ts:4`) and `face-mesh-gl.ts:62-77` carries an iris index
   set, which implies yes — but no read has confirmed it, and there is zero
   derivation code. If they are degenerate, `refineLandmarks` may need enabling
   and the whole iris workstream re-costed.
2. Palpebral fissure height **and** width — derivable from the existing canthi
   (362/263, 33/133) plus lid pairs. The only planned face addition needing no
   new landmarks; do this one first.
3. Nasolabial fold angle (alar base → mouth corner vector). The most visible
   palsy sign clinically and present in every palsy scale.
4. Midline / philtral deviation.
5. Iris-derived: gaze vector, pupil diameter, iris centre relative to lid.

All pure functions, tested in the existing `face-features.test.ts` style.

### 0d. Tier-2 record types (`ambient-core`, types only)

Type definitions with no extraction logic yet, so Layer 2 can be written against
a frozen shape.

### 0e. Delete legacy

Remove `packages/trajectory-core` and the superseded v2 contracts
(`contracts/src/{trajectory,observation,event,measurement}.ts`) plus the dead
`calibration.ts:95-184` block. All are git-tracked and recoverable.

Two side benefits: this removes the last consumer of `createEventFactory`, and
it drops the `AudioPipelineProvenance` literal-typed `analysisWindowMs: 40 /
analysisHopMs: 10 / ringBufferSeconds: 2` constraint (`observation.ts:59-69`)
that would otherwise block any future window/hop change.

### 0f. Fix the provenance holes — **before** anything is added

The abstention discipline degrades superlinearly with metric count. Fix it while
it is small:

1. `report.ts:190-196` — `if (actual === undefined) continue;` silently skips 11
   pack-declared requirements. Convert to an explicit error.
2. `report.ts:145-147` + `ambient-core-adapter.ts:298-303` — `eventCount =
   Math.max(pauseCount, speechRunCount, nucleusCount, blinkCount)` conflates
   four distinct counters, so a voice pause-count gate is currently satisfiable
   by syllable count. **Adding blink and expression event counts to this same
   `max` makes it strictly worse** — a face event count could clear a voice
   gate. This is the most likely way the new tiers quietly break "abstain rather
   than assert."
3. Wire the two facts that are computed, used for the withhold decision, and
   never written to evidence: `cadenceHz` (`ambient-face.ts:751`) and
   `p95Gaps(...)` (`:770`). One line each.
4. Add a pack → `evidenceFactFor` exhaustiveness test, mirroring the one that
   already exists on the ambient-core side (`ambient-metrics.test.ts:121-190`).
   The guard is currently one-sided: pack → ambient-core is enforced; pack →
   evidence-core is not.

### 0g. Protocol-pack digest regeneration script — **mandatory**

The digest is hand-pasted hex (`ambient-protocol.ts:43-44`) computed by a
bespoke recursive key-sort canonicalizer (`:575-587`, not JCS). The only
enforcement is a single vitest assertion (`contracts-v3.test.ts:29`), and the
runtime check at `evidence-core/report.ts:335-341` is self-referential — the
only live caller passes the pack to itself (`main.ts:1018`). A wrong digest
ships to the browser and stamps every ObservationV3.

This is mandatory in this pass, not deferred: the export decision requires
updating the consent document, whose SHA is a field *inside* the pack
(`ambient-protocol.ts:62-64`), which changes the pack's own `contentSha256`.

### 0h. Fix cross-bin expression stitching

`ambient-face.ts:811` concatenates `screening.bins.flatMap(...)` and
`detectExpressionEvents` (`expression-events.ts:157`) sorts by `tMs` **with no
gap check** — so an expression event can be stitched across a rejected-bin hole
of arbitrary length. Blink detection guards this (`ambient-face.ts:603-617`);
expression detection does not.

Must land before Layer 2b builds on `ExpressionEvent`.

---

## Layer 1 — frame schema extension (atomic, sequential)

One commit. All version bumps move together:

- `primitives.ts:9-37` (`VoiceSignalFrameV1`) and `:63-105`
  (`FacialKinematicsFrameV1`)
- `VOICE_SIGNAL_FRAME_VERSION`, `VOICE_DSP_ALGORITHM_VERSION`,
  `VOICE_DSP_PROCESSOR_REF` (`voice-worker-protocol.ts:12,16,18`)
- `FACIAL_KINEMATICS_SCHEMA_VERSION` (`face-features.ts:16-17`),
  `FACE_LANDMARKER_GEOMETRY_VERSION` (`face-worker-protocol.ts:18-19`)
- `voice-dsp.test.ts:77-86` locks the exact key set of `VoiceWindowAnalysis` and
  will fail by design on any added field

A `processorRef` bump splits ambient voice segments mid-stream
(`ambient-voice.ts:265`), so it must be a build-time change, never mid-session.

### New voice frame fields

Spectral band energies (promoted from the previous-frame flux state they
currently die in, `voice-dsp.ts:338-357`), `spectralFlux` (computed at
`voice-dsp.ts:382-391`, used for VAD, never placed on the frame), CPPS, and F1/F2
estimates. `rms` already exists on the frame and needs only to be *read*.

### New face frame fields

The 0c derivations, plus per-hemiface geometric Action Unit intensities.

**Head pose needs no frame change** — `FacialPose` is already on the frame. It
is used only as a boolean gate and a 0.2 quality weight (`ambient-face.ts:213-228`,
`:485-503`). The work is retention downstream, not capture.

### Two hard constraints

**Build on the raw frame stream, not on gated bins.** `ambient-face.ts:316` is
`frames.every(ambientFrameUsable)` — one bad frame discards 80–150 good frames.
If Tier 1/2 inherit that gate, a single glitch causes total loss of a 5 s window
and retroactive recomputation becomes impossible, defeating the entire design
principle. Per-frame quality annotation instead; gating stays in the Tier-3 view.

**Hold the geometric-AU line.** MediaPipe blendshapes are already computed and
discarded (`face-worker.ts:290` → `:489`). They are the tempting free path to
"Action Unit intensities" and they are wrong for us twice over: banned by name
in the frame-level privacy regex, and — more importantly — blendshape rigs are
trained for avatar retargeting and carry a **symmetry prior** that suppresses
exactly the asymmetry we measure. Set `outputFaceBlendshapes: false` and reclaim
the compute.

### Privacy regex compliance

Three regexes at three levels, and Tier-2 field names must survive all of them:

| Level | Site | Forbids |
|---|---|---|
| Frame | `primitives.test.ts:28` | `faceLandmarks`, `meshConnections`, `overlayPixels`, `offscreenCanvas`, `screenshot`, `blendshapes`, `transformationMatrix`, `deviceId`, `deviceLabel` |
| Face frame | `face-features.test.ts:351-357` | `/landmarks/i` |
| Outcome | `ambient-metrics.test.ts:197` | `pcm`, `waveform`, `landmarks`, `mouthCorners`, `eyeAperture`, `imageBitmap`, `embedding`, `voiceprint` |

Practical consequences: name blink fields `lidAperture*`, not `eyeAperture*`.
Name iris fields `gazeVector` / `pupilDiameter` / `irisCentre`, never
`irisLandmarks`.

### Tremor band feasibility — OUTCOME: not shipped in this pass

Resolved by not shipping it. The arithmetic below stands, the measurement that
would settle it does not exist yet, and the frame rate was deliberately left at
`{ ideal: 30 }` (`main.ts:391`).

Raising the request to 60 fps doubles decode and inference load. Whether that
raises or *lowers* the analyzed cadence — the quantity tremor actually depends
on — is a property of the target device, and changing the request without
measuring would be the same unvalidated assertion this section warns about.

What did change: `cadenceHz` and `p95FrameGapMs` are now written onto the
evidence of every face metric (0f), so the distribution of real delivered
cadence becomes visible from ordinary sessions. That is the measurement. Once
enough real sessions exist to characterise it, this decision can be made on
data:

- delivered cadence comfortably above 24 Hz → the 5–8 Hz band is reachable,
  8–12 Hz still needs 60 fps
- delivered cadence near the 16 Hz floor → tremor is out of reach on this
  capture path regardless of band, and the honest answer is to say so

Until then no tremor band is emitted, which is the correct behaviour: an
aliased number in the 8–12 Hz band would be indistinguishable from a real one.

### Original analysis

`AMBIENT_FACE_MIN_SAMPLES_PER_BIN = 80` over a 5000 ms bin = **16 Hz minimum
accepted cadence → 8 Hz Nyquist**. The planned 8–12 Hz band is unmeasurable at
the accepted floor and 5–8 Hz sits on the edge. Inter-frame gaps up to 200 ms are
accepted (`ambient-face.ts:330-336`), i.e. 5 Hz instantaneous, so sampling is
**non-uniform** and a naive periodogram is invalid.

Actions:
1. Measure actual delivered cadence (never established by reconnaissance).
2. Raise the requested frame rate from 30 to 60 fps where supported
   (`face-worker-protocol.ts:189`).
3. Use Lomb-Scargle, or explicit resampling with a gap-coverage gate.
4. **Emit each tremor band only when measured cadence supports it; abstain
   per-band otherwise.** Do not silently emit an aliased 8–12 Hz number.

---

## Layer 2 — event extraction

Three families, parallelizable once the Layer 1 schema freezes.

### 2a. Blink events

Rewrite `detectBlinks` as a **per-eye finite state machine**. This fixes a
latent measurement gap as a side effect: closure currently requires *both* eyes
below threshold simultaneously (`ambient-face.ts:620-622`), so a unilateral
blink or unilateral incomplete closure is never counted — precisely the case
facial palsy produces.

Retain per blink: onset time, closing velocity, closed dwell, opening velocity,
closure depth, inter-blink interval, per-eye asymmetry. `elapsed` is already
computed and dropped (`ambient-face.ts:629-642`).

The payoff is four indications from one waveform: reduced *rate* (hypomimia),
delayed *opening* (myasthenia), incomplete *closure depth* (palsy), and
closing/opening *velocity ratio* (dystonia).

### 2b. Expression events

Promote and export `ExpressionEvent`; add rise time, dwell, and decay tau — the
temporal signature separating flaccid from synkinetic movement, currently
discarded by keeping only the peak frame (`expression-events.ts:178-201`).
Record events dropped for being <300 ms or >10 s rather than discarding them
silently. Depends on 0h.

### 2c. Breath-group and pause events

Restructure `internalRuns` (`ambient-voice.ts:321-327`) to retain the ordered
run sequence — the rhythm time-series — rather than projecting to two unordered
duration arrays (`:328-342`). Retain pauses outside the current [200, 1999] ms
filter (`:335`); hesitation pauses ≥2 s are presently invisible.

**Split breath pauses from hesitation pauses.** One detector, two clinical
channels: respiratory load and cognitive retrieval, from the same event stream.

Depends on fixing VAD hysteresis first — `voice-worker.ts:188-192` is a pure
per-frame decision at 100 Hz with no hangover, which produces 10 ms runs.

---

## Export artifact

At session end, the substrate and event tiers can be exported as an explicit
artifact. Requirements:

- **No browser storage.** The e2e assertion at
  `ambient-smoke.spec.ts:175-182` (`localStorage: 0, sessionStorage: 0,
  indexedDatabases: 0`) stays true and stays enforced.
- Export is explicit and user-initiated, never automatic.
- Consent text updated to disclose it → new consent SHA → new pack
  `contentSha256` → pack version 3.0.0 → **3.1.0**. Requires 0g.
- Serialization schema lives in `ambient-core`, not `contracts`.

---

## Verification

Each layer must pass before the next begins:

1. `tsc --noEmit` clean across all packages (LSP diagnostics in this repo have
   been unreliable — trust only real `tsc`).
2. Full unit suite.
3. Browser e2e — note port 4173 collides with a running dev server; kill only
   the specific PID from `lsof -ti tcp:4173`.
4. The three privacy regex tests, explicitly re-read after Layer 1.
5. The pack parity test (`ambient-metrics.test.ts:121-190`).
6. Determinism: same input frames → identical substrate, events, and metrics.

## Out of scope

- New Tier-3 metric codes and the 10-step pack widening (deferred Layer 3).
- Cross-session persistence and longitudinal linkage (deferred Layer 4).
- rPPG — highest ceiling, highest chance of failing validation; separate spike.
- Transcription, speaker diarization, speaker embeddings — a different consent
  and privacy posture, to be taken deliberately or not at all.
- Resurrecting `trajectory-core`.

## Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Implementer reaches for the free blendshape coefficients | Set `outputFaceBlendshapes: false` in Layer 1; geometric AU only |
| R2 | Hand-pasted digest ships wrong | 0g script, mandatory before the consent change |
| R3 | `eventCount` conflation worsens as event types are added | 0f, before Layer 2 |
| R4 | Tremor bands aliased at 16 Hz accepted cadence | Measure, raise to 60 fps, per-band abstention |
| R5 | Substrate built on gated bins loses whole windows | Build on raw frame stream + per-frame annotation |
| R7 | Memory unmeasured: 300 s × 100 Hz × ~24 voice fields, plus face | Measure during Layer 1; cap or stream if needed |
| R8 | `event-log` looks like a Tier-2 home but its append is O(n²) (`journal.ts:189`) | Tier 2 does not go through the workflow journal |
