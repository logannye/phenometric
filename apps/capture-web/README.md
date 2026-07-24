# Capture web application

This is the static ambient-v3 browser application.

## Runtime responsibilities

- record explicit session-local consent;
- request microphone and camera independently;
- verify the committed local asset manifest;
- run bounded voice and face calibration;
- maintain independent worker-backed capture lanes;
- draw a presentation-only 478-point face mesh and a bounded live voice signal
  dashboard during capture;
- collect compact derived frames for at most five minutes;
- finalize all 16 deterministic metrics into ObservationV3;
- validate and render the session-only structured report; and
- dispose devices, workers, timers, buffers, and journal state.

The application has no server route, API key, LLM, persistence layer, export,
guided task mode, or synthetic production capture mode.

## Worker boundaries

The voice worker receives PCM from the AudioWorklet and emits compact signal
frames. The face worker owns native MediaPipe results and emits compact
kinematics. It also draws the dense mesh directly to a transferred
`OffscreenCanvas`; landmark coordinates never return to the application. The
voice dashboard retains at most eight seconds/800 derived level and pitch
points and is cleared with the capture lifecycle. Neither live visualization
is application, ObservationV3, or report evidence.

## Commands

From the repository root:

```bash
pnpm dev
pnpm --filter @phenometrix/capture-web verify:assets
pnpm --filter @phenometrix/capture-web test:unit
pnpm --filter @phenometrix/capture-web typecheck
pnpm --filter @phenometrix/capture-web test:browser
pnpm --filter @phenometrix/capture-web build
```

The Playwright suite injects media and worker mocks with `page.addInitScript`.
Those fixtures are not compiled into the production application.

In development, open `http://127.0.0.1:4173/` in current Chrome. The browser UI
owns consent, capture start, end/discard, and reset. Stop the Vite process with
`Ctrl-C` when development is complete.
