# PhenoMetrix operator guide

## Environment

- macOS with current Chrome;
- Node.js 22 or newer;
- pnpm 9.12.3; and
- localhost or HTTPS for camera and microphone access.

The browser application has no runtime environment variables and no server
credential. Do not add an API key or PHI to `.env` files.

## Install and run

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:4173` in Chrome.

## Rehearsal

1. Confirm the welcome page says **Nonclinical prototype** and **No recording
   or upload**.
2. Read the consent statement and check the box.
3. Allow the microphone and camera. Stay quiet briefly, face the camera, and
   wait for independent lane states.
4. Confirm the dense facial mesh follows one face. Speak, make an unvoiced
   sound, and pause; confirm energy responds continuously while pitch appears
   only for periodic sound.
5. Continue a normal conversation; do not perform scripted exercises. Treat
   the live voice panel as a signal preview, not report output.
6. End the session and verify that the mesh and voice history clear and local
   finalization precedes report display.
7. Inspect a measured and a not-measurable metric, including its exact reason
   and evidence references.
8. Clear and start again, then verify the report and prior session state are
   gone.

Also rehearse camera denial, microphone denial, both-device denial, and
discard, which is also the in-session consent-withdrawal path.

## Automated smoke

```bash
pnpm demo:smoke
```

The Playwright fixture replaces browser APIs only inside the test page. The
production bundle has no synthetic-capture query mode.

## Optional WavLM research service

The sidecar is not required for the demo and the browser does not call it. To
test it independently:

```bash
uv sync --project services/voice-inference --extra dev --locked
uv run --project services/voice-inference --extra dev pytest services/voice-inference/tests
```

Follow `services/voice-inference/README.md` only for isolated research use. It
must remain disabled by default and bound to loopback.

## Common failures

- **Asset integrity failure:** run `pnpm --filter @phenometrix/capture-web
  verify:assets`; rebuild the manifest only after intentionally reviewing an
  asset change.
- **Permission denied:** reset the site permission in Chrome and start a new
  session.
- **Lane remains not measurable:** use quieter audio, even front lighting, one
  face, and keep the tab visible. Never force a measurement.
- **Mesh display unavailable:** use current Chrome with hardware acceleration
  enabled. Face extraction may continue even when the presentation canvas is
  unavailable.
- **Energy moves but pitch is blank:** pitch intentionally appears only for a
  sufficiently periodic signal; noise and unvoiced sound create pitch gaps.
- **No report:** both devices were unavailable, the session was discarded, or
  final provenance validation failed. Inspect the browser console without
  weakening the gate.
