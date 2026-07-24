# Ambient Biomarker Capture — Capability #1 redesign

**Status:** Accepted; deterministic headless core implemented, live ingestion
and interface planned
**Date:** 2026-07-18
**Supersedes:** the scripted "Guided Capture" definition of Capability #1 in
`docs/architecture.md` and `README.md`.

> **Implementation status, 2026-07-21.** Live local ingestion, deterministic
> extraction, ObservationV3, an in-memory workflow journal, and the structured
> report are now implemented. This milestone is intentionally narrower than
> the future-state design below: it has no durable measurement store, retained
> evidence snippets, trajectory wiring, generated narrative, clinician review,
> persistence, or export. Those passages remain design intent, not current
> runtime behavior.

> **Research prototype only.** Not a medical device. Not for diagnosis,
> treatment, emergency detection, or use with protected health information.

## Standing design principle

> **Minimize features. Beautifully execute a handful of core agentic
> capabilities.**

PhenoMetrix stays deliberately small. Every proposed change must strengthen one of
the existing capabilities or a required safety foundation. No new product
capability, agent, service, or UI surface is added without an explicit,
documented scope decision. When in doubt, defer it. Polish over breadth.

## Vision

Autonomously capture, extract, and quantify measurements of clinical
significance to neurological function and degeneration, so that they are
recorded for **each patient visit** and can be **meaningfully compared and
trended across months and years** of ongoing telehealth management.

The clinician simply talks with and focuses on the patient. A team of
specialized subagents analyzes the live audiovisual feed in the background,
quantifies neurological digital biomarkers from whatever moments are genuinely
measurable, and stays silent on the rest.

## The reframe (what changes and why)

Capability #1 was a deliberate, participant-facing script (a standardized speech
sample and a finger-tapping sample) that the patient completed on cue. This
redesign replaces that with **pure ambient capture**: no instructed tasks of any
kind. Every measurement is derived from unprompted speech and behavior during
the routine patient–clinician conversation.

This inverts three things:

1. **Interaction model.** The system must never interrupt the patient. The
   clinician owns the interaction. The old "agentic moment"
   (`pause → coach → verify → resume`) is gone.
2. **Quality control.** It flips from *correction* (fix bad framing) to
   *curation* (find measurable windows in an uncontrolled stream, abstain on the
   rest). `not measurable` becomes the default state of most of the timeline.
3. **The unit of measurement.** An instructed `Task` no longer exists. It is
   replaced by a *detected* `MeasurementContext`.

## Organizing principle: ephemeral capture, permanent measurements

> The raw conversation is discarded frame-by-frame and never persisted. The
> derived measurements are the permanent record.

Each visit deposits one durable, versioned, confound-annotated measurement
record into the patient's longitudinal store. Years of trending become possible
**without ever storing years of video.** This is what makes the system
privacy-preserving and longitudinal for the same reason.

**Data handling:** ephemeral edge extraction plus a short in-memory rolling
buffer. Raw audiovisual data is analyzed in-process and never written to disk.
When the orchestrator flags a measurable window as evidentiary, only that short
snippet is promoted to a retained evidence clip (kept if the resulting claim is
grounded and clinician-accepted; discarded otherwise). Everything else is
released as it streams.

## Architecture

Chosen approach: **shared-primitive bus + orchestrator + deterministic
extractors.** Expensive primitives are computed once by a single ingestion layer
and published on an in-process event bus. Each extractor subagent subscribes only
to the primitives it needs. The language model stays entirely out of the
measurement loop; in the planned Capability #3, it may draft only grounded
evidence-card prose from structured facts.

Rejected alternatives:

- **Per-agent autonomous loops** (each agent taps the stream and does its own
  VAD/landmarking): double-computes expensive primitives, hard to align to one
  timeline, heaviest on a laptop. Worst for a real-time MacBook demo.
- **LLM-orchestrated measurement:** adds latency and nondeterminism to a
  real-time loop and violates the hard rule that the LLM never creates or gates
  measurements.

### The subagent team (four units, isolated boundaries)

| Unit | Kind | Responsibility | Hard boundary |
|---|---|---|---|
| **Ingestion & Primitives** | deterministic (not an agent) | Decode `MediaStream`; compute shared primitives once — voice-activity detection + a rolling audio-feature buffer, and a face-landmark mesh; publish on the in-process bus. | No measurement, no interpretation. |
| **Capture Conductor** (orchestrator) | agent | Detect measurable windows; gate the extractors; reconcile/dedupe measurements onto one timeline; run the rolling buffer and promote flagged snippets to evidence; emit abstentions. | Decides *when/whether* to measure, never *what a value means*. |
| **Speech-Acoustic extractor** | agent | Over voiced windows: articulation/speaking rate, pause frequency and duration, pitch variability (monotonicity), voice quality. Emit `Measurement`s tagged with detected context and confidence, or abstain. | Measure only; never interpret disease. |
| **Facial-Expressivity extractor** | agent | Over well-framed windows: facial expressivity/hypomimia, blink rate, brow/smile amplitude. Emit `Measurement`s or abstain. | Measure only; never interpret disease. |

The two extractors are independent and communicate only through the bus. A future
modality (gaze, head/limb motor) would be added as another subscriber without
touching the existing units. Adding one is a scope decision, not a default.

## Contract changes

These are the concrete impacts on the shared contracts in `packages/contracts`.

- **`Task` / `TaskInstance` is removed** and replaced by **`MeasurementContext`**
  — a *detected* elicitation condition (e.g. `spontaneous-speech`,
  `sustained-vowel`, `reading-aloud`, `listening/expressive`) plus a **confound
  envelope** (SNR, lighting, face framing/distance, off-axis angle, observed
  frame rate).
- **`Measurement` gains** `contextRef`, `confidence`, `windowStart`/`windowEnd`,
  and an optional `evidenceSnippetRef` (present only when the Conductor promoted
  the window). It keeps `algorithmVersion`, `uncertainty`, and
  `clinicalValidation` from the current model.
- **`CaptureQuality` becomes per-window**, not per-task, and it *drives
  abstention* rather than a bounded retry.
- **`EncounterObservation` becomes a per-visit aggregate.** For each biomarker
  and context it holds one robust aggregate value with uncertainty, computed
  across all measurable windows in the visit. The raw per-window measurements
  live underneath it for traceability. This aggregate is the trendable unit.
- **New `MeasurableWindow`** type and **abstention event types**.
- **`EncounterEvent` carries agent-lane identity** so the flight recorder can
  render one lane per subagent.

## Runtime data flow

```text
live feed ─▶ Ingestion & Primitives (VAD + audio buffer, face-landmark mesh)
          ─▶ [bus] ─▶ Speech-Acoustic agent ─┐
                   ─▶ Facial-Expressivity agent ┤─▶ per-window Measurements + abstentions
          ─▶ Capture Conductor: gate · reconcile · buffer→evidence-snippet
                   ─▶ per-visit ROBUST AGGREGATE (one value + uncertainty per biomarker, per context)
                   ─▶ durable VisitRecord ──────────▶ Longitudinal Store (the asset)
                                                              │
                        synthetic prior visits ───────────────┤
                                                              ▼
                                              Personal Trajectory (trend across visits)
                                                              ▼
                                              Evidence Card ─▶ clinician accept/reject
                                                              ▼
                                              only accepted VisitRecords enter the trend
```

## Comparability and trending across months and years

Because there is no script, two mechanisms guarantee that a today-versus-two-years
comparison is honest. This is the hardest part of the design and the reason the
vision is achievable at all.

1. **Match on detected context, not prompt version.** Capability #2's
   compatibility rules re-key from "same prompt version" to **"same
   `MeasurementContext` + confound envelope within tolerance."** Trend
   `spontaneous-speech` against `spontaneous-speech`, `expressive-window` against
   `expressive-window`.
2. **Record and normalize confounds.** Every visit changes device, lighting,
   distance, network, and the patient ages. Each measurement carries its confound
   envelope so Capability #2 can normalize for capture conditions and
   **distinguish real biomarker drift from setup drift**, surfacing a
   comparability warning (or excluding the comparison) when conditions are out of
   tolerance.

Two safeguards carry over unchanged from the current design:

- **Algorithm versioning.** A value is only trended against same-version values,
  or through a validated bridge. Improving the extractors over the years must not
  silently corrupt an existing trend.
- **Hard interpretive boundary.** A trend is *provisional evidence*, never a
  progression or diagnosis claim. Personal Trajectory cannot declare progression,
  infer cause, or generate a treatment plan.

## Abstention and honest failure

Per-window quality gates drive abstention instead of retries. If a whole visit
yields too little measurable signal for a biomarker, the honest output is **"no
comparable value captured this visit"** — a gap in the trend, never a fabricated
point. A visit conducted in a dark room simply does not contribute a
facial-expressivity point. Abstention is a first-class, visible outcome.

## Safety and non-goals (revised)

This redesign is the explicit scope decision that `AGENTS.md` requires before
reversing a non-goal.

**Reversed** (with re-anchoring):

- "No continuous ambient recording" → continuous **analysis**, never continuous
  **recording**. Raw audiovisual data is never persisted.
- "No natural-conversation interpretation" → the system quantifies signal-level
  biomarkers from natural conversation. It does not interpret the *content* or
  meaning of the conversation, and transcripts/media remain data, never agent
  instructions.

**New:**

- **Continuous-analysis consent** from both parties, a visible **"analyzing, not
  recording"** indicator, revocable mid-visit.

**Unchanged and still load-bearing:**

- Deterministic measurement is separate from interpretation.
- Abstention over fabrication; quality failure returns `not measurable`.
- The planned language-model role is limited to drafting grounded prose from
  structured facts.
- Human sign-off gates the longitudinal record; only clinician-accepted visits
  enter history.
- No component both recommends and executes a consequential clinical action.
- No PHI, recordings, secrets, or generated media are committed to Git.

## Impact on the other capabilities

- **Capability #2 (Personal Trajectory):** compatibility rules re-key to detected
  context + confound envelope; it consumes per-visit aggregates and produces a
  trend across visits. Its interpretive boundary is unchanged.
- **Capability #3 (Clinician Evidence Card):** unchanged in principle. The
  "source clip" becomes a short promoted snippet from the continuous timeline
  rather than a scripted-task recording. Grounding and
  claim → measurement → snippet → event traceability are preserved.

The product still has exactly three capabilities. This redesign reshapes #1; it
does not add a fourth.

## Demo (hackathon)

The live demonstration is a multi-lane view of the subagent team measuring the
live feed in real time, with **truthful abstention as the centerpiece** (the
patient turns to a side monitor → the facial agent abstains while the speech
agent keeps measuring; a noise burst clips the mic → the speech agent abstains).

Then the **longitudinal reveal**: today's live visit lands as the newest point on
a months/years trend built from clearly labeled synthetic prior visits. The
evidence card assembles with claim-to-source traceability, and the clinician
accepts or rejects — only accepted visits join the trend.

The current visit is genuinely live. All prior longitudinal history is labeled
synthetic. Placeholder measurements are labeled as placeholders and are never
presented as validated biomarkers.

## Testing

- **Deterministic replay** of recorded feature-stream fixtures (not live people)
  for repeatable CI.
- **Abstention-correctness** cases (unmeasurable windows produce abstentions, not
  values).
- **Aggregate stability** (identical input yields the identical per-visit
  aggregate).
- **Comparability gating** (context mismatch and confound-out-of-tolerance are
  both excluded with explicit reasons).
- **Grounding-validator** tests for the evidence card.

## Explicit non-goals (unchanged intent, minimalism preserved)

No diagnosis or disease classification; no medication recommendations or
autonomous actions; no emergency/risk prediction; no continuous **recording**; no
conversation-content interpretation; no EHR integration; no foundation model; no
general-purpose digital twin; no additional extractor modalities beyond the two
core agents without a scope decision.

## Open questions to resolve during planning

- Exact per-biomarker aggregation method and uncertainty model.
- Confound-tolerance thresholds and the normalization approach.
- The in-browser primitive libraries (VAD, face landmarks) and their performance
  budget on the target MacBook.
- Evidence-snippet length and retention lifecycle details.
