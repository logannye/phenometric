# Clinician Evidence Card

## Goal

Produce an inspectable artifact whose statements resolve to protocol-valid
measurements and evidence.

## Current implementation

The current milestone implements only the deterministic structured report in
`@phenometrix/evidence-core`. It validates ObservationV3 against the canonical
protocol pack, resolves measurement/window/aggregate provenance, orders the
eight report sections, and preserves the nonclinical boundary statement.

There is no LLM narrative, clinician approval/dismissal, durable review state,
trajectory input, persistence, or export. The `apps/clinician-review`
directory remains documentation-only.

## Hard boundary

The Evidence Card capability cannot create measurements, expand a permitted
claim, diagnose, classify progression, infer cause, propose treatment, sign,
order, prescribe, message a patient, or execute an action.
