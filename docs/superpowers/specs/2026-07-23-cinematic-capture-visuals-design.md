# Cinematic Live-Capture Visuals — Design

- **Date:** 2026-07-23
- **Status:** Approved (design); implementation not started
- **Author:** Logan Nye (with Claude)
- **Scope:** `apps/capture-web` presentation layer only

## 1. Summary

Make PhenoMetrix's live capture surface visually striking for in-person demos, without
touching a single byte of what the system measures, stores, or lets cross the worker
boundary. Three surfaces get an upgrade:

1. **Holographic-depth face mesh** — GPU-accelerated (WebGL2 in the worker), depth-shaded
   from real per-landmark `z`, iridescent cyan→violet, with additive bloom, glowing
   feature contours, twinkling landmark points, and drifting "data mote" particles.
2. **Multi-channel voice telemetry** — an instrument panel beside the video: two radial
   gauges (level, pitch) and three scrolling 8-second waveforms (level, pitch, clarity),
   plus SNR/agreement readouts and a voiced-state pill.
3. **Cinematic framing** — the live camera dimmed and cooled behind the mesh, and a
   subtle "come-into-focus" intro when tracking first localizes.

This is a **presentation-only** change. It is explicitly NOT a change to measurement,
quality gating, the `ObservationV3` / report pipeline, the privacy/retention contracts,
or the worker→main data boundary.

## 2. Goals & non-goals

**Goals**
- A demo-grade "wow" moment: the live mesh and voice analytics look like a
  graphics-intensive product, not a webcam debug overlay.
- GPU-accelerated rendering path (WebGL2 now), architected so WebGPU can slot in later.
- Preserve every existing invariant: no raw media, landmarks, blendshapes, matrices,
  PCM, or spectra ever leave the worker or enter any artifact.
- Respect `prefers-reduced-motion`; never let presentation failures affect capture.

**Non-goals (YAGNI)**
- No WebGPU implementation now (documented future path only).
- No whole-app visual redesign — the **capture stage** (preview + telemetry) only.
- No new metrics, no new data on any frame/observation/report/journal contract.
- No change to MediaPipe inference cadence, calibration, abstention, or the measurement
  math.

## 3. Current implementation (context)

- **Mesh (worker):** `apps/capture-web/src/face-worker.ts` runs MediaPipe
  `FaceLandmarker` and, on each analyzed frame, calls `FaceMeshOverlayRenderer.render()`
  (`apps/capture-web/src/face-mesh-overlay.ts`) which draws the 478-point tessellation +
  contours + dots on a **transferred `OffscreenCanvas` 2D context**, capped at
  `MAX_FACE_MESH_RENDER_HZ = 24`. Native landmarks/blendshapes/transform stay scoped to
  the synchronous `processFrame` turn; only `FacialKinematicsFrameV1` + bbox are posted.
  **There is no animation loop** — the mesh redraws only when a new frame arrives.
- **Voice (main thread):** `apps/capture-web/src/live-voice-visualizer.ts` receives
  `VoiceSignalFrameV1` scalars and draws two thin traces (energy, pitch) on 2D canvases
  via an injectable `AnimationScheduler`. `LiveVoiceHistory` keeps an 8-second window.
- **Layout/theme:** `apps/capture-web/index.html` + `apps/capture-web/src/styles.css`.
  `.preview-card` is already dark (`#18221f`); the app theme is otherwise light.
- **Available voice scalars** (`VoiceSignalFrameV1`): `tMs`, `rms`, `f0Hz`, `periodic`,
  `speechActive`, `snrDb`, `f0Confidence`, `estimatorAgreement`, `qualityReasons`.

## 4. Approved visual design

The look validated in the visual-companion session:

- **Palette / effects:** iridescent (cyan→violet, slow hue drift), lush particles, bloom
  glow, lively motion.
- **Depth:** near landmarks bright/large, far landmarks dim/small, driven by real
  `landmark.z` normalized per frame.
- **Video treatment:** dimmed live camera (brightness/saturation down, cool vignette) so
  the neon mesh dominates while the subject stays clearly visible ("it's you").
- **Localize intro:** a subtle come-into-focus — the mesh eases in from a soft bloom to
  crisp while the status pill quietly flips `◇ LOCATING…` → `◆ TRACKING · 478 pts`. No
  reticle, no flash, no lock banner.
- **Telemetry (beside the video):** `VOICE TELEMETRY` header + glowing voiced-state pill;
  two radial gauges (LEVEL dBFS, PITCH Hz/F0); three scrolling 8-s waveforms — **LEVEL**
  (mirrored energy envelope), **PITCH·F0** (line, breaks when unvoiced), **CLARITY**
  (`f0Confidence` filled area); readouts (SNR, agreement); "scalars only" boundary note.

Reference mockups (approved) persist in `.superpowers/brainstorm/*/content/` —
`final-look.html` is the capstone composition.

## 5. Architecture

### 5.1 `FaceMeshGLRenderer` (WebGL2, worker) — new `apps/capture-web/src/face-mesh-gl.ts`
- Attaches to the transferred `OffscreenCanvas` via `getContext('webgl2')`.
- Same public shape as `FaceMeshOverlayRenderer` (`attach`, `isAttached`, `clear`,
  `detach`, plus a `renderFrame(landmarks, taskContext, w, h, timeMs, introProgress)`),
  so `face-worker.ts` can hold either renderer behind one interface
  (`FaceMeshRenderer`).
- **Draw passes:**
  1. Tessellation edges as `GL_LINES`; per-vertex attribute = normalized depth; fragment
     color from the depth→iridescent ramp + a time-driven hue offset; additive blending.
  2. Landmark points as `GL_POINTS`; size/brightness scale with depth; per-point twinkle
     from a hashed phase.
  3. Feature contours (eyes/brows/lips/oval/nose/iris) as brighter line groups; iris as
     filled points.
  4. **Bloom:** render 1–3 to an FBO, downsample, 2-pass separable Gaussian blur, then
     additively composite over the base scene.
  5. **Motes:** a small GPU point buffer (CPU-updated positions seeded from mesh nodes;
     drift up + fade), rendered additively.
- **Intro uniform:** `uIntro` (0→1) modulates global alpha, a slight scale-in, and an
  extra bloom amount that eases to the resting value.
- **Depth normalization:** compute per-frame min/max of `landmark.z` over the visible set,
  map to 0..1 (near..far); a pure helper (`normalizeDepth`) unit-tested independently.

### 5.2 Worker animation loop (in `face-worker.ts`)
- Add a `requestAnimationFrame` loop (workers support rAF) that redraws from the **cached
  latest landmarks** + `performance.now()` at up to 60 fps, decoupled from ~24 Hz frame
  arrivals. `processFrame` updates the cache; the loop renders.
- Optional light temporal smoothing (lerp displayed landmarks toward the latest) for
  fluid motion between arrivals.
- **Privacy:** cached landmarks are retained **in-worker only**, never posted, and cleared
  on face-loss (`faceCount !== 1`), `clear-overlay`, `reset`, and `dispose`. This extends
  the existing "landmarks scoped to the sync turn" rule to "landmarks retained in-worker
  for redraw" — still never crossing the boundary.
- Loop starts on `attach-overlay`, stops on `detach`/`dispose`.

### 5.3 2D fallback (kept)
- `FaceMeshOverlayRenderer` (current 2D renderer) is retained as the fallback. Selection
  at attach time: try WebGL2; on failure use 2D. On `webglcontextlost` that cannot be
  restored, fall back to 2D for the remainder of the session. Mesh is presentation-only,
  so any renderer failure degrades gracefully and never affects measurement.

### 5.4 Voice telemetry (main thread) — extend `live-voice-visualizer.ts`
- Render: two radial gauges (LEVEL from `rms`→dBFS, PITCH from `f0Hz`), three scrolling
  waveforms (LEVEL mirror envelope, PITCH line with unvoiced gaps, CLARITY =
  `f0Confidence` area), readouts (`snrDb`, `estimatorAgreement`), voiced-state pill from
  `speechActive`/`periodic`.
- Extend `LiveVoiceHistory` to retain `f0Confidence` alongside level/pitch.
- Stays 2D canvas on the main thread (cheap); keeps the injectable `AnimationScheduler`
  for deterministic tests. GPU is unnecessary here.
- Pure helpers factored out and tested: `rmsToDbfs` (exists), gauge value mapping,
  waveform windowing/normalization.

### 5.5 Dimmed video + layout/theme
- Dim `#camera-preview` via CSS `filter: brightness(.6) saturate(.85) contrast(1.05)` +
  a cool vignette overlay layer, ordered under `#landmark-overlay`.
- Restyle telemetry markup in `index.html` and `styles.css` (gauge canvases, waveform
  canvases, readout grid, state pill). The capture stage adopts the dark cinematic
  treatment; welcome/report screens are unchanged (decision recorded in §8).

### 5.6 WebGPU (future path, not built)
- Progressive enhancement: prefer a WebGPU renderer when `navigator.gpu` is present, else
  WebGL2, else 2D. The `FaceMeshRenderer` interface makes this a drop-in third
  implementation. Deferred until there's a concrete need beyond WebGL2's ceiling.

## 6. Data flow (unchanged pipeline)

```
camera frame → face-worker (MediaPipe inference, ~24 Hz)
             → landmarks cached IN-WORKER (never posted)
             → worker rAF loop (≤60 Hz) → WebGL2 draw → transferred OffscreenCanvas
             → composited over dimmed #camera-preview on the main thread

mic → worklet → voice-worker → VoiceSignalFrameV1 scalars → main thread
    → voice telemetry (gauges + 3 waveforms + readouts)
```

The measurement path (`FacialKinematicsFrameV1` / `VoiceSignalFrameV1` →
`buildAmbientObservation` → `ObservationV3` → report) is untouched.

## 7. Privacy & safety (explicit preservation)

- No new field on any frame, observation, report, or journal contract.
- Landmarks, `z`, blendshapes, transforms, PCM, and spectra never leave the worker;
  telemetry uses only the scalars already emitted.
- The mesh canvas is still write-only in the worker; no pixel readback to main (the
  existing 64×64 quality-ROI readback in `face-worker.ts` is unchanged and unrelated).
- Disposal frees all GL resources (buffers, textures, FBOs, program) and clears cached
  landmarks on `dispose`/`detach`/face-loss/reset.

## 8. Decisions recorded

- **Renderer:** WebGL2 now (GPU-accelerated), WebGPU as documented future, 2D as fallback.
- **Dark treatment:** capture stage only; welcome/report unchanged.
- **Telemetry channels:** LEVEL, PITCH·F0, CLARITY(`f0Confidence`); readouts SNR + agreement.
- **Intro:** subtle come-into-focus + quiet status swap (no reticle/flash/banner).
- **Palette/effects:** iridescent · lush · bloom · lively.

## 9. Accessibility & performance

- `prefers-reduced-motion`: disable hue drift, motes, twinkle, and the intro; render a
  static legible mesh and static telemetry (respect the existing media query in
  `styles.css`).
- Target 60 fps on Apple M4; bloom at downsampled resolution, capped particle count, and a
  governor that sheds effects (particles → bloom → hue drift) under sustained load.
  Inference cadence stays ~24 Hz.

## 10. Error handling

- WebGL2 unavailable → 2D fallback at attach.
- `webglcontextlost` → `preventDefault`, pause rendering (hold last frame or show a "mesh
  paused" pill); on `webglcontextrestored` reinitialize GL resources; if restore fails,
  fall back to 2D.
- Presentation failures are isolated: they never throw into `processFrame`'s measurement
  path or the observation pipeline.

## 11. Testing

- **Unit (vitest):** pure helpers only — `normalizeDepth`, depth→color mapping, gauge
  value mapping, waveform windowing/normalization, intro easing, extended
  `LiveVoiceHistory`. Injected clock; no `Math.random` in tested paths (motes use a seeded
  PRNG or are treated as untested presentation).
- **Browser smoke (Playwright):** extend `apps/capture-web/e2e/ambient-smoke.spec.ts` to
  assert the overlay canvas attaches (WebGL2 in headless Chrome) and telemetry DOM updates
  during dual-lane capture. Assert graceful behavior if WebGL2 is forced off.
- Keep the existing 2D-fallback renderer tests (`face-mesh-overlay.test.ts`).

## 12. Files to create / modify

**Create**
- `apps/capture-web/src/face-mesh-gl.ts` — WebGL2 renderer + bloom pipeline.
- `apps/capture-web/src/face-mesh-gl.test.ts` — pure-helper tests (depth/color/easing).
- `apps/capture-web/src/voice-telemetry.ts` (or extend in place) — gauges + waveforms.
- Possibly `apps/capture-web/src/face-mesh-renderer.ts` — shared `FaceMeshRenderer`
  interface + WebGL2/2D selection.

**Modify**
- `apps/capture-web/src/face-worker.ts` — renderer selection, cached-landmark rAF loop,
  intro progress, disposal.
- `apps/capture-web/src/live-voice-visualizer.ts` — multi-channel telemetry (+ history).
- `apps/capture-web/index.html`, `apps/capture-web/src/styles.css` — dimmed video,
  telemetry markup, dark capture-stage treatment.
- `apps/capture-web/src/face-mesh-overlay.ts` — conform to the shared interface as the 2D
  fallback (behavior preserved).
- Docs: update `README.md` / `docs/architecture.md` capture-view description; keep the
  privacy-boundary language intact.

## 13. Future enhancements

- WebGPU renderer behind the same interface (progressive enhancement).
- Optional GPU-particle spectacle at 60 fps if a bigger demo moment is wanted.
- App-wide dark theme if the cinematic treatment should extend beyond the capture stage.
