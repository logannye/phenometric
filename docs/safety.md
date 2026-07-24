# Safety foundations

## Demonstration boundary

PhenoMetric is a nonclinical engineering prototype. It must not be used for
diagnosis, treatment, emergency detection, progression classification,
population screening, or decisions about a person. It must not process PHI.

## Required behavior

- Obtain explicit consent before requesting devices.
- Request camera and microphone independently.
- Show when devices are active and when they are off.
- Treat identity and speaker attribution as unverified.
- Process native media locally and ephemerally.
- Emit only compact derived frames across worker boundaries.
- Keep live face and voice visualizations presentation-only, bounded, and
  coupled to device teardown.
- Require versioned protocol, algorithm, processor, track, and evidence
  provenance for every measurement.
- Prefer a specific `Not measurable` outcome over imputation or a generic
  quality result.
- Stop all tracks and processors before showing a report.
- Clear derived frames and workflow events on discard, withdrawal, reset, or
  reload.

## Forbidden active-observation data

ObservationV3 and the report must never contain raw audio/video, device labels
or identifiers, PCM, waveforms, FFT bins, cepstra, MFCCs, formants,
spectrograms, transcripts, embeddings, voiceprints, native face landmarks,
blendshapes, transformation matrices, bitmaps, screenshots, mesh pixels, media
streams, or worker-owned canvases.

## Measurement boundary

The active protocol contains only deterministic engineering measurements. A
value may be emitted only after its metric-specific evidence and quality gates
pass with exact processor and track attribution. Otherwise the extractor emits
a registered withheld reason.

No metric has clinical validation. Interface copy must not convert a metric,
quality score, absence, or trajectory into a disease or treatment statement.

## Retention boundary

The current application keeps derived measurements, report data, and workflow
events only in memory for the current page session. It does not write local
storage, IndexedDB, a server, a retained clip, or an export file. The accepted
ambient design discusses possible future durable measurements and snippets;
those are not implemented in this milestone.

The live voice chart holds no PCM and at most eight seconds of derived display
points. The face mesh is drawn on a worker-owned canvas without returning
native landmarks. Both displays clear when capture stops and are excluded from
ObservationV3 and report contracts.

## Optional WavLM service

The restored WavLM sidecar is a separate research-only service. It is disabled
by default, loopback-only, accepts no file path or URL, does not log request
bodies, and retains neither PCM nor returned summaries. The browser does not
call it, and its output is not an active metric or evidence artifact.

## Refused capability: acute stroke screening

Acute stroke screening must not be built on this system, and this is recorded
as a standing boundary rather than left as an absence—facial droop is one of
three FAST items, so the idea is structurally recurrent and will be proposed
again.

Two reasons, either sufficient:

1. The discriminator between central and peripheral facial weakness is
   forehead sparing. No brow or frontalis measurement exists, so the
   distinction cannot be made at all. Even once those landmarks exist,
   sensitivity adequate for an acute triage decision is a far higher bar than
   the trend measurement this system is designed for.
2. Capture is ambient, unsupervised, and deliberately quality-gated to abstain.
   Those are the opposite of the properties an acute screening instrument
   requires, and abstention in an emergency context is itself a hazard.

A missed stroke is catastrophic and indefensible. No configuration, protocol
pack, or downstream consumer may present a facial asymmetry measurement as
stroke triage information.

## Deferred governance

Authentication, authorization, PHI handling, durable audit logs, retention
policy, incident response, clinical validation, human review, EHR integration,
and regulated deployment controls must be designed before any production or
clinical use.
