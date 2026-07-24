# Cinematic Live-Capture Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PhenoMetrix's live capture surface a GPU-accelerated holographic-depth face mesh and a multi-channel voice telemetry panel, dimmed video, and a subtle localize intro — a presentation-only upgrade that changes nothing about measurement or the privacy boundary.

**Architecture:** The face mesh moves to a WebGL2 renderer inside the existing face worker, driven by a new worker-side `requestAnimationFrame` loop over cached landmarks (decoupled from ~24 Hz inference); the current 2D renderer is retained as an automatic fallback. Voice telemetry stays on the main thread, extending `LiveVoiceVisualizer` into gauges + waveforms. All new visuals read only data that already exists on the current side of every boundary.

**Tech Stack:** TypeScript (strict, NodeNext ESM), Vite, WebGL2 via `OffscreenCanvas.getContext('webgl2')`, Vitest (unit), Playwright + system Chrome (browser smoke), MediaPipe Tasks Vision (already present).

## Global Constraints

Every task's requirements implicitly include this section. Values copied from `docs/superpowers/specs/2026-07-23-cinematic-capture-visuals-design.md`.

- **Presentation-only.** No change to measurement, quality gating, `ObservationV3`/report, calibration, abstention, or any contract in `packages/contracts` / `packages/ambient-core`.
- **Privacy boundary unchanged.** No new field on any worker message, frame, observation, report, or journal contract. Native landmarks / `z` / blendshapes / transforms / PCM / spectra never leave the worker; telemetry uses only fields already on `VoiceSignalFrameV1`. The mesh canvas stays write-only in the worker (no pixel readback added).
- **No new runtime dependencies.** WebGL2 is a platform API; do not add npm packages.
- **Node `>=22`, pnpm `9.12.3`** (repo `package.json`). Local import specifiers use the `.js` extension (NodeNext).
- **Reduced motion:** honor `prefers-reduced-motion: reduce` — disable hue drift, particles, twinkle, and the intro; render a static, legible mesh + static telemetry. The existing CSS `@media (prefers-reduced-motion)` only kills CSS animation, so JS `matchMedia` gating is required.
- **Performance:** target 60 fps on Apple M4; degrade gracefully. MediaPipe inference cadence stays ~24 Hz — the rAF loop only redraws presentation, never re-runs inference.
- **Scope:** capture stage only (preview + telemetry). Welcome/report screens unchanged.
- **Worker message protocol version stays `phenometric.visual-worker-message.v2`** — the intro is computed in-worker, so no protocol change is needed.
- **Commands:** unit `pnpm --filter @phenometrix/capture-web test:unit`; typecheck `pnpm --filter @phenometrix/capture-web typecheck`; build `pnpm --filter @phenometrix/capture-web build`; browser `pnpm --filter @phenometrix/capture-web test:browser`; full gate `pnpm test`.

---

## Phase 0 — Shared interface + pure helpers

### Task 1: Depth normalization + color ramp helper

**Files:**
- Create: `apps/capture-web/src/mesh-depth.ts`
- Test: `apps/capture-web/src/mesh-depth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeDepth(zValues: readonly number[]): number[]` — maps each `z` to `0..1` where `1` = nearest (smallest `z`; MediaPipe `z` is more-negative = closer to camera), `0` = farthest. All-equal or empty input → all `0.5`. Non-finite entries → `0.5`.
  - `depthToColor(depth: number, hueShiftDeg: number): { r: number; g: number; b: number }` — iridescent cyan→violet ramp in `0..1` channels. `depth` clamped to `0..1`; `hueShiftDeg` rotates the ramp for time animation.

- [ ] **Step 1: Write the failing test**

```ts
// apps/capture-web/src/mesh-depth.test.ts
import { describe, expect, it } from "vitest";
import { depthToColor, normalizeDepth } from "./mesh-depth.js";

describe("mesh depth", () => {
  it("maps nearest z (most negative) to 1 and farthest to 0", () => {
    const out = normalizeDepth([-0.1, 0, 0.1]);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(0);
  });

  it("returns 0.5 for empty, all-equal, or non-finite input", () => {
    expect(normalizeDepth([])).toEqual([]);
    expect(normalizeDepth([2, 2, 2])).toEqual([0.5, 0.5, 0.5]);
    expect(normalizeDepth([Number.NaN, 0])[0]).toBeCloseTo(0.5);
  });

  it("produces channels in [0,1] and shifts hue deterministically", () => {
    const c = depthToColor(0.5, 0);
    for (const v of [c.r, c.g, c.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(depthToColor(0.5, 40)).not.toEqual(depthToColor(0.5, 0));
    expect(depthToColor(2, 0)).toEqual(depthToColor(1, 0)); // clamped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/mesh-depth.test.ts`
Expected: FAIL — cannot resolve `./mesh-depth.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/capture-web/src/mesh-depth.ts

/** HSL→RGB with h in degrees, s/l in 0..1. Returns channels in 0..1. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: r + m, g: g + m, b: b + m };
}

/**
 * Map raw MediaPipe landmark z-values to a 0..1 depth where 1 is nearest the
 * camera (most-negative z) and 0 is farthest. Non-finite, empty, or all-equal
 * inputs collapse to 0.5 so shading stays neutral rather than NaN.
 */
export function normalizeDepth(zValues: readonly number[]): number[] {
  const finite = zValues.filter((z) => Number.isFinite(z));
  if (finite.length === 0) {
    return zValues.map(() => (zValues.length ? 0.5 : 0.5)).slice(0, zValues.length);
  }
  let min = Infinity;
  let max = -Infinity;
  for (const z of finite) {
    if (z < min) min = z;
    if (z > max) max = z;
  }
  const span = max - min;
  return zValues.map((z) => {
    if (!Number.isFinite(z) || span <= 1e-9) return 0.5;
    // most-negative z (min) -> nearest -> 1
    return 1 - (z - min) / span;
  });
}

/** Iridescent cyan(≈190°)→violet(≈275°) ramp by depth, rotated by hueShiftDeg. */
export function depthToColor(
  depth: number,
  hueShiftDeg: number
): { r: number; g: number; b: number } {
  const d = Math.max(0, Math.min(1, depth));
  const hue = 190 + d * 85 + hueShiftDeg;
  const lightness = 0.42 + d * 0.28;
  return hslToRgb(hue, 0.92, lightness);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/mesh-depth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/capture-web/src/mesh-depth.ts apps/capture-web/src/mesh-depth.test.ts
git commit -m "feat(capture-web): depth normalization + iridescent color ramp"
```

---

### Task 2: Localize-intro timing helper

**Files:**
- Create: `apps/capture-web/src/localize-intro.ts`
- Test: `apps/capture-web/src/localize-intro.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `INTRO_DURATION_MS = 1_100`.
  - `class LocalizeIntro` with `start(nowMs: number): void` (idempotent — ignores re-start while running or after completion until `reset`), `progress(nowMs: number): number` (0 before start; eases 0→1 over `INTRO_DURATION_MS`; 1 after), `isActive(nowMs: number): boolean`, `reset(): void`.
  - `smoothstep(t: number): number` (clamped `3t²−2t³`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/capture-web/src/localize-intro.test.ts
import { describe, expect, it } from "vitest";
import { INTRO_DURATION_MS, LocalizeIntro, smoothstep } from "./localize-intro.js";

describe("localize intro", () => {
  it("smoothstep is clamped and eased", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBeCloseTo(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
  });

  it("returns 0 before start, eases to 1, then holds", () => {
    const intro = new LocalizeIntro();
    expect(intro.progress(1_000)).toBe(0);
    intro.start(1_000);
    expect(intro.progress(1_000)).toBe(0);
    expect(intro.progress(1_000 + INTRO_DURATION_MS / 2)).toBeGreaterThan(0);
    expect(intro.progress(1_000 + INTRO_DURATION_MS / 2)).toBeLessThan(1);
    expect(intro.progress(1_000 + INTRO_DURATION_MS)).toBe(1);
    expect(intro.progress(9_999_999)).toBe(1);
  });

  it("ignores re-start until reset, and reset re-arms it", () => {
    const intro = new LocalizeIntro();
    intro.start(0);
    intro.start(500); // ignored while running
    expect(intro.progress(INTRO_DURATION_MS)).toBe(1);
    expect(intro.isActive(INTRO_DURATION_MS + 1)).toBe(false);
    intro.reset();
    expect(intro.progress(10)).toBe(0);
    intro.start(10);
    expect(intro.progress(10)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/localize-intro.test.ts`
Expected: FAIL — cannot resolve `./localize-intro.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/capture-web/src/localize-intro.ts

export const INTRO_DURATION_MS = 1_100;

export function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Tracks the one-shot "come-into-focus" intro that plays when the mesh first
 * localizes to a face. Time is injected (no wall-clock inside) so it is
 * deterministic and testable, and so the worker can drive it from its own clock.
 */
export class LocalizeIntro {
  private startedAtMs: number | null = null;

  start(nowMs: number): void {
    if (this.startedAtMs !== null) return;
    this.startedAtMs = nowMs;
  }

  progress(nowMs: number): number {
    if (this.startedAtMs === null) return 0;
    return smoothstep((nowMs - this.startedAtMs) / INTRO_DURATION_MS);
  }

  isActive(nowMs: number): boolean {
    return this.startedAtMs !== null && this.progress(nowMs) < 1;
  }

  reset(): void {
    this.startedAtMs = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/localize-intro.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/capture-web/src/localize-intro.ts apps/capture-web/src/localize-intro.test.ts
git commit -m "feat(capture-web): localize-intro timing helper"
```

---

### Task 3: Shared `FaceMeshRenderer` interface + adapt the 2D renderer

**Files:**
- Create: `apps/capture-web/src/face-mesh-renderer.ts`
- Modify: `apps/capture-web/src/face-mesh-overlay.ts`
- Test: `apps/capture-web/src/face-mesh-overlay.test.ts` (existing — must stay green)

**Interfaces:**
- Consumes: `FaceMeshRenderInput`, `FaceMeshRenderResult` (moved here from `face-mesh-overlay.ts`).
- Produces:
  ```ts
  export interface FaceMeshRenderer {
    attach(canvas: OffscreenCanvas, maxRenderHz: number): boolean;
    isAttached(): boolean;
    updateLandmarks(input: FaceMeshRenderInput): void; // cache latest for the draw loop
    drawFrame(nowMs: number, introProgress?: number): FaceMeshRenderResult; // draw cached
    clear(): void;
    detach(): void;
  }
  ```
  `FaceMeshOverlayRenderer` implements it. `render(input)` is kept as a thin wrapper (`updateLandmarks(input); return drawFrame(input.acquiredAtMs, 1)`) so existing tests are unchanged.

- [ ] **Step 1: Create the shared interface module**

```ts
// apps/capture-web/src/face-mesh-renderer.ts
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { VisualTaskContext } from "@phenometrix/contracts";

export const FACE_MESH_LANDMARK_COUNT = 478;

export interface FaceMeshRenderInput {
  landmarks: readonly NormalizedLandmark[];
  taskContext: VisualTaskContext;
  width: number;
  height: number;
  acquiredAtMs: number;
}

export interface FaceMeshRenderResult {
  rendered: boolean;
  landmarkDots: number;
  tessellationEdges: number;
  accentAnchors: number;
}

/** Presentation-only renderer contract shared by the 2D and WebGL2 backends. */
export interface FaceMeshRenderer {
  attach(canvas: OffscreenCanvas, maxRenderHz: number): boolean;
  isAttached(): boolean;
  /** Cache the latest landmark frame; does not draw. */
  updateLandmarks(input: FaceMeshRenderInput): void;
  /** Draw the cached frame at nowMs with optional intro progress (0..1). */
  drawFrame(nowMs: number, introProgress?: number): FaceMeshRenderResult;
  clear(): void;
  detach(): void;
}

export const EMPTY_RESULT: FaceMeshRenderResult = {
  rendered: false,
  landmarkDots: 0,
  tessellationEdges: 0,
  accentAnchors: 0
};
```

- [ ] **Step 2: Refactor `face-mesh-overlay.ts` to implement the interface**

In `apps/capture-web/src/face-mesh-overlay.ts`:
1. Remove the local `FACE_MESH_LANDMARK_COUNT`, `FaceMeshRenderInput`, `FaceMeshRenderResult` definitions and instead import them:
   ```ts
   import {
     EMPTY_RESULT,
     FACE_MESH_LANDMARK_COUNT,
     type FaceMeshRenderer,
     type FaceMeshRenderInput,
     type FaceMeshRenderResult
   } from "./face-mesh-renderer.js";
   ```
   Keep re-exporting `FACE_MESH_LANDMARK_COUNT` and the two types so the existing test's imports (`FACE_MESH_LANDMARK_COUNT`, `MAX_FACE_MESH_RENDER_HZ`, `faceMeshPresentationEligible`) still resolve:
   ```ts
   export { FACE_MESH_LANDMARK_COUNT } from "./face-mesh-renderer.js";
   export type { FaceMeshRenderInput, FaceMeshRenderResult } from "./face-mesh-renderer.js";
   ```
2. Declare the class implements the interface and add a cached-input field:
   ```ts
   export class FaceMeshOverlayRenderer implements FaceMeshRenderer {
     private canvas: OffscreenCanvas | null = null;
     private context: OffscreenCanvasRenderingContext2D | null = null;
     private maxRenderHz = MAX_FACE_MESH_RENDER_HZ;
     private lastRenderedAtMs: number | null = null;
     private latest: FaceMeshRenderInput | null = null;
   ```
3. Add `updateLandmarks` and `drawFrame`, and replace the body of the existing `render` with a wrapper. Move the current drawing body into `drawFrame`:
   ```ts
   updateLandmarks(input: FaceMeshRenderInput): void {
     this.latest = input;
   }

   render(input: FaceMeshRenderInput): FaceMeshRenderResult {
     this.updateLandmarks(input);
     return this.drawFrame(input.acquiredAtMs, 1);
   }

   drawFrame(nowMs: number, _introProgress = 1): FaceMeshRenderResult {
     const input = this.latest;
     const canvas = this.canvas;
     const context = this.context;
     if (!input || !canvas || !context) return EMPTY_RESULT;
     // ... existing body, but replace every `input.acquiredAtMs` throttle
     //     comparison with `nowMs`, and set `this.lastRenderedAtMs = nowMs;`
   }
   ```
   The throttle check becomes: `if (this.lastRenderedAtMs !== null && nowMs - this.lastRenderedAtMs < minimumIntervalMs) return EMPTY_RESULT;`. Everything else (width/height guards use `input.width`/`input.height`; drawing loops; result counts) is unchanged. Because `render(input)` passes `input.acquiredAtMs` as `nowMs`, the existing throttle test (`1_000`, `1_041`, `1_042`) still holds.

- [ ] **Step 3: Run the existing 2D renderer tests**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/face-mesh-overlay.test.ts`
Expected: PASS (all existing tests unchanged — `render()` wrapper preserves behavior).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @phenometrix/capture-web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/capture-web/src/face-mesh-renderer.ts apps/capture-web/src/face-mesh-overlay.ts
git commit -m "refactor(capture-web): shared FaceMeshRenderer interface; 2D renderer implements it"
```

---

## Phase 1 — Voice telemetry panel (main thread)

### Task 4: Telemetry math — confidence history + gauge/waveform mapping

**Files:**
- Modify: `apps/capture-web/src/live-voice-visualizer.ts`
- Test: `apps/capture-web/src/live-voice-visualizer.test.ts` (extend)

**Interfaces:**
- Consumes: `VoiceSignalFrameV1` (from `@phenometrix/ambient-core`).
- Produces (new exports from `live-voice-visualizer.ts`):
  - `LiveVoiceSample` gains `confidence: number` (0..1, clamped).
  - `levelGaugeFraction(levelDbfs: number): number` — maps `-60..0 dBFS` → `0..1`.
  - `pitchGaugeFraction(pitchHz: number | null): number` — maps `MIN_LIVE_PITCH_HZ..MAX_LIVE_PITCH_HZ` → `0..1`; `null` → `0`.

- [ ] **Step 1: Write the failing tests (append to the existing describe block)**

```ts
// add to apps/capture-web/src/live-voice-visualizer.test.ts imports:
import {
  LiveVoiceHistory,
  LiveVoiceVisualizer,
  MAX_LIVE_VOICE_SAMPLES,
  levelGaugeFraction,
  pitchGaugeFraction,
  liveVoiceStateFor,
  rmsToDbfs,
  type AnimationScheduler,
  type LiveVoiceElements
} from "./live-voice-visualizer.js";

// add these tests inside describe("live voice visualization", ...):
it("records clamped confidence on each history sample", () => {
  const history = new LiveVoiceHistory();
  const samples = history.add(frame({ f0Confidence: 0.73 }));
  expect(samples.at(-1)?.confidence).toBeCloseTo(0.73);
  expect(history.add(frame({ tMs: 10, f0Confidence: 5 })).at(-1)?.confidence).toBe(1);
  expect(history.add(frame({ tMs: 20, f0Confidence: -1 })).at(-1)?.confidence).toBe(0);
});

it("maps level and pitch onto 0..1 gauge fractions", () => {
  expect(levelGaugeFraction(0)).toBeCloseTo(1);
  expect(levelGaugeFraction(-60)).toBeCloseTo(0);
  expect(levelGaugeFraction(-30)).toBeCloseTo(0.5);
  expect(pitchGaugeFraction(null)).toBe(0);
  expect(pitchGaugeFraction(60)).toBeCloseTo(0);
  expect(pitchGaugeFraction(400)).toBeCloseTo(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/live-voice-visualizer.test.ts`
Expected: FAIL — `levelGaugeFraction`/`pitchGaugeFraction` not exported; `confidence` undefined.

- [ ] **Step 3: Implement**

In `apps/capture-web/src/live-voice-visualizer.ts`:
1. Extend the sample type and history derivation:
   ```ts
   export interface LiveVoiceSample {
     tMs: number;
     levelDbfs: number;
     pitchHz: number | null;
     confidence: number;
   }
   ```
   In `LiveVoiceHistory.add`, add to the pushed object:
   ```ts
   confidence: Number.isFinite(frame.f0Confidence)
     ? Math.max(0, Math.min(1, frame.f0Confidence))
     : 0
   ```
2. Add the mapping helpers:
   ```ts
   /** -60..0 dBFS -> 0..1 (clamped). */
   export function levelGaugeFraction(levelDbfs: number): number {
     if (!Number.isFinite(levelDbfs)) return 0;
     return Math.max(0, Math.min(1, (levelDbfs + 60) / 60));
   }

   /** MIN..MAX live pitch Hz -> 0..1; null -> 0. */
   export function pitchGaugeFraction(pitchHz: number | null): number {
     if (pitchHz === null || !Number.isFinite(pitchHz)) return 0;
     const span = MAX_LIVE_PITCH_HZ - MIN_LIVE_PITCH_HZ;
     return Math.max(0, Math.min(1, (pitchHz - MIN_LIVE_PITCH_HZ) / span));
   }
   ```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/live-voice-visualizer.test.ts`
Expected: PASS (existing + 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/capture-web/src/live-voice-visualizer.ts apps/capture-web/src/live-voice-visualizer.test.ts
git commit -m "feat(capture-web): telemetry confidence history + gauge mapping helpers"
```

---

### Task 5: Telemetry rendering — gauges, waveforms, markup, wiring

**Files:**
- Modify: `apps/capture-web/src/live-voice-visualizer.ts` (render gauges + 3 waveforms + readouts)
- Modify: `apps/capture-web/index.html` (telemetry markup)
- Modify: `apps/capture-web/src/styles.css` (telemetry styling)
- Modify: `apps/capture-web/src/main.ts` (new `LiveVoiceElements` ids)
- Test: `apps/capture-web/src/live-voice-visualizer.test.ts`

**Interfaces:**
- Consumes: `levelGaugeFraction`, `pitchGaugeFraction`, extended `LiveVoiceSample` (Task 4).
- Produces: `LiveVoiceElements` gains `levelGauge: HTMLCanvasElement`, `pitchGauge: HTMLCanvasElement`, `clarityCanvas: HTMLCanvasElement`. The three waveform canvases become `energyCanvas` (LEVEL), `pitchCanvas` (PITCH), `clarityCanvas` (CLARITY). The panel now renders two gauges + three scrolling waveforms + readouts. Text-element ids and their update contract are unchanged.

- [ ] **Step 1: Replace the capture-view voice-panel markup in `index.html`**

Replace the `<section class="live-voice-panel" ...>...</section>` block (currently lines ~103–128, containing `.live-panel-heading`, the two `.voice-chart-block`s, `.voice-live-values`, and `#voice-quality-state`) with:

```html
<section class="live-voice-panel" aria-labelledby="live-voice-title">
  <div class="live-panel-heading">
    <div>
      <h2 id="live-voice-title">Voice telemetry</h2>
      <p>Preview only · not report values</p>
    </div>
    <strong id="voice-live-state" data-state="waiting">Waiting for signal</strong>
  </div>
  <div class="voice-gauges">
    <canvas id="voice-level-gauge" aria-label="Live level gauge"></canvas>
    <canvas id="voice-pitch-gauge" aria-label="Live pitch gauge"></canvas>
  </div>
  <div class="voice-wave">
    <div class="voice-wave-head"><span>Level</span><b id="voice-level-value">—</b></div>
    <canvas id="voice-energy-chart" aria-label="Live microphone level history"></canvas>
  </div>
  <div class="voice-wave">
    <div class="voice-wave-head"><span>Pitch · F0</span><b id="voice-pitch-value">—</b></div>
    <canvas id="voice-pitch-chart" aria-label="Live periodic pitch history"></canvas>
  </div>
  <div class="voice-wave">
    <div class="voice-wave-head"><span>Clarity · confidence</span><b id="voice-confidence-value">—</b></div>
    <canvas id="voice-clarity-chart" aria-label="Live F0 confidence history"></canvas>
  </div>
  <dl class="voice-live-values">
    <div><dt>SNR</dt><dd id="voice-snr-value">—</dd></div>
    <div><dt>Agreement</dt><dd id="voice-agreement-value">—</dd></div>
  </dl>
  <p id="voice-quality-state" class="voice-quality-state">No live signal yet.</p>
</section>
```

Notes: `#voice-level-value` / `#voice-pitch-value` / `#voice-confidence-value` move into the waveform headers (still updated by the visualizer's existing text writes). `#voice-snr-value` / `#voice-agreement-value` remain in the readout list. All nine text/canvas ids the constructor binds still exist.

- [ ] **Step 2: Update the `LiveVoiceElements` binding in `main.ts`**

In `main.ts` (the `new LiveVoiceVisualizer({...})` at ~line 103), replace with:

```ts
const liveVoiceVisualizer = new LiveVoiceVisualizer({
  levelGauge: element<HTMLCanvasElement>("voice-level-gauge"),
  pitchGauge: element<HTMLCanvasElement>("voice-pitch-gauge"),
  energyCanvas: element<HTMLCanvasElement>("voice-energy-chart"),
  pitchCanvas: element<HTMLCanvasElement>("voice-pitch-chart"),
  clarityCanvas: element<HTMLCanvasElement>("voice-clarity-chart"),
  state: element<HTMLElement>("voice-live-state"),
  level: element<HTMLElement>("voice-level-value"),
  pitch: element<HTMLElement>("voice-pitch-value"),
  snr: element<HTMLElement>("voice-snr-value"),
  confidence: element<HTMLElement>("voice-confidence-value"),
  agreement: element<HTMLElement>("voice-agreement-value"),
  quality: element<HTMLElement>("voice-quality-state")
});
```

- [ ] **Step 3: Extend the visualizer to render gauges + three waveforms**

In `live-voice-visualizer.ts`:
1. Extend `LiveVoiceElements`:
   ```ts
   export interface LiveVoiceElements {
     levelGauge: HTMLCanvasElement;
     pitchGauge: HTMLCanvasElement;
     energyCanvas: HTMLCanvasElement;
     pitchCanvas: HTMLCanvasElement;
     clarityCanvas: HTMLCanvasElement;
     state: HTMLElement;
     level: HTMLElement;
     pitch: HTMLElement;
     snr: HTMLElement;
     confidence: HTMLElement;
     agreement: HTMLElement;
     quality: HTMLElement;
   }
   ```
2. In `reset()`, also `clearCanvas` the three new canvases (`levelGauge`, `pitchGauge`, `clarityCanvas`) and set their `dataset.sampleCount` where applicable; in `push()`, write `clarityCanvas.dataset.sampleCount = String(samples.length)` alongside the existing two.
3. Replace `private render()` so it draws all five surfaces from the history snapshot:
   ```ts
   private render(): void {
     const samples = this.history.snapshot();
     drawTrace(this.elements.energyCanvas, samples, "energy");
     drawTrace(this.elements.pitchCanvas, samples, "pitch");
     drawTrace(this.elements.clarityCanvas, samples, "clarity");
     const latest = samples.at(-1);
     drawGauge(this.elements.levelGauge, latest ? levelGaugeFraction(latest.levelDbfs) : 0, "LVL");
     drawGauge(this.elements.pitchGauge, latest ? pitchGaugeFraction(latest.pitchHz) : 0, "F0");
   }
   ```
4. Extend `drawTrace`'s `kind` union to `"energy" | "pitch" | "clarity"`; add a `clarity` branch that draws a filled area from `sample.confidence` (0..1 → y). Add a `drawGauge(canvas, fraction, label)` helper (270° arc + value fill; a self-contained 2D routine). Keep all drawing in 2D canvas; keep `prepareCanvas`/`drawGrid` as-is. These draw calls are exercised by the existing spy-fixture test (each `drawTrace` calls `stroke`).

- [ ] **Step 4: Add the telemetry CSS**

In `styles.css`, replace the `.voice-chart-block*` rules with dark telemetry styling and add gauge/wave rules (place near the existing `.live-voice-panel` block):

```css
.live-voice-panel { display: grid; gap: .7rem; padding: .9rem; border-radius: 16px; background: linear-gradient(180deg, #0a0a1e, #06060f); border: 1px solid rgba(140,128,255,.2); color: #dfe6ff; }
.live-voice-panel h2 { color: #eaf1ff; }
.live-panel-heading p { color: #8b97c8; }
.live-panel-heading > strong { background: rgba(120,130,170,.18); color: #aeb8d6; }
.live-panel-heading > strong[data-state="voiced"] { background: rgba(88,240,200,.14); color: #7ff0cf; box-shadow: 0 0 14px rgba(90,240,200,.35); }
.live-panel-heading > strong[data-state="speech-noise"] { background: rgba(150,120,255,.16); color: #c3b0ff; }
.live-panel-heading > strong[data-state="unavailable"] { background: rgba(148,98,10,.2); color: #ffe2a8; }
.voice-gauges { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.voice-gauges canvas { display: block; width: 100%; aspect-ratio: 1 / .8; }
.voice-wave { background: #080815; border: 1px solid rgba(140,128,255,.14); border-radius: 12px; padding: .4rem .55rem .3rem; }
.voice-wave-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: .18rem; }
.voice-wave-head span { font: 600 .58rem/1 ui-monospace, monospace; letter-spacing: .09em; color: #8b97c8; }
.voice-wave-head b { font: 700 .78rem/1 ui-monospace, monospace; font-variant-numeric: tabular-nums; color: #e9ecff; }
.voice-wave canvas { display: block; width: 100%; height: 44px; }
.voice-live-values { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: 0; border-radius: 10px; overflow: hidden; background: rgba(140,128,255,.14); border: 1px solid rgba(140,128,255,.14); }
.voice-live-values div { background: #080815; padding: .5rem .6rem; }
.voice-live-values dt { color: #8b97c8; font: 600 .58rem/1 ui-monospace, monospace; letter-spacing: .08em; }
.voice-live-values dd { margin: .2rem 0 0; color: #e9ecff; font: 700 .9rem/1 ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.voice-quality-state { color: #7a83a8; font-size: .68rem; margin: 0; }
```

- [ ] **Step 5: Run unit tests + typecheck + build**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/live-voice-visualizer.test.ts && pnpm --filter @phenometrix/capture-web typecheck && pnpm --filter @phenometrix/capture-web build`
Expected: unit PASS (update the existing spy fixture's `elementsFixture()` to also provide `levelGauge`, `pitchGauge`, `clarityCanvas` fake canvases — mirror the existing fake canvas objects); typecheck PASS; build PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/capture-web/src/live-voice-visualizer.ts apps/capture-web/src/live-voice-visualizer.test.ts apps/capture-web/index.html apps/capture-web/src/styles.css apps/capture-web/src/main.ts
git commit -m "feat(capture-web): multi-channel voice telemetry (gauges + 3 waveforms)"
```

---

## Phase 2 — WebGL2 mesh renderer (worker)

> Phase 2 renderers are inherently visual; they are verified by **typecheck + build + the browser smoke (Task 12)**, not by unit tests. Keep all *math* in the Phase-0 helpers (already unit-tested). Do not add pixel readback.

### Task 6: `FaceMeshGLRenderer` — base depth mesh

**Files:**
- Create: `apps/capture-web/src/face-mesh-gl.ts`
- Create: `apps/capture-web/src/face-mesh-gl-shaders.ts`
- Test: `apps/capture-web/src/face-mesh-gl.test.ts` (attach-failure fallback only)

**Interfaces:**
- Consumes: `FaceMeshRenderer`, `FaceMeshRenderInput`, `FaceMeshRenderResult`, `EMPTY_RESULT` (Task 3); `normalizeDepth`, `depthToColor` (Task 1); the MediaPipe static connection sets used by the 2D renderer (`FaceLandmarker.FACE_LANDMARKS_TESSELATION`, eye/brow/lip/oval/iris sets).
- Produces: `class FaceMeshGLRenderer implements FaceMeshRenderer`. `attach` returns `false` when `getContext('webgl2')` is null (so the worker can fall back to 2D). `drawFrame(nowMs, introProgress)` uploads cached landmark positions + per-vertex depth (from `normalizeDepth(landmarks.map(l => l.z ?? 0))`) and draws the tessellation as `GL_LINES` with additive blending, plus landmark `GL_POINTS`.

- [ ] **Step 1: Write the attach-fallback test (the only unit-testable contract)**

```ts
// apps/capture-web/src/face-mesh-gl.test.ts
import { describe, expect, it } from "vitest";
import { FaceMeshGLRenderer } from "./face-mesh-gl.js";

describe("FaceMeshGLRenderer", () => {
  it("attach returns false and stays unattached when webgl2 is unavailable", () => {
    const renderer = new FaceMeshGLRenderer();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => null
    } as unknown as OffscreenCanvas;
    expect(renderer.attach(canvas, 24)).toBe(false);
    expect(renderer.isAttached()).toBe(false);
    expect(renderer.drawFrame(0, 1).rendered).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/face-mesh-gl.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the shaders module**

```ts
// apps/capture-web/src/face-mesh-gl-shaders.ts
// Positions arrive already in clip space (x,y in -1..1, y flipped by the CPU).
export const MESH_VERT = `#version 300 es
precision highp float;
in vec2 aPos;
in float aDepth;
out float vDepth;
void main() {
  vDepth = aDepth;
  gl_PointSize = 1.5 + aDepth * 3.0;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const MESH_FRAG = `#version 300 es
precision highp float;
in float vDepth;
uniform vec3 uNearColor;
uniform vec3 uFarColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec3 col = mix(uFarColor, uNearColor, vDepth);
  float a = uAlpha * (0.28 + 0.5 * vDepth);
  outColor = vec4(col * a, a); // premultiplied for additive blending
}`;
```

- [ ] **Step 4: Write the renderer**

```ts
// apps/capture-web/src/face-mesh-gl.ts
import { FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  EMPTY_RESULT,
  FACE_MESH_LANDMARK_COUNT,
  type FaceMeshRenderer,
  type FaceMeshRenderInput,
  type FaceMeshRenderResult
} from "./face-mesh-renderer.js";
import { depthToColor, normalizeDepth } from "./mesh-depth.js";
import { MESH_FRAG, MESH_VERT } from "./face-mesh-gl-shaders.js";

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
  }
  return s;
}
function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) ?? "program link failed");
  }
  return p;
}

// Flatten the static MediaPipe tessellation into a line-index array once.
const TESS_INDICES: number[] = FaceLandmarker.FACE_LANDMARKS_TESSELATION.flatMap(
  (c) => [c.start, c.end]
);

export class FaceMeshGLRenderer implements FaceMeshRenderer {
  private canvas: OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private posBuf: WebGLBuffer | null = null;
  private depthBuf: WebGLBuffer | null = null;
  private lineIndexBuf: WebGLBuffer | null = null;
  private latest: FaceMeshRenderInput | null = null;
  private positions = new Float32Array(FACE_MESH_LANDMARK_COUNT * 2);
  private depths = new Float32Array(FACE_MESH_LANDMARK_COUNT);

  attach(canvas: OffscreenCanvas, _maxRenderHz: number): boolean {
    this.detach();
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true
    });
    if (!gl) return false;
    this.canvas = canvas;
    this.gl = gl;
    this.program = link(gl, MESH_VERT, MESH_FRAG);
    this.posBuf = gl.createBuffer();
    this.depthBuf = gl.createBuffer();
    this.lineIndexBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIndexBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(TESS_INDICES), gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive (premultiplied)
    return true;
  }

  isAttached(): boolean {
    return this.gl !== null && this.program !== null;
  }

  updateLandmarks(input: FaceMeshRenderInput): void {
    this.latest = input;
  }

  drawFrame(nowMs: number, introProgress = 1): FaceMeshRenderResult {
    const gl = this.gl;
    const canvas = this.canvas;
    const input = this.latest;
    if (!gl || !canvas || !this.program || !input) return EMPTY_RESULT;
    const width = Math.round(input.width);
    const height = Math.round(input.height);
    if (width <= 0 || height <= 0) return EMPTY_RESULT;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const n = Math.min(FACE_MESH_LANDMARK_COUNT, input.landmarks.length);
    const depthNorm = normalizeDepth(
      input.landmarks.slice(0, n).map((l: NormalizedLandmark) => l.z ?? 0)
    );
    let dots = 0;
    for (let i = 0; i < n; i += 1) {
      const l = input.landmarks[i];
      const ok = Number.isFinite(l.x) && Number.isFinite(l.y);
      // clip space: x in -1..1; y flipped (canvas y-down -> GL y-up)
      this.positions[i * 2] = ok ? l.x * 2 - 1 : 0;
      this.positions[i * 2 + 1] = ok ? 1 - l.y * 2 : 0;
      this.depths[i] = ok ? depthNorm[i] : 0;
      if (ok) dots += 1;
    }

    const near = depthToColor(1, (nowMs * 0.02) % 360);
    const far = depthToColor(0, (nowMs * 0.02) % 360);
    const alpha = introProgress; // fade in during localize

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions.subarray(0, n * 2), gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(this.program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.depthBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.depths.subarray(0, n), gl.DYNAMIC_DRAW);
    const aDepth = gl.getAttribLocation(this.program, "aDepth");
    gl.enableVertexAttribArray(aDepth);
    gl.vertexAttribPointer(aDepth, 1, gl.FLOAT, false, 0, 0);
    gl.uniform3f(gl.getUniformLocation(this.program, "uNearColor"), near.r, near.g, near.b);
    gl.uniform3f(gl.getUniformLocation(this.program, "uFarColor"), far.r, far.g, far.b);
    gl.uniform1f(gl.getUniformLocation(this.program, "uAlpha"), alpha);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIndexBuf);
    gl.drawElements(gl.LINES, TESS_INDICES.length, gl.UNSIGNED_SHORT, 0);
    gl.drawArrays(gl.POINTS, 0, n);

    return { rendered: true, landmarkDots: dots, tessellationEdges: TESS_INDICES.length / 2, accentAnchors: 0 };
  }

  clear(): void {
    const { gl, canvas } = this;
    if (gl && canvas) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  detach(): void {
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.posBuf) gl.deleteBuffer(this.posBuf);
      if (this.depthBuf) gl.deleteBuffer(this.depthBuf);
      if (this.lineIndexBuf) gl.deleteBuffer(this.lineIndexBuf);
    }
    this.gl = null;
    this.canvas = null;
    this.program = null;
    this.posBuf = null;
    this.depthBuf = null;
    this.lineIndexBuf = null;
    this.latest = null;
  }
}
```

- [ ] **Step 5: Run unit test + typecheck + build**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/face-mesh-gl.test.ts && pnpm --filter @phenometrix/capture-web typecheck && pnpm --filter @phenometrix/capture-web build`
Expected: PASS (fallback test), typecheck PASS, build PASS. (Full visual verification happens in Task 12.)

- [ ] **Step 6: Commit**

```bash
git add apps/capture-web/src/face-mesh-gl.ts apps/capture-web/src/face-mesh-gl-shaders.ts apps/capture-web/src/face-mesh-gl.test.ts
git commit -m "feat(capture-web): WebGL2 face-mesh renderer — base depth mesh"
```

---

### Task 7: Bloom pipeline

**Files:**
- Modify: `apps/capture-web/src/face-mesh-gl.ts`
- Modify: `apps/capture-web/src/face-mesh-gl-shaders.ts`

**Interfaces:**
- Consumes: the base renderer (Task 6).
- Produces: internal bloom (no interface change). The mesh renders into a scene FBO; a 2-pass separable Gaussian blur produces a bloom texture; a final pass composites `scene + bloom` to the default framebuffer. `drawFrame`'s return shape is unchanged.

- [ ] **Step 1: Add blit/blur/composite shaders**

Append to `face-mesh-gl-shaders.ts`: a fullscreen-triangle vertex shader `QUAD_VERT` (emits `gl_Position` + `vUv` for `gl_VertexID` 0..2), a separable blur fragment `BLUR_FRAG` (uniform `uTex`, `uTexel`, `uDir`; 9-tap Gaussian), and a composite fragment `COMPOSITE_FRAG` (uniform `uScene`, `uBloom`, `uBloomStrength`; `outColor = sceneColor + bloom * uBloomStrength`). Write the full GLSL for each (standard implementations).

- [ ] **Step 2: Build the FBO chain in `attach`**

Add helper `createTarget(gl, w, h)` returning `{ fbo, tex }` (RGBA16F or RGBA8 color texture, `LINEAR` filtering, `CLAMP_TO_EDGE`). Create a full-resolution `sceneTarget` and two half-resolution `blurTargets[2]` (ping-pong). Recreate them in `drawFrame` when `width`/`height` change (track `fboWidth`/`fboHeight`). Add a no-op VAO for the fullscreen triangle.

- [ ] **Step 3: Route `drawFrame` through the pipeline**

1. Bind `sceneTarget.fbo`, clear, draw mesh lines + points (existing draw calls) with additive blend.
2. Downsample+blur: bind `blurTargets[0]`, run `BLUR_FRAG` sampling `sceneTarget.tex` with `uDir=(1,0)`; then `blurTargets[1]` sampling `blurTargets[0].tex` with `uDir=(0,1)`. Optionally repeat once for a wider bloom.
3. Bind default framebuffer (`gl.bindFramebuffer(gl.FRAMEBUFFER, null)`), clear transparent, run `COMPOSITE_FRAG` with `uScene=sceneTarget.tex`, `uBloom=blurTargets[1].tex`, `uBloomStrength` scaled by `introProgress` (stronger during localize, easing to rest). Composite uses `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)` (premultiplied over) so the transparent canvas composites correctly onto the dimmed video beneath.

- [ ] **Step 4: Free FBO resources in `detach`**

Delete all textures, framebuffers, and the quad VAO alongside the existing buffer/program cleanup.

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter @phenometrix/capture-web typecheck && pnpm --filter @phenometrix/capture-web build`
Expected: PASS. Visual bloom verified in Task 12.

- [ ] **Step 6: Commit**

```bash
git add apps/capture-web/src/face-mesh-gl.ts apps/capture-web/src/face-mesh-gl-shaders.ts
git commit -m "feat(capture-web): WebGL2 bloom pipeline for the face mesh"
```

---

### Task 8: Contours, particles (motes), twinkle, intro shaping

**Files:**
- Modify: `apps/capture-web/src/face-mesh-gl.ts`
- Modify: `apps/capture-web/src/face-mesh-gl-shaders.ts`
- Create: `apps/capture-web/src/mesh-motes.ts`
- Test: `apps/capture-web/src/mesh-motes.test.ts`

**Interfaces:**
- Consumes: base renderer + bloom (Tasks 6–7); `depthToColor` (Task 1).
- Produces:
  - `mesh-motes.ts`: `class MoteField` with `update(dtMs: number, spawn: (index: number) => { x: number; y: number; depth: number }, seedNodeCount: number): void` and `positions(): Float32Array` / `alphas(): Float32Array`. Deterministic PRNG seeded by a fixed constant (no `Math.random`), so it is unit-testable. Motes drift up in clip space and fade.
  - Renderer additions: brighter contour line groups (eyes/brows/lips/oval/iris index sets, drawn as extra `GL_LINES` with a higher alpha), per-point twinkle (time-based `gl_PointSize`/alpha jitter in the vertex shader via a `uTime` uniform), and `GL_POINTS` motes rendered additively. Intro shaping: scale-in (multiply clip positions by `mix(0.965, 1.0, introProgress)` via a `uScale` uniform) and the bloom-strength ramp from Task 7.

- [ ] **Step 1: Write the MoteField failing test**

```ts
// apps/capture-web/src/mesh-motes.test.ts
import { describe, expect, it } from "vitest";
import { MoteField } from "./mesh-motes.js";

describe("MoteField", () => {
  it("spawns, drifts upward, and fades deterministically", () => {
    const field = new MoteField(32);
    const spawn = (i: number) => ({ x: (i % 8) / 8, y: 0.5, depth: 0.5 });
    field.update(16, spawn, 100);
    const y0 = field.positions()[1];
    field.update(200, spawn, 100);
    // clip-space y increases upward; drifting up means y grows
    expect(field.positions()[1]).toBeGreaterThan(y0);
    // alphas stay within 0..1
    for (const a of field.alphas()) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic across instances", () => {
    const a = new MoteField(16);
    const b = new MoteField(16);
    const spawn = (i: number) => ({ x: i / 16, y: 0, depth: 0.5 });
    a.update(16, spawn, 50);
    b.update(16, spawn, 50);
    expect([...a.positions()]).toEqual([...b.positions()]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/mesh-motes.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `MoteField`**

```ts
// apps/capture-web/src/mesh-motes.ts
// Deterministic mulberry32 PRNG so motes are reproducible (no Math.random).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Mote { x: number; y: number; vy: number; life: number; }

export class MoteField {
  private motes: Mote[] = [];
  private rng = mulberry32(0x9e3779b9);
  private pos: Float32Array;
  private alpha: Float32Array;

  constructor(private readonly capacity: number) {
    this.pos = new Float32Array(capacity * 2);
    this.alpha = new Float32Array(capacity);
  }

  update(
    dtMs: number,
    spawn: (index: number) => { x: number; y: number; depth: number },
    seedNodeCount: number
  ): void {
    const dt = dtMs / 1000;
    if (this.motes.length < this.capacity && this.rng() < 0.6) {
      const idx = Math.floor(this.rng() * Math.max(1, seedNodeCount));
      const s = spawn(idx);
      // clip space: x,y in -1..1
      this.motes.push({ x: s.x * 2 - 1, y: 1 - s.y * 2, vy: 0.15 + this.rng() * 0.35, life: 1 });
    }
    for (let i = this.motes.length - 1; i >= 0; i -= 1) {
      const m = this.motes[i];
      m.y += m.vy * dt; // drift up (clip y increases upward)
      m.life -= dt * 0.7;
      if (m.life <= 0) this.motes.splice(i, 1);
    }
    this.pos.fill(0);
    this.alpha.fill(0);
    for (let i = 0; i < this.motes.length && i < this.capacity; i += 1) {
      this.pos[i * 2] = this.motes[i].x;
      this.pos[i * 2 + 1] = this.motes[i].y;
      this.alpha[i] = Math.max(0, Math.min(1, this.motes[i].life));
    }
  }

  positions(): Float32Array { return this.pos; }
  alphas(): Float32Array { return this.alpha; }
  count(): number { return Math.min(this.motes.length, this.capacity); }
}
```

- [ ] **Step 4: Wire contours, twinkle, motes, intro into the renderer**

In `face-mesh-gl.ts`: build a static contour line-index buffer from the MediaPipe eye/brow/lip/oval/iris sets (as `TESS_INDICES` was built); draw it after the tessellation with a brighter `uAlpha`. Add `uTime` + `uScale` uniforms (extend `MESH_VERT` to apply `aPos * uScale` and a small `sin(uTime + gl_VertexID)` size/alpha twinkle). Own a `MoteField` instance; each `drawFrame` call `moteField.update(dtMs, (i) => ({ x: input.landmarks[i].x, y: input.landmarks[i].y, depth: depthNorm[i] }), n)` and render its `positions()`/`alphas()` as additive `GL_POINTS` via a tiny mote program. Pass `uScale = mix(0.965, 1.0, introProgress)` and scale bloom strength (Task 7) by `introProgress`. Track `lastNowMs` to compute `dtMs`.

- [ ] **Step 5: Run mote test + typecheck + build**

Run: `pnpm --filter @phenometrix/capture-web exec vitest run src/mesh-motes.test.ts && pnpm --filter @phenometrix/capture-web typecheck && pnpm --filter @phenometrix/capture-web build`
Expected: PASS / PASS / PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/capture-web/src/face-mesh-gl.ts apps/capture-web/src/face-mesh-gl-shaders.ts apps/capture-web/src/mesh-motes.ts apps/capture-web/src/mesh-motes.test.ts
git commit -m "feat(capture-web): mesh contours, motes, twinkle, intro shaping"
```

---

## Phase 3 — Worker integration

### Task 9: Worker rAF loop, renderer selection, intro, context-loss, disposal

**Files:**
- Modify: `apps/capture-web/src/face-worker.ts`

**Interfaces:**
- Consumes: `FaceMeshRenderer` (Task 3), `FaceMeshGLRenderer` (Tasks 6–8), `FaceMeshOverlayRenderer` (fallback), `LocalizeIntro` (Task 2).
- Produces: no protocol change. The worker holds a `FaceMeshRenderer` chosen at `attach-overlay` (WebGL2 first, 2D on failure), runs a `requestAnimationFrame` draw loop over cached landmarks, computes intro progress in-worker, and frees renderer resources on dispose/detach.

- [ ] **Step 1: Swap the renderer to the interface + add loop/intro state**

Replace `const meshOverlay = new FaceMeshOverlayRenderer();` with interface-typed state and helpers:

```ts
import { FaceMeshGLRenderer } from "./face-mesh-gl.js";
import type { FaceMeshRenderer } from "./face-mesh-renderer.js";
import { LocalizeIntro } from "./localize-intro.js";

let meshRenderer: FaceMeshRenderer | null = null;
let meshOverlayCaptureEpoch: number | null = null;
let overlayCanvas: OffscreenCanvas | null = null;
let overlayMaxRenderHz = 24;
let rafHandle: number | null = null;
let hasLandmarks = false;
const localizeIntro = new LocalizeIntro();

function selectRenderer(canvas: OffscreenCanvas, maxRenderHz: number): FaceMeshRenderer | null {
  const gl = new FaceMeshGLRenderer();
  if (gl.attach(canvas, maxRenderHz)) return gl;
  const twoD = new FaceMeshOverlayRenderer();
  if (twoD.attach(canvas, maxRenderHz)) return twoD;
  return null;
}

function startRenderLoop(): void {
  if (rafHandle !== null) return;
  const tick = (now: number) => {
    rafHandle = requestAnimationFrame(tick);
    if (!meshRenderer || !hasLandmarks) return;
    const intro = localizeIntro.progress(now);
    meshRenderer.drawFrame(now, intro);
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopRenderLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}
```

- [ ] **Step 2: Update `attach-overlay` / `clear-overlay` handling**

In the `"attach-overlay"` branch, replace `meshOverlay.attach(message.canvas, message.maxRenderHz)` with:

```ts
overlayCanvas = message.canvas;
overlayMaxRenderHz = message.maxRenderHz;
meshRenderer = selectRenderer(message.canvas, message.maxRenderHz);
const attached = meshRenderer !== null;
meshOverlayCaptureEpoch = attached ? message.captureEpoch : null;
hasLandmarks = false;
localizeIntro.reset();
if (attached) startRenderLoop();
// register context-loss handling (WebGL only)
message.canvas.addEventListener?.("webglcontextlost", (e) => {
  e.preventDefault();
  stopRenderLoop();
});
message.canvas.addEventListener?.("webglcontextrestored", () => {
  if (overlayCanvas) {
    meshRenderer = selectRenderer(overlayCanvas, overlayMaxRenderHz);
    if (meshRenderer) startRenderLoop();
  }
});
post({ schemaVersion: VISUAL_WORKER_MESSAGE_VERSION, type: "overlay-status", captureEpoch: message.captureEpoch, attached });
```

In `"clear-overlay"` and `resetDerivedState`, call `meshRenderer?.clear()`, set `hasLandmarks = false`, and `localizeIntro.reset()`.

- [ ] **Step 3: Feed landmarks from `processFrame` (no synchronous draw)**

In `processFrame`, replace the `meshOverlay.render({...})` / `meshOverlay.clear()` block with:

```ts
if (nativeLandmarks && faceMeshPresentationEligible(faceCount, message.captureEpoch, meshOverlayCaptureEpoch)) {
  meshRenderer?.updateLandmarks({
    landmarks: nativeLandmarks,
    taskContext: message.taskContext,
    width: message.width,
    height: message.height,
    acquiredAtMs: message.acquiredAtMs
  });
  if (!hasLandmarks) {
    hasLandmarks = true;
    localizeIntro.start(performance.now()); // begin the come-into-focus intro on first lock
  }
} else {
  meshRenderer?.clear();
  hasLandmarks = false;
  localizeIntro.reset();
}
```

Also update the `faceCount !== 1` reset and the not-ready/error paths to `meshRenderer?.clear()` + `hasLandmarks = false`.

- [ ] **Step 4: Update `dispose` + `detach`**

In `dispose`, `stopRenderLoop()`, `meshRenderer?.detach()`, `meshRenderer = null`, `overlayCanvas = null`, `hasLandmarks = false`, `localizeIntro.reset()`, then the existing `landmarker?.close()` etc. `faceMeshPresentationEligible` and the `FaceMeshOverlayRenderer` import stay (fallback + eligibility helper).

- [ ] **Step 5: Typecheck + build + existing tests**

Run: `pnpm --filter @phenometrix/capture-web typecheck && pnpm --filter @phenometrix/capture-web build && pnpm --filter @phenometrix/capture-web test:unit`
Expected: all PASS. (`face-worker.ts` has no unit test; its behavior is covered by the browser smoke in Task 12.)

- [ ] **Step 6: Commit**

```bash
git add apps/capture-web/src/face-worker.ts
git commit -m "feat(capture-web): worker rAF loop + WebGL/2D renderer selection + localize intro"
```

---

## Phase 4 — Framing, accessibility, performance, e2e

### Task 10: Dimmed video, dark capture stage, mesh-status LOCATING/TRACKING

**Files:**
- Modify: `apps/capture-web/src/styles.css`
- Modify: `apps/capture-web/src/main.ts`

**Interfaces:**
- Consumes: the mesh-status element `#face-mesh-status` (already toggled via `faceOverlay.updateFaceCount` → `data-state`).
- Produces: dimmed `#camera-preview`, a cohesive dark capture stage, and a `data-state="locating"` visual for the pill during the intro window.

- [ ] **Step 1: Dim the camera + dark stage CSS**

In `styles.css`, extend the existing rules:

```css
#camera-preview { filter: brightness(0.6) saturate(0.85) contrast(1.05); }
.preview-card::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(120% 90% at 50% 45%, rgba(0,0,0,0) 42%, rgba(2,2,10,0.6) 100%);
}
.preview-card { background: #04040c; }
.mesh-status[data-state="locating"] { color: #bcd0ff; }
.mesh-status[data-state="locating"]::before {
  content: ""; display: inline-block; width: .48rem; height: .48rem; margin-right: .42rem;
  border-radius: 50%; background: #7df0ff; box-shadow: 0 0 0 3px rgba(125,240,255,.16);
}
```

Ensure `#landmark-overlay` stays above the `::after` overlay: add `#landmark-overlay { z-index: 1; }` and `.local-badge, .mesh-status { z-index: 2; }`.

- [ ] **Step 2: Mesh-status copy**

Confirm the existing runtime sets `#face-mesh-status` text/`data-state`. Where it currently sets `"active"`, ensure the copy reads `TRACKING · 478 pts` for `data-state="active"` and, when the lane is present but not yet locked, `LOCATING…` for `data-state="locating"`. Update the string(s) in `main.ts` where `faceMeshStatus` / the `FaceOverlayController` state text is set (search `face-mesh-status` and the controller's `setState`).

- [ ] **Step 3: Build + visual sanity**

Run: `pnpm --filter @phenometrix/capture-web build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/capture-web/src/styles.css apps/capture-web/src/main.ts
git commit -m "feat(capture-web): dimmed video, dark capture stage, locating/tracking status"
```

---

### Task 11: Reduced-motion + performance governor

**Files:**
- Modify: `apps/capture-web/src/face-worker.ts`
- Modify: `apps/capture-web/src/face-mesh-gl.ts`

**Interfaces:**
- Consumes: the render loop (Task 9), the GL renderer (Tasks 6–8).
- Produces: a `reducedMotion` flag propagated to `drawFrame` (static mesh: no hue drift, no motes, no twinkle, intro forced to `1`), and a frame-time governor that sheds effects (motes → bloom → hue drift) when frame time exceeds a budget.

- [ ] **Step 1: Detect reduced motion in the worker**

Workers can use `self.matchMedia` where supported; guard it. In `face-worker.ts`:

```ts
const reducedMotion =
  typeof self.matchMedia === "function" &&
  self.matchMedia("(prefers-reduced-motion: reduce)").matches;
```

In the render loop, when `reducedMotion`, call `meshRenderer.drawFrame(now, 1)` and pass a static flag. Extend the `FaceMeshRenderer.drawFrame` optional signature used by the GL renderer to accept a third `options?: { reducedMotion?: boolean; effectLevel?: number }` (2D renderer ignores it). Add it to the interface as `drawFrame(nowMs: number, introProgress?: number, options?: MeshDrawOptions): FaceMeshRenderResult` with `export interface MeshDrawOptions { reducedMotion?: boolean; effectLevel?: number }` in `face-mesh-renderer.ts`.

- [ ] **Step 2: Honor reduced motion in the GL renderer**

In `FaceMeshGLRenderer.drawFrame`, when `options?.reducedMotion`, set hue shift to `0`, skip the `MoteField.update`/mote draw, disable twinkle (`uTime = 0`), and treat intro as `1`.

- [ ] **Step 3: Governor**

Track an EMA of `dtMs`. Compute `effectLevel` (0..1): if EMA frame time > 20 ms, decrement toward 0 (drop motes first, then halve bloom passes, then freeze hue); if < 14 ms, recover toward 1. Pass `effectLevel` in `options` and gate mote count / bloom passes / hue drift on it inside the renderer.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @phenometrix/capture-web typecheck && pnpm --filter @phenometrix/capture-web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/capture-web/src/face-worker.ts apps/capture-web/src/face-mesh-gl.ts apps/capture-web/src/face-mesh-renderer.ts
git commit -m "feat(capture-web): reduced-motion + adaptive performance governor"
```

---

### Task 12: Browser smoke — overlay attaches, telemetry updates

**Files:**
- Modify: `apps/capture-web/e2e/ambient-smoke.spec.ts`

**Interfaces:**
- Consumes: the running production bundle (Playwright builds it via `test:browser`).
- Produces: assertions that (a) the landmark overlay canvas is present and un-hidden after tracking engages, (b) the WebGL2 path is exercised (or cleanly falls back), (c) the telemetry gauges + waveform canvases exist and their readouts update during dual-lane capture.

- [ ] **Step 1: Add an overlay + telemetry assertion to the dual-lane test**

In the existing dual-lane capture spec (the `~3.0s` test at `ambient-smoke.spec.ts:70`), after tracking starts, add:

```ts
// overlay canvas is revealed and sized once the mesh renderer attaches
const overlay = page.locator("#landmark-overlay");
await expect(overlay).toBeVisible();
await expect
  .poll(async () => overlay.evaluate((c: HTMLCanvasElement) => c.width))
  .toBeGreaterThan(0);

// telemetry surfaces exist and a readout populates
await expect(page.locator("#voice-level-gauge")).toBeAttached();
await expect(page.locator("#voice-energy-chart")).toBeAttached();
await expect(page.locator("#voice-clarity-chart")).toBeAttached();
await expect
  .poll(async () => page.locator("#voice-level-value").textContent())
  .not.toBe("—");
```

- [ ] **Step 2: Run the browser smoke**

Run: `pnpm --filter @phenometrix/capture-web test:browser`
Expected: PASS (6+ tests; the dual-lane test now also verifies overlay + telemetry). If WebGL2 is unavailable in the CI Chrome, the worker falls back to the 2D renderer and the same assertions hold (canvas still attaches and sizes).

- [ ] **Step 3: Full gate**

Run: `pnpm test && pnpm --filter @phenometrix/capture-web test:browser`
Expected: structure check PASS, all unit tests PASS, typecheck PASS, build PASS, browser PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/capture-web/e2e/ambient-smoke.spec.ts
git commit -m "test(capture-web): smoke-test mesh overlay attach + telemetry updates"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- §2 GPU mesh (WebGL2) → Tasks 6–8; worker integration → Task 9. ✓
- §3 rAF loop over cached landmarks → Task 9. ✓
- §4 telemetry (gauges + 3 waveforms) → Tasks 4–5. ✓
- §5.1–5.3 renderer + fallback + loop → Tasks 3, 6–9. ✓
- §5.4 telemetry main-thread → Tasks 4–5. ✓
- §5.5 dimmed video + dark stage → Task 10. ✓
- §5.6 WebGPU future → out of scope by design (documented in spec §13; no task, intentional). ✓
- §7 privacy (no new boundary data) → guaranteed: no worker-message/contract fields added (Global Constraints; Task 9 keeps landmarks in-worker). ✓
- §8 decisions (LEVEL/PITCH/CLARITY, subtle intro, iridescent·lush·bloom·lively, capture-stage-only) → Tasks 1,2,5,8,10. ✓
- §9 reduced motion + perf → Task 11. ✓
- §10 context-loss + fallback → Tasks 6, 9. ✓
- §11 testing (unit math + browser smoke) → Tasks 1–8 units, Task 12 smoke. ✓
- §12 files → all created/modified as listed. ✓

**Placeholder scan:** Phase-0/1 tasks carry full test + impl code. Phase-2/3 GL/worker tasks give concrete code and, where GLSL is standard boilerplate (Task 7 blur/composite shaders), specify the exact uniforms/behavior to implement rather than fake stubs — these are build+smoke-verified per the spec's testing strategy, not silent TODOs.

**Type consistency:** `FaceMeshRenderer` (`attach`/`isAttached`/`updateLandmarks`/`drawFrame`/`clear`/`detach`) is defined once (Task 3) and implemented by both renderers (Tasks 3, 6); `drawFrame(nowMs, introProgress?, options?)` signature is extended once in Task 11 and both implementers updated. `LiveVoiceElements` extended once (Task 5). `LocalizeIntro` API (`start`/`progress`/`isActive`/`reset`) consistent across Tasks 2 and 9. `normalizeDepth`/`depthToColor` signatures consistent across Tasks 1, 6, 8.

---

## Notes for the implementer

- MediaPipe's real `NormalizedLandmark.z` is populated during inference (relative depth, more-negative = nearer). Unit tests use `z = 0` (uniform depth → neutral shading); depth shading is validated visually via the smoke/dev run.
- The 2D fallback keeps the existing throttle; the WebGL path animates at rAF. `maxRenderHz` (24) remains the attach hint and the 2D throttle.
- Never add pixel readback from the overlay canvas; the only permitted readback is the pre-existing 64×64 quality ROI in `face-worker.ts` (unrelated, unchanged).
- Run `pnpm dev` and open `http://127.0.0.1:4173/phenometric/` to iterate on the visuals against a real camera during Phase 2–4.
