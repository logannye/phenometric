# Facial Palsy Protocol Pack — Spontaneous Expression Measurement — Design

Status: Approved (design). Implemented 2026-07-24 (PRs #24, #25),
except where noted in §13.
Date: 2026-07-24
Supersedes: nothing. Specifies the "first protocol pack" decision recorded in
`docs/telehealth-platform-vision.md`.

> Nonclinical research prototype. Nothing in this document is a validated
> measurement, a diagnostic claim, or a medical device function. Every metric
> proposed here would ship with `clinicalValidation: "none"` until a
> prospective study says otherwise.

## 1. Summary

Select unilateral facial nerve palsy (Bell's palsy, Ramsay Hunt, post-surgical
CN VII injury) as the first clinical protocol pack, and measure it through
**spontaneous facial expression captured ambiently** rather than through
elicited movement.

Two headline measures, referenced against a resting baseline:

1. **Spontaneous excursion asymmetry** — left-versus-right peak displacement
   during naturally occurring expression events.
2. **Oculo-oral synkinesis index** — eye-aperture change coupled to mouth
   excursion within those same events.

The resting-symmetry metrics the prototype already computes become the baseline
these are measured against, rather than the product.

## 2. Why this indication

The facial metrics have a statistical property no voice metric has: **left
minus right is a within-frame contrast**. Same camera, same lighting, same
distance, same instant, same face. The confounds that make cross-visit voice
comparison fragile — different microphone, different room, different
interlocutor, different topic — apply identically to both hemifaces and cancel
in the difference.

The effect sizes are gross geometry rather than subtle statistical shifts.
Complete flaccid palsy displaces the oral commissure on the order of 5–10 mm
(≈0.08–0.16 inter-eye units) and widens the resting palpebral fissure by
roughly 1–3 mm (a 10–30% relative change in eye-aperture ratio). That is one to
two orders of magnitude above any plausible effect in the voice set.

The incumbent instruments are weak. House-Brackmann and Sunnybrook are
examiner-scored ordinal scales with well-documented inter-rater variability.
The bar to clear is low.

## 3. Why spontaneous, and why that requires ambient capture

Spontaneous (emotional) and volitional facial movement run on different neural
pathways — volitional through corticobulbar/pyramidal routes, emotional
extrapyramidally through basal ganglia and limbic routes. Dissociation between
them is a classic clinical sign in both directions.

The consequence for product design is decisive:

**Spontaneity cannot be elicited.** Asking a patient to smile makes the
movement volitional by definition. An ambient capture is not a cheaper
approximation of a task-based measurement — for this construct it is the only
valid method, and every task-based system is structurally blind to it.

Facial reanimation surgery is the clearest example of a field that needs this
and lacks an instrument: cross-facial nerve grafting aims to restore a
spontaneous smile, while masseteric nerve transfer produces a stronger but
volitional-only smile requiring the patient to clench. Outcome reporting leans
on patient-reported measures because no objective measure of spontaneity
exists.

**Accepted cost:** this does not reproduce House-Brackmann or Sunnybrook.
Roughly 80 of Sunnybrook's ~100 points are voluntary excursion. We are defining
a different construct and must not claim equivalence to those scales. Resting
symmetry is a real Sunnybrook subscale; voluntary excursion is not measured
here at all.

## 4. Goals and non-goals

### Goals

- Signed, side-labelled resting asymmetry (which side, and in which direction).
- Detection of spontaneous expression events from landmark geometry alone.
- Per-event, side-separated excursion referenced to a within-session baseline.
- An oculo-oral synkinesis index that distinguishes aberrant regeneration from
  recovery.
- Per-eye closure completeness, for unilateral lagophthalmos.
- Brow/frontalis measurement, to support the upper- versus lower-motor-neuron
  distinction.
- Head-pose estimation as an abstention gate on every face metric.

### Non-goals

- Reproducing or claiming equivalence to House-Brackmann, Sunnybrook, or eFACE.
- Emotion recognition, affect inference, or any emotional-state label.
- Any elicited or prompted movement task.
- Diagnosis, severity grading against population norms, or prognosis.
- **Acute stroke screening.** See §10.

## 5. Measurement design

The governing rule: **every published measure is a within-face, within-event
ratio or signed difference. No absolute excursion is reported as a clinical
quantity.**

Expression amplitude is hopelessly confounded — a warm clinician elicits more
and larger smiles than a brusque one, and a polite acknowledgement is not a
laugh. But amplitude confounds act on both hemifaces equally, so they cancel in
a left/right contrast for the same reason they cancel at rest.

### 5.1 Resting baseline

Computed from frames not belonging to an expression event, gated on head pose.

- Signed commissure position, left and right, inter-eye normalized.
- Signed palpebral fissure height, left and right.
- Signed brow height, left and right.

Sign convention establishes the **affected side** for the session, which every
downstream measure depends on.

### 5.2 Expression event detection

Detected geometrically in-worker, from cached landmarks:

- bilateral commissure elevation beyond a threshold above the resting baseline;
- concurrent mouth widening;
- optional orbicularis oculi involvement recorded as a Duchenne marker.

Explicitly **not** an emotion classifier. The event is a named facial movement
pattern, and no affective label is produced, stored, or exported. This
distinction is a deliberate boundary, not an implementation detail.

### 5.3 Spontaneous excursion asymmetry

Per event, peak displacement from baseline is computed for each side. Across
events the session reports a **distribution** (median and p90), not a mean —
event intensity varies and the upper part of the distribution carries the
signal about achievable excursion.

### 5.4 Oculo-oral synkinesis index

A Duchenne smile normally narrows both eyes; eye narrowing during smiling is
not itself pathological. The pathological signature is *disproportionate*
narrowing on the affected side relative to the mouth movement producing it:

```
synkinesis_index =
    (Δeye_aperture_affected   / Δmouth_excursion_affected)
  − (Δeye_aperture_unaffected / Δmouth_excursion_unaffected)
```

Again a within-face contrast, and again dependent on the affected side
established in §5.1.

### 5.5 The clinical logic this exists to support

This is the reason the pack is designed around events rather than aggregates:

| Asymmetry magnitude | Synkinesis index | Interpretation |
|---|---|---|
| falling | flat | consistent with recovery |
| falling | rising | **aberrant regeneration — not recovery** |
| flat / rising | flat | persistent flaccid weakness |

In the 15–30% of Bell's palsy cases that do not recover fully, aberrant
regeneration beginning around months 3–6 produces a hypertonic orbicularis
oculi: the affected eye narrows and the commissure over-corrects. **Asymmetry
magnitude falls.** A system reporting only unsigned asymmetry would read that as
improvement at exactly the point the patient needs chemodenervation and
neuromuscular retraining.

Signed asymmetry plus a synkinesis index is what prevents that misreading. It
is a patient-safety requirement, not a feature.

## 6. New primitives required

| Primitive | Why | Note |
|---|---|---|
| Head pose (yaw/pitch/roll) | ~10° of yaw induces apparent asymmetry comparable to a mild palsy; contamination is worst during events, because people move their heads when they laugh | Abstention gate, not a published metric |
| Brow/frontalis landmarks | Forehead sparing is the discriminator between central and peripheral facial weakness | Safety-relevant; see §10 |
| Signed, side-labelled asymmetry | Unsigned magnitude cannot distinguish droop from contracture | Extends existing metrics |
| Per-eye blink and closure completeness | Unilateral lagophthalmos is the corneal risk; a bilateral-AND detector renders it as a global blink-rate collapse | Replaces bilateral-only blink |
| Expression event segmentation | Prerequisite for §5.3 and §5.4 | New in-worker stage |

## 7. Contract and protocol-pack implications

- A new protocol pack version. `ProtocolPackV1Schema` pins `metrics` to exactly
  16 (`.length(16)`) and the report sections to a fixed 8-tuple; both change.
- New report section for expression dynamics.
- Existing withheld reason codes `insufficient-events` and `pose-out-of-range`
  already cover the dominant abstention paths and should be reused rather than
  extended.
- `AmbientMetricEvidence` gains event-count evidence; the adapter must emit the
  corresponding quality facts. See the `minimumTimingCoverage` defect for what
  happens when a published evidence requirement has no emitted fact behind it.
- The protocol pack's SHA-256 content digest changes, which is the intended
  mechanism: sessions measured under different packs are not comparable and the
  digest makes that structurally visible.

## 8. Privacy analysis

The boundary is unchanged and must stay unchanged.

- Event detection runs **in-worker** on cached landmarks, which already never
  cross to the main thread. No new native data crosses any boundary.
- Emitted values remain scalars: counts, ratios, signed differences.
- **No per-event timeline is exported.** A fine-grained record of when a person
  smiled during a medical conversation is closer to behavioural surveillance
  than to a measurement. Sessions emit aggregate distribution statistics and
  evidence windows on the existing model, nothing finer.
- No affective label is produced at any stage (§5.2).

## 9. Abstention

Abstention becomes more common under this design, and that is correct.

- Sessions with too few expression events return `insufficient-events`. No
  imputation, no partial credit, no "estimated from resting posture".
- Pose-contaminated frames are excluded before baseline and event measurement;
  sessions failing the gate return `pose-out-of-range`.
- A session yielding a resting baseline but no events reports the resting
  metrics and withholds the event-derived ones. Partial results are normal.

Abstention here is load-bearing: a patient who does not smile during a visit is
common and unremarkable, and the system must say so rather than infer.

## 10. Explicit safety firewall — acute stroke

**Do not build acute stroke screening on this pack.**

A missed stroke is catastrophic and indefensible. Facial droop is one of three
FAST items, so the temptation is structural and will recur. Two reasons it must
be refused:

1. The discriminator between central and peripheral facial weakness is
   **forehead sparing**, and until brow/frontalis landmarks exist it is not
   measurable at all. Even once they exist, sensitivity adequate for an acute
   triage decision is a far higher bar than trend measurement.
2. The capture is ambient, unsupervised, and quality-gated to abstain — the
   opposite of the properties an acute screening instrument needs.

This should be recorded as a written product boundary, not left as an absence.

## 11. Validation

Unchanged from the platform evidence ladder, with one indication-specific note:
the within-face contrast means these metrics have a *different and more
favourable* noise structure than the voice metrics, because the dominant
cross-visit confounds cancel. That is a reason to expect better test-retest
performance — not a reason to skip measuring it.

The prerequisite remains: **within-subject test-retest reliability and minimal
detectable change under the real ambient protocol**, per metric, before any
trend claim. A slope means nothing without a noise floor.

Indication-specific validation would additionally require:

- concurrent examiner grading (Sunnybrook/eFACE) at each session, understanding
  that we are measuring a related but non-identical construct;
- longitudinal capture spanning the months 3–6 window where synkinesis emerges,
  since that transition is the measure's main clinical justification;
- explicit subgroup testing across skin tone, facial hair, eyewear, and camera
  hardware.

## 12. Decisions recorded

1. Facial palsy is the first protocol pack. Confirms the ordering already
   recommended in the platform vision.
2. Measurement is via spontaneous expression, captured ambiently. No elicited
   task block, for this pack or as a general escape hatch.
3. Equivalence to House-Brackmann/Sunnybrook is explicitly not claimed.
4. All published measures are within-face contrasts; absolute excursion is
   never a clinical quantity.
5. Signed, side-labelled asymmetry replaces unsigned magnitude.
6. Synkinesis detection is in scope from the start, as a safety requirement.
7. Expression events are geometric; emotion inference is barred.
8. Per-event timelines are not exported.
9. Acute stroke screening is a written product boundary.

## 13. Not addressed here

- Regional/zonal grading beyond eye, commissure, and brow (nasolabial fold,
  nasal ala, lower lip depressor).
- Spontaneous-versus-volitional dissociation as its own reported measure, which
  would require a volitional comparison this pack deliberately does not collect.
- Multi-visit persistence and trajectory, which remain unimplemented platform-wide.
