# Validation

PhenoMetrix has technical verification only. Automated tests do not establish
analytical validity, clinical validity, clinical utility, or regulatory
fitness.

## Required commands

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm test:browser
pnpm demo:smoke
uv sync --project services/voice-inference --extra dev --locked
uv run --project services/voice-inference --extra dev pytest services/voice-inference/tests
git diff --check
```

`pnpm run check` validates the active ambient-v3 structure, exactly three
capability directories, absence of tracked media, required JSON manifests, and
the committed static-asset digests.

`pnpm test` runs all workspace unit tests, TypeScript typechecks, and the
production build. Browser and Python tests are separate because they have
different runtimes and CI jobs.

## Automated coverage

- voice and face quality thresholds and abstention;
- deterministic 7-voice/9-face metric registry ordering;
- exact reason-code projection and source-window intervals;
- strict ObservationV3, protocol, report, consent, evidence-ref, and workflow
  event schemas;
- canonical aggregate and measurement identities;
- provenance and report grounding;
- session journal ordering, causal boundaries, replay, and disposal;
- capture lifecycle races, teardown order, and bounded setup/session timers;
- asset-path and runtime digest verification;
- browser consent, permission denial, independent calibration, report display,
  no-upload/no-storage behavior, discard, withdrawal, and late-stream cleanup;
  and
- optional WavLM health, CORS, request validation, and transient summary output
  using a deterministic fake adapter.

## Manual hardware acceptance

In current Chrome on the target MacBook:

1. Complete one live camera-and-microphone session.
2. Confirm each lane calibrates or abstains independently.
3. Confirm the complete facial mesh tracks exactly one face and clears for zero
   or multiple faces.
4. Confirm quiet, unvoiced noise, and voiced speech produce the expected live
   voice state, energy response, and periodic-only pitch trace.
5. Confirm the end button is enabled only during ambient observation.
6. Verify both live displays clear and camera/microphone indicators turn off
   before the report appears.
7. Confirm the report contains exactly 16 terminal outcomes and eight sections.
8. Discard a second session and verify no report appears.
9. Confirm mid-session consent withdrawal is performed through Discard and
   verify that it stops all tracks.
10. Reset after a report and verify session-only state is cleared.

No live media or resulting health-related artifact may be saved or committed.

## Not validated

No metric has reference-standard accuracy, repeatability, normative ranges,
minimum detectable change, disease association, subgroup performance, or
clinical workflow evidence. Every active metric therefore remains
`clinicalValidation: "none"`.
