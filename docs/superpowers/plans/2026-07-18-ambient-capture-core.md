# Ambient Capture Core Implementation Plan

**Implementation status:** Complete through Task 11 on 2026-07-18. The
checkboxes below preserve the original executable recipe; repository tests are
the source of truth for the implemented state.

**Release hardening after the recipe:** `FrameStream` now requires and
runtime-checks `containsPHI: false`; speech candidates retain bounded
intra-speech pauses; aggregates are keyed by biomarker plus context; and the
visit observation preserves candidate windows, confounds, and per-window
measurements.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, headless core of the redesigned Capability #1 — a TypeScript library that replays a synthetic primitive-frame stream through a team of extractor agents and a Capture Conductor to produce one trendable per-visit `EncounterObservation` plus an agent-lane event stream.

**Architecture:** A `packages/contracts` package defines shared TypeScript types. A `packages/ambient-core` package implements the ingestion-primitive input types, two pure-function extractor agents (speech-acoustic, facial-expressivity), measurable-window detection, per-biomarker robust aggregation, and a Capture Conductor that orchestrates them and emits an append-only event stream. Everything runs headless over JSON fixtures — no camera, no browser, no language model — so it is fully deterministic and unit-testable. This is the design spec at `docs/superpowers/specs/2026-07-18-ambient-biomarker-capture-design.md`.

**Tech Stack:** Node >=22, TypeScript, Vitest, pnpm workspaces. No runtime dependencies in the core packages (pure functions over plain data).

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Node version:** `>=22` (root `package.json` `engines.node`). Use pnpm.
- **Minimize features:** No fourth product capability, agent, service, or UI surface without an explicit scope decision. This plan adds no top-level `agents/*` directory. The three extractor/orchestrator units live inside `packages/ambient-core/src`.
- **Do not break the legacy structure validator.** `scripts/validate-structure.sh` (run by `npm run check`) hard-asserts: exactly 3 directories under `agents/`; the legacy scripted event lifecycle in `examples/encounter-events.example.jsonl`; the 3-included/1-excluded history fixture; and that no media files (`*.wav *.mp3 *.m4a *.mp4 *.mov *.webm`) are committed. Do not add `agents/*` dirs, do not edit any file under `examples/`, `protocols/`, or `agents/`, and never commit media.
- **Separate event taxonomy.** The ambient core uses `schemaVersion: "phenometric.ambient-event.v0.1"`, `stage: "ambient-capture"`, and its own event types. It does not reuse or validate against the legacy `phenometric.event-envelope.v0.1` taxonomy.
- **Ephemeral capture.** The core consumes derived primitive frames only. It never handles or persists raw audio/video. `evidenceSnippetRef` is an opaque string reference, never embedded media.
- **LLM stays out of the measurement loop.** This entire package is deterministic signal processing and orchestration. No model calls.
- **Honesty of measurements.** Every `Measurement` sets `uncertainty: "placeholder"` and `clinicalValidation: "none"`. Values are engineering placeholders, never presented as validated biomarkers.
- **Abstention over fabrication.** An unmeasurable window produces an `Abstention`, never a value.
- **Synthetic only.** All fixtures set `containsPHI: false` and represent synthetic participants.

---

## File Structure

```text
packages/
├── contracts/
│   ├── package.json                # @phenometrix/contracts
│   ├── tsconfig.json
│   └── src/
│       ├── capture-mode.ts         # CaptureMode
│       ├── measurement.ts          # MeasurementContext, ConfoundEnvelope, MeasurableWindow, Measurement, Abstention
│       ├── observation.ts          # BiomarkerAggregate, EncounterObservation
│       ├── event.ts                # AmbientActor, AmbientEventType, EventEnvelope
│       └── index.ts                # barrel export
└── ambient-core/
    ├── package.json                # @phenometrix/ambient-core (depends on @phenometrix/contracts)
    ├── tsconfig.json
    ├── vitest.config.ts
    ├── fixtures/
    │   └── synthetic-visit.frames.json   # replayable primitive-frame stream (synthetic)
    └── src/
        ├── primitives.ts           # AudioFeatureFrame, FaceLandmarkFrame, FrameStream
        ├── stats.ts                # mean, stdDev, median, medianAbsoluteDeviation
        ├── speech-acoustic.ts      # extractSpeechAcoustic()
        ├── facial-expressivity.ts  # extractFacialExpressivity()
        ├── windowing.ts            # detectMeasurableWindows()
        ├── aggregate.ts            # aggregateBiomarker()
        ├── events.ts               # createEventFactory()
        ├── conductor.ts            # runConductor()
        ├── index.ts                # barrel export
        └── *.test.ts               # co-located tests
```

Root changes: `package.json` scripts, `.github/workflows/ci.yml`, `.gitignore`, and a `pnpm-lock.yaml` will be added/updated in Task 1.

---

## Task 1: Toolchain scaffold and contracts package skeleton

**Files:**
- Modify: `package.json` (root scripts + packageManager)
- Modify: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/capture-mode.ts`
- Create: `packages/ambient-core/package.json`
- Create: `packages/ambient-core/tsconfig.json`
- Create: `packages/ambient-core/vitest.config.ts`
- Create: `packages/ambient-core/src/index.ts`
- Test: `packages/ambient-core/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable `pnpm -w test:unit` that executes Vitest in `packages/ambient-core`, and `@phenometrix/contracts` exporting `CaptureMode`.

- [ ] **Step 1: Add the `.gitignore` entries for Node**

Append to `.gitignore`:

```gitignore
node_modules/
dist/
*.tsbuildinfo
.local/
```

- [ ] **Step 2: Create the contracts package manifest**

Create `packages/contracts/package.json`:

```json
{
  "name": "@phenometrix/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

- [ ] **Step 3: Create the contracts tsconfig**

Create `packages/contracts/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create the first contract type and barrel**

Create `packages/contracts/src/capture-mode.ts`:

```ts
export type CaptureMode =
  | "live"
  | "cached-processor"
  | "fixture-playback"
  | "recorded-demo";
```

Create `packages/contracts/src/index.ts`:

```ts
export type { CaptureMode } from "./capture-mode.js";
```

- [ ] **Step 5: Create the ambient-core manifest, tsconfig, and vitest config**

Create `packages/ambient-core/package.json`:

```json
{
  "name": "@phenometrix/ambient-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test:unit": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@phenometrix/contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "22.7.5",
    "typescript": "5.6.3",
    "vitest": "2.1.4"
  }
}
```

Create `packages/ambient-core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "fixtures"]
}
```

Create `packages/ambient-core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
```

Create `packages/ambient-core/src/index.ts`:

```ts
export const AMBIENT_CORE_VERSION = "0.1.0";
```

- [ ] **Step 6: Write the smoke test**

Create `packages/ambient-core/src/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AMBIENT_CORE_VERSION } from "./index.js";
import type { CaptureMode } from "@phenometrix/contracts";

describe("ambient-core toolchain", () => {
  it("exposes a version and resolves the contracts package", () => {
    const mode: CaptureMode = "fixture-playback";
    expect(AMBIENT_CORE_VERSION).toBe("0.1.0");
    expect(mode).toBe("fixture-playback");
  });
});
```

- [ ] **Step 7: Wire root scripts and CI**

In root `package.json`, set `packageManager` and add scripts. The `check` script stays exactly as-is; `test` now runs both the structure validator and unit tests:

```json
{
  "name": "phenometric",
  "version": "0.1.0",
  "private": true,
  "description": "A clinical observability prototype for quality-aware face and voice measurement across telehealth encounters.",
  "license": "MIT",
  "packageManager": "pnpm@9.12.3",
  "scripts": {
    "check": "bash scripts/validate-structure.sh",
    "test:unit": "pnpm -r --filter @phenometrix/ambient-core test:unit",
    "test": "npm run check && npm run test:unit"
  },
  "engines": {
    "node": ">=22"
  }
}
```

Replace `.github/workflows/ci.yml` with a version that installs dependencies before testing:

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.3
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

- [ ] **Step 8: Install and run the smoke test**

Run:
```bash
pnpm install
pnpm -w test:unit
```
Expected: Vitest runs `smoke.test.ts` and reports `1 passed`.

- [ ] **Step 9: Verify the legacy structure check still passes**

Run: `npm run check`
Expected: prints `PhenoMetrix structure and event stream are valid.`

- [ ] **Step 10: Commit**

```bash
git add .gitignore package.json pnpm-lock.yaml .github/workflows/ci.yml packages/contracts packages/ambient-core
git commit -m "chore: scaffold ambient-core toolchain and contracts skeleton"
```

---

## Task 2: Measurement and window contract types

**Files:**
- Create: `packages/contracts/src/measurement.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/ambient-core/src/contracts.test.ts`

**Interfaces:**
- Consumes: `CaptureMode` (Task 1).
- Produces: `MeasurementContextKind`, `ConfoundEnvelope`, `MeasurementContext`, `MeasurableWindow`, `Measurement`, `Abstention`, `Modality`.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  Abstention,
  Measurement,
  MeasurableWindow
} from "@phenometrix/contracts";

describe("measurement contracts", () => {
  it("models a measurement with provenance and placeholder honesty", () => {
    const window: MeasurableWindow = {
      windowId: "w-1",
      modality: "speech",
      startMs: 0,
      endMs: 4000,
      context: {
        kind: "spontaneous-speech",
        confounds: {
          snrDb: 22,
          faceFramingFraction: 1,
          observedFrameRate: 30,
          illuminationRelative: 0.8
        }
      }
    };
    const measurement: Measurement = {
      code: "prototype.speech.articulation_rate",
      label: "Articulation rate",
      value: 0.61,
      unit: "voiced-fraction",
      confidence: 0.9,
      uncertainty: "placeholder",
      algorithmVersion: "speech-acoustic-0.1",
      clinicalValidation: "none",
      contextRef: window.windowId,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      evidenceSnippetRef: null
    };
    const abstention: Abstention = {
      modality: "speech",
      windowStartMs: 0,
      windowEndMs: 1000,
      reasonCode: "snr-too-low",
      detail: "Mean SNR 4 dB below the 12 dB floor."
    };

    expect(measurement.uncertainty).toBe("placeholder");
    expect(measurement.clinicalValidation).toBe("none");
    expect(measurement.contextRef).toBe(window.windowId);
    expect(abstention.reasonCode).toBe("snr-too-low");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find exported types from `@phenometrix/contracts`.

- [ ] **Step 3: Write the contract types**

Create `packages/contracts/src/measurement.ts`:

```ts
export type Modality = "speech" | "face";

export type MeasurementContextKind =
  | "spontaneous-speech"
  | "sustained-vowel"
  | "reading-aloud"
  | "listening-expressive";

export interface ConfoundEnvelope {
  snrDb: number;
  faceFramingFraction: number;
  observedFrameRate: number;
  illuminationRelative: number;
}

export interface MeasurementContext {
  kind: MeasurementContextKind;
  confounds: ConfoundEnvelope;
}

export interface MeasurableWindow {
  windowId: string;
  modality: Modality;
  startMs: number;
  endMs: number;
  context: MeasurementContext;
}

export interface Measurement {
  code: string;
  label: string;
  value: number;
  unit: string;
  confidence: number;
  uncertainty: "placeholder";
  algorithmVersion: string;
  clinicalValidation: "none";
  contextRef: string;
  windowStartMs: number;
  windowEndMs: number;
  evidenceSnippetRef: string | null;
}

export interface Abstention {
  modality: Modality;
  windowStartMs: number;
  windowEndMs: number;
  reasonCode: string;
  detail: string;
}
```

- [ ] **Step 4: Export the new types**

Replace `packages/contracts/src/index.ts`:

```ts
export type { CaptureMode } from "./capture-mode.js";
export type {
  Modality,
  MeasurementContextKind,
  ConfoundEnvelope,
  MeasurementContext,
  MeasurableWindow,
  Measurement,
  Abstention
} from "./measurement.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src packages/ambient-core/src/contracts.test.ts
git commit -m "feat: add measurement and window contract types"
```

---

## Task 3: Observation aggregate and event contract types

**Files:**
- Create: `packages/contracts/src/observation.ts`
- Create: `packages/contracts/src/event.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/ambient-core/src/observation-contract.test.ts`

**Interfaces:**
- Consumes: `CaptureMode`, `MeasurementContextKind`, `Abstention` (Tasks 1–2).
- Produces: `BiomarkerAggregate`, `EncounterObservation`, `AmbientActorId`, `AmbientActor`, `AmbientEventType`, `EventEnvelope`.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/observation-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  EncounterObservation,
  EventEnvelope
} from "@phenometrix/contracts";

describe("observation and event contracts", () => {
  it("models a per-visit aggregate observation", () => {
    const observation: EncounterObservation = {
      containsPHI: false,
      captureMode: "fixture-playback",
      visitId: "visit-001",
      participantId: "synthetic-participant-001",
      aggregates: [
        {
          code: "prototype.speech.articulation_rate",
          label: "Articulation rate",
          unit: "voiced-fraction",
          contextKind: "spontaneous-speech",
          value: 0.6,
          spread: 0.03,
          windowCount: 4,
          algorithmVersion: "speech-acoustic-0.1",
          uncertainty: "placeholder",
          clinicalValidation: "none"
        }
      ],
      abstentions: [],
      measurementCount: 4
    };
    expect(observation.containsPHI).toBe(false);
    expect(observation.aggregates[0].windowCount).toBe(4);
  });

  it("models an ambient event envelope with lane identity", () => {
    const event: EventEnvelope = {
      schemaVersion: "phenometric.ambient-event.v0.1",
      eventId: "1-capture.window.detected",
      sequence: 1,
      occurredAt: "2026-07-18T16:00:00.000Z",
      visitId: "visit-001",
      participantId: "synthetic-participant-001",
      actor: {
        kind: "agent",
        id: "capture-conductor",
        lane: "capture-conductor",
        version: "0.1.0"
      },
      type: "capture.window.detected",
      stage: "ambient-capture",
      summary: "Detected a measurable speech window.",
      payload: {},
      evidenceRefs: []
    };
    expect(event.stage).toBe("ambient-capture");
    expect(event.actor.lane).toBe(event.actor.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — missing `EncounterObservation` and `EventEnvelope`.

- [ ] **Step 3: Write the observation types**

Create `packages/contracts/src/observation.ts`:

```ts
import type { CaptureMode } from "./capture-mode.js";
import type { Abstention, MeasurementContextKind } from "./measurement.js";

export interface BiomarkerAggregate {
  code: string;
  label: string;
  unit: string;
  contextKind: MeasurementContextKind;
  value: number;
  spread: number;
  windowCount: number;
  algorithmVersion: string;
  uncertainty: "placeholder";
  clinicalValidation: "none";
}

export interface EncounterObservation {
  containsPHI: false;
  captureMode: CaptureMode;
  visitId: string;
  participantId: string;
  aggregates: BiomarkerAggregate[];
  abstentions: Abstention[];
  measurementCount: number;
}
```

- [ ] **Step 4: Write the event types**

Create `packages/contracts/src/event.ts`:

```ts
export type AmbientActorId =
  | "capture-conductor"
  | "speech-acoustic"
  | "facial-expressivity";

export interface AmbientActor {
  kind: "agent";
  id: AmbientActorId;
  lane: AmbientActorId;
  version: string;
}

export type AmbientEventType =
  | "capture.window.detected"
  | "measurement.recorded"
  | "measurement.abstained"
  | "encounter-observation.created";

export interface EventEnvelope {
  schemaVersion: "phenometric.ambient-event.v0.1";
  eventId: string;
  sequence: number;
  occurredAt: string;
  visitId: string;
  participantId: string;
  actor: AmbientActor;
  type: AmbientEventType;
  stage: "ambient-capture";
  summary: string;
  payload: Record<string, unknown>;
  evidenceRefs: string[];
}
```

- [ ] **Step 5: Export the new types**

Replace `packages/contracts/src/index.ts`:

```ts
export type { CaptureMode } from "./capture-mode.js";
export type {
  Modality,
  MeasurementContextKind,
  ConfoundEnvelope,
  MeasurementContext,
  MeasurableWindow,
  Measurement,
  Abstention
} from "./measurement.js";
export type {
  BiomarkerAggregate,
  EncounterObservation
} from "./observation.js";
export type {
  AmbientActorId,
  AmbientActor,
  AmbientEventType,
  EventEnvelope
} from "./event.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src packages/ambient-core/src/observation-contract.test.ts
git commit -m "feat: add observation aggregate and ambient event contracts"
```

---

## Task 4: Primitive frame input types

**Files:**
- Create: `packages/ambient-core/src/primitives.ts`
- Test: `packages/ambient-core/src/primitives.test.ts`

**Interfaces:**
- Consumes: `CaptureMode` (Task 1).
- Produces: `AudioFeatureFrame`, `FaceLandmarkFrame`, `FrameStream`.

These types are the derived primitives a real ingestion layer (a later plan) will publish on the bus. In this plan they are read from fixtures.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/primitives.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FrameStream } from "./primitives.js";

describe("primitive frame types", () => {
  it("models a frame stream with synchronized audio and face frames", () => {
    const stream: FrameStream = {
      visitId: "visit-001",
      participantId: "synthetic-participant-001",
      captureMode: "fixture-playback",
      audio: [
        { tMs: 0, voiced: true, rms: 0.4, pitchHz: 120, clipped: false, snrDb: 20 }
      ],
      face: [
        {
          tMs: 0,
          faceVisible: true,
          framingFraction: 0.95,
          illumination: 0.8,
          eyeAspectRatio: 0.3,
          browRaise: 0.2,
          mouthOpen: 0.1,
          landmarkMotion: 0.05,
          observedFrameRate: 30
        }
      ]
    };
    expect(stream.audio[0].voiced).toBe(true);
    expect(stream.face[0].framingFraction).toBeGreaterThan(0.9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./primitives.js`.

- [ ] **Step 3: Write the primitive types**

Create `packages/ambient-core/src/primitives.ts`:

```ts
import type { CaptureMode } from "@phenometrix/contracts";

export interface AudioFeatureFrame {
  tMs: number;
  voiced: boolean;
  rms: number;
  pitchHz: number | null;
  clipped: boolean;
  snrDb: number;
}

export interface FaceLandmarkFrame {
  tMs: number;
  faceVisible: boolean;
  framingFraction: number;
  illumination: number;
  eyeAspectRatio: number;
  browRaise: number;
  mouthOpen: number;
  landmarkMotion: number;
  observedFrameRate: number;
}

export interface FrameStream {
  visitId: string;
  participantId: string;
  captureMode: CaptureMode;
  audio: AudioFeatureFrame[];
  face: FaceLandmarkFrame[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ambient-core/src/primitives.ts packages/ambient-core/src/primitives.test.ts
git commit -m "feat: add primitive frame input types"
```

---

## Task 5: Shared statistics utilities

**Files:**
- Create: `packages/ambient-core/src/stats.ts`
- Test: `packages/ambient-core/src/stats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mean(values: number[]): number`, `stdDev(values: number[]): number` (population standard deviation, `0` for fewer than 2 values), `median(values: number[]): number`, `medianAbsoluteDeviation(values: number[]): number`. These are shared by the extractors, windowing, and aggregation so the same math is defined once.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/stats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mean, stdDev, median, medianAbsoluteDeviation } from "./stats.js";

describe("stats utilities", () => {
  it("computes the mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  it("computes population standard deviation, 0 for fewer than 2 values", () => {
    expect(stdDev([120, 130, 110, 140])).toBeCloseTo(11.1803, 3);
    expect(stdDev([5])).toBe(0);
  });

  it("computes the median for odd and even counts", () => {
    expect(median([2, 6, 4])).toBe(4);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("computes the median absolute deviation", () => {
    expect(medianAbsoluteDeviation([2, 4, 6])).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./stats.js`.

- [ ] **Step 3: Write the statistics utilities**

Create `packages/ambient-core/src/stats.ts`:

```ts
export function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function medianAbsoluteDeviation(values: number[]): number {
  const center = median(values);
  return median(values.map((v) => Math.abs(v - center)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ambient-core/src/stats.ts packages/ambient-core/src/stats.test.ts
git commit -m "feat: add shared statistics utilities"
```

---

## Task 6: Speech-acoustic extractor agent

**Files:**
- Create: `packages/ambient-core/src/speech-acoustic.ts`
- Test: `packages/ambient-core/src/speech-acoustic.test.ts`

**Interfaces:**
- Consumes: `AudioFeatureFrame` (Task 4); `Measurement`, `Abstention`, `MeasurableWindow` (Task 2); `mean`, `stdDev` (Task 5).
- Produces:
  - `SPEECH_ACOUSTIC_VERSION = "speech-acoustic-0.1"`
  - `SPEECH_SNR_FLOOR_DB = 12`
  - `extractSpeechAcoustic(window: MeasurableWindow, frames: AudioFeatureFrame[]): Measurement[] | Abstention`
  - Emits three measurement codes: `prototype.speech.articulation_rate` (voiced fraction), `prototype.speech.pause_count` (count of silence runs), `prototype.speech.pitch_variability` (std dev of voiced pitch in Hz).

Rules: abstain when the window has fewer than 3 voiced frames or mean SNR below `SPEECH_SNR_FLOOR_DB`. Confidence is `min(1, meanSnrDb / 30)`.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/speech-acoustic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractSpeechAcoustic, SPEECH_ACOUSTIC_VERSION } from "./speech-acoustic.js";
import type { AudioFeatureFrame } from "./primitives.js";
import type { Abstention, MeasurableWindow, Measurement } from "@phenometrix/contracts";

const window: MeasurableWindow = {
  windowId: "w-speech-1",
  modality: "speech",
  startMs: 0,
  endMs: 500,
  context: {
    kind: "spontaneous-speech",
    confounds: { snrDb: 20, faceFramingFraction: 1, observedFrameRate: 30, illuminationRelative: 0.8 }
  }
};

function frame(tMs: number, voiced: boolean, pitchHz: number | null, snrDb = 20): AudioFeatureFrame {
  return { tMs, voiced, rms: voiced ? 0.4 : 0.02, pitchHz, clipped: false, snrDb };
}

describe("extractSpeechAcoustic", () => {
  it("emits three measurements over a clean voiced window", () => {
    const frames = [
      frame(0, true, 120), frame(100, true, 130), frame(200, false, null),
      frame(300, true, 110), frame(400, true, 140)
    ];
    const result = extractSpeechAcoustic(window, frames) as Measurement[];
    expect(Array.isArray(result)).toBe(true);
    const byCode = new Map(result.map((m) => [m.code, m]));
    expect(byCode.get("prototype.speech.articulation_rate")!.value).toBeCloseTo(0.8, 5);
    expect(byCode.get("prototype.speech.pause_count")!.value).toBe(1);
    expect(byCode.get("prototype.speech.pitch_variability")!.value).toBeGreaterThan(0);
    for (const m of result) {
      expect(m.algorithmVersion).toBe(SPEECH_ACOUSTIC_VERSION);
      expect(m.uncertainty).toBe("placeholder");
      expect(m.clinicalValidation).toBe("none");
      expect(m.contextRef).toBe(window.windowId);
    }
  });

  it("abstains on a low-SNR window", () => {
    const frames = [frame(0, true, 120, 4), frame(100, true, 130, 4), frame(200, true, 110, 4)];
    const result = extractSpeechAcoustic(window, frames) as Abstention;
    expect("reasonCode" in result).toBe(true);
    expect(result.reasonCode).toBe("snr-too-low");
  });

  it("abstains when there are too few voiced frames", () => {
    const frames = [frame(0, true, 120), frame(100, false, null)];
    const result = extractSpeechAcoustic(window, frames) as Abstention;
    expect(result.reasonCode).toBe("insufficient-voiced-frames");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./speech-acoustic.js`.

- [ ] **Step 3: Write the extractor**

Create `packages/ambient-core/src/speech-acoustic.ts`:

```ts
import type { AudioFeatureFrame } from "./primitives.js";
import type { Abstention, MeasurableWindow, Measurement } from "@phenometrix/contracts";
import { mean, stdDev } from "./stats.js";

export const SPEECH_ACOUSTIC_VERSION = "speech-acoustic-0.1";
export const SPEECH_SNR_FLOOR_DB = 12;
const MIN_VOICED_FRAMES = 3;

function countPauses(frames: AudioFeatureFrame[]): number {
  let pauses = 0;
  let inPause = false;
  for (const f of frames) {
    if (!f.voiced && !inPause) {
      pauses += 1;
      inPause = true;
    } else if (f.voiced) {
      inPause = false;
    }
  }
  return pauses;
}

function measurement(
  window: MeasurableWindow,
  code: string,
  label: string,
  value: number,
  unit: string,
  confidence: number
): Measurement {
  return {
    code,
    label,
    value,
    unit,
    confidence,
    uncertainty: "placeholder",
    algorithmVersion: SPEECH_ACOUSTIC_VERSION,
    clinicalValidation: "none",
    contextRef: window.windowId,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    evidenceSnippetRef: null
  };
}

export function extractSpeechAcoustic(
  window: MeasurableWindow,
  frames: AudioFeatureFrame[]
): Measurement[] | Abstention {
  const abstain = (reasonCode: string, detail: string): Abstention => ({
    modality: "speech",
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    reasonCode,
    detail
  });

  const voiced = frames.filter((f) => f.voiced);
  if (voiced.length < MIN_VOICED_FRAMES) {
    return abstain(
      "insufficient-voiced-frames",
      `Window has ${voiced.length} voiced frames; ${MIN_VOICED_FRAMES} required.`
    );
  }
  const meanSnr = mean(frames.map((f) => f.snrDb));
  if (meanSnr < SPEECH_SNR_FLOOR_DB) {
    return abstain(
      "snr-too-low",
      `Mean SNR ${meanSnr.toFixed(1)} dB below the ${SPEECH_SNR_FLOOR_DB} dB floor.`
    );
  }

  const confidence = Math.min(1, meanSnr / 30);
  const articulationRate = voiced.length / frames.length;
  const pauseCount = countPauses(frames);
  const pitchVariability = stdDev(
    voiced.map((f) => f.pitchHz).filter((p): p is number => p !== null)
  );

  return [
    measurement(window, "prototype.speech.articulation_rate", "Articulation rate", articulationRate, "voiced-fraction", confidence),
    measurement(window, "prototype.speech.pause_count", "Pause count", pauseCount, "count", confidence),
    measurement(window, "prototype.speech.pitch_variability", "Pitch variability", pitchVariability, "hz-stddev", confidence)
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS (3 speech-acoustic tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/ambient-core/src/speech-acoustic.ts packages/ambient-core/src/speech-acoustic.test.ts
git commit -m "feat: add speech-acoustic extractor agent"
```

---

## Task 7: Facial-expressivity extractor agent

**Files:**
- Create: `packages/ambient-core/src/facial-expressivity.ts`
- Test: `packages/ambient-core/src/facial-expressivity.test.ts`

**Interfaces:**
- Consumes: `FaceLandmarkFrame` (Task 4); `Measurement`, `Abstention`, `MeasurableWindow` (Task 2); `mean` (Task 5).
- Produces:
  - `FACIAL_EXPRESSIVITY_VERSION = "facial-expressivity-0.1"`
  - `FACE_FRAMING_FLOOR = 0.6`
  - `BLINK_EAR_THRESHOLD = 0.2`
  - `extractFacialExpressivity(window: MeasurableWindow, frames: FaceLandmarkFrame[]): Measurement[] | Abstention`
  - Emits: `prototype.face.expressivity` (mean landmark motion), `prototype.face.blink_rate` (blinks per minute), `prototype.face.brow_amplitude` (range of brow raise).

Rules: abstain when fewer than 3 visible frames or mean framing fraction below `FACE_FRAMING_FLOOR`. A blink is a contiguous run of frames with `eyeAspectRatio < BLINK_EAR_THRESHOLD`. Confidence is the mean framing fraction.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/facial-expressivity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractFacialExpressivity, FACIAL_EXPRESSIVITY_VERSION } from "./facial-expressivity.js";
import type { FaceLandmarkFrame } from "./primitives.js";
import type { Abstention, MeasurableWindow, Measurement } from "@phenometrix/contracts";

const window: MeasurableWindow = {
  windowId: "w-face-1",
  modality: "face",
  startMs: 0,
  endMs: 60000,
  context: {
    kind: "listening-expressive",
    confounds: { snrDb: 20, faceFramingFraction: 0.95, observedFrameRate: 30, illuminationRelative: 0.8 }
  }
};

function faceFrame(tMs: number, ear: number, motion: number, brow: number, framing = 0.95): FaceLandmarkFrame {
  return {
    tMs, faceVisible: framing >= 0.5, framingFraction: framing, illumination: 0.8,
    eyeAspectRatio: ear, browRaise: brow, mouthOpen: 0.1, landmarkMotion: motion, observedFrameRate: 30
  };
}

describe("extractFacialExpressivity", () => {
  it("emits three measurements and counts one blink over a 60s window", () => {
    const frames = [
      faceFrame(0, 0.3, 0.05, 0.2), faceFrame(1000, 0.1, 0.06, 0.3),
      faceFrame(2000, 0.3, 0.04, 0.1), faceFrame(3000, 0.3, 0.05, 0.25)
    ];
    const result = extractFacialExpressivity(window, frames) as Measurement[];
    const byCode = new Map(result.map((m) => [m.code, m]));
    expect(byCode.get("prototype.face.expressivity")!.value).toBeCloseTo(0.05, 5);
    expect(byCode.get("prototype.face.blink_rate")!.value).toBe(1);
    expect(byCode.get("prototype.face.brow_amplitude")!.value).toBeCloseTo(0.2, 5);
    for (const m of result) {
      expect(m.algorithmVersion).toBe(FACIAL_EXPRESSIVITY_VERSION);
      expect(m.clinicalValidation).toBe("none");
    }
  });

  it("abstains when the face is poorly framed", () => {
    const frames = [faceFrame(0, 0.3, 0.05, 0.2, 0.3), faceFrame(1000, 0.3, 0.05, 0.2, 0.3), faceFrame(2000, 0.3, 0.05, 0.2, 0.3)];
    const result = extractFacialExpressivity(window, frames) as Abstention;
    expect(result.reasonCode).toBe("face-not-framed");
  });
});
```

Note on the blink-rate expectation: the window is 60000 ms (60 s), so 1 blink over 60 s is 1 blink/minute.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./facial-expressivity.js`.

- [ ] **Step 3: Write the extractor**

Create `packages/ambient-core/src/facial-expressivity.ts`:

```ts
import type { FaceLandmarkFrame } from "./primitives.js";
import type { Abstention, MeasurableWindow, Measurement } from "@phenometrix/contracts";
import { mean } from "./stats.js";

export const FACIAL_EXPRESSIVITY_VERSION = "facial-expressivity-0.1";
export const FACE_FRAMING_FLOOR = 0.6;
export const BLINK_EAR_THRESHOLD = 0.2;
const MIN_VISIBLE_FRAMES = 3;

function countBlinks(frames: FaceLandmarkFrame[]): number {
  let blinks = 0;
  let inBlink = false;
  for (const f of frames) {
    if (f.eyeAspectRatio < BLINK_EAR_THRESHOLD && !inBlink) {
      blinks += 1;
      inBlink = true;
    } else if (f.eyeAspectRatio >= BLINK_EAR_THRESHOLD) {
      inBlink = false;
    }
  }
  return blinks;
}

function measurement(
  window: MeasurableWindow,
  code: string,
  label: string,
  value: number,
  unit: string,
  confidence: number
): Measurement {
  return {
    code,
    label,
    value,
    unit,
    confidence,
    uncertainty: "placeholder",
    algorithmVersion: FACIAL_EXPRESSIVITY_VERSION,
    clinicalValidation: "none",
    contextRef: window.windowId,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    evidenceSnippetRef: null
  };
}

export function extractFacialExpressivity(
  window: MeasurableWindow,
  frames: FaceLandmarkFrame[]
): Measurement[] | Abstention {
  const abstain = (reasonCode: string, detail: string): Abstention => ({
    modality: "face",
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    reasonCode,
    detail
  });

  const visible = frames.filter((f) => f.faceVisible);
  if (visible.length < MIN_VISIBLE_FRAMES) {
    return abstain(
      "face-not-visible",
      `Window has ${visible.length} visible frames; ${MIN_VISIBLE_FRAMES} required.`
    );
  }
  const meanFraming = mean(frames.map((f) => f.framingFraction));
  if (meanFraming < FACE_FRAMING_FLOOR) {
    return abstain(
      "face-not-framed",
      `Mean framing ${meanFraming.toFixed(2)} below the ${FACE_FRAMING_FLOOR} floor.`
    );
  }

  const confidence = Math.min(1, meanFraming);
  const expressivity = mean(frames.map((f) => f.landmarkMotion));
  const durationMinutes = Math.max(1, window.endMs - window.startMs) / 60000;
  const blinkRate = countBlinks(frames) / durationMinutes;
  const brows = frames.map((f) => f.browRaise);
  const browAmplitude = Math.max(...brows) - Math.min(...brows);

  return [
    measurement(window, "prototype.face.expressivity", "Facial expressivity", expressivity, "motion-index", confidence),
    measurement(window, "prototype.face.blink_rate", "Blink rate", blinkRate, "blinks-per-minute", confidence),
    measurement(window, "prototype.face.brow_amplitude", "Brow amplitude", browAmplitude, "normalized-range", confidence)
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ambient-core/src/facial-expressivity.ts packages/ambient-core/src/facial-expressivity.test.ts
git commit -m "feat: add facial-expressivity extractor agent"
```

---

## Task 8: Measurable-window detection

**Files:**
- Create: `packages/ambient-core/src/windowing.ts`
- Test: `packages/ambient-core/src/windowing.test.ts`

**Interfaces:**
- Consumes: `FrameStream`, `AudioFeatureFrame`, `FaceLandmarkFrame` (Task 4); `MeasurableWindow`, `ConfoundEnvelope`, `Modality` (Task 2); `mean` (Task 5).
- Produces:
  - `MIN_WINDOW_MS = 1500`
  - `detectMeasurableWindows(stream: FrameStream): MeasurableWindow[]`
  - Speech windows are contiguous runs of `voiced` audio frames of at least `MIN_WINDOW_MS`; context kind `spontaneous-speech`. Face windows are contiguous runs of `faceVisible` frames of at least `MIN_WINDOW_MS`; context kind `listening-expressive`. Windows are returned sorted by `startMs`, then `modality`.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/windowing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectMeasurableWindows } from "./windowing.js";
import type { FrameStream } from "./primitives.js";

function stream(partial: Partial<FrameStream>): FrameStream {
  return {
    visitId: "visit-001",
    participantId: "synthetic-participant-001",
    captureMode: "fixture-playback",
    audio: [],
    face: [],
    ...partial
  };
}

describe("detectMeasurableWindows", () => {
  it("finds one speech window from a contiguous voiced run", () => {
    const audio = Array.from({ length: 20 }, (_, i) => ({
      tMs: i * 100, voiced: true, rms: 0.4, pitchHz: 120, clipped: false, snrDb: 20
    }));
    const windows = detectMeasurableWindows(stream({ audio }));
    expect(windows).toHaveLength(1);
    expect(windows[0].modality).toBe("speech");
    expect(windows[0].context.kind).toBe("spontaneous-speech");
    expect(windows[0].endMs - windows[0].startMs).toBeGreaterThanOrEqual(1500);
    expect(windows[0].context.confounds.snrDb).toBeCloseTo(20, 5);
  });

  it("ignores a voiced run shorter than the minimum window", () => {
    const audio = Array.from({ length: 5 }, (_, i) => ({
      tMs: i * 100, voiced: true, rms: 0.4, pitchHz: 120, clipped: false, snrDb: 20
    }));
    expect(detectMeasurableWindows(stream({ audio }))).toHaveLength(0);
  });

  it("finds a face window from a contiguous visible run", () => {
    const face = Array.from({ length: 20 }, (_, i) => ({
      tMs: i * 100, faceVisible: true, framingFraction: 0.9, illumination: 0.8,
      eyeAspectRatio: 0.3, browRaise: 0.2, mouthOpen: 0.1, landmarkMotion: 0.05, observedFrameRate: 30
    }));
    const windows = detectMeasurableWindows(stream({ face }));
    expect(windows).toHaveLength(1);
    expect(windows[0].modality).toBe("face");
    expect(windows[0].context.kind).toBe("listening-expressive");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./windowing.js`.

- [ ] **Step 3: Write the window detector**

Create `packages/ambient-core/src/windowing.ts`:

```ts
import type { AudioFeatureFrame, FaceLandmarkFrame, FrameStream } from "./primitives.js";
import type { ConfoundEnvelope, MeasurableWindow, Modality } from "@phenometrix/contracts";
import { mean } from "./stats.js";

export const MIN_WINDOW_MS = 1500;

interface Run<T> {
  frames: T[];
  startMs: number;
  endMs: number;
}

function contiguousRuns<T extends { tMs: number }>(
  frames: T[],
  predicate: (frame: T) => boolean
): Run<T>[] {
  const runs: Run<T>[] = [];
  let current: T[] = [];
  const flush = () => {
    if (current.length > 0) {
      runs.push({
        frames: current,
        startMs: current[0].tMs,
        endMs: current[current.length - 1].tMs
      });
      current = [];
    }
  };
  for (const frame of frames) {
    if (predicate(frame)) current.push(frame);
    else flush();
  }
  flush();
  return runs.filter((run) => run.endMs - run.startMs >= MIN_WINDOW_MS);
}

function speechConfounds(frames: AudioFeatureFrame[]): ConfoundEnvelope {
  return {
    snrDb: mean(frames.map((f) => f.snrDb)),
    faceFramingFraction: 0,
    observedFrameRate: 0,
    illuminationRelative: 0
  };
}

function faceConfounds(frames: FaceLandmarkFrame[]): ConfoundEnvelope {
  return {
    snrDb: 0,
    faceFramingFraction: mean(frames.map((f) => f.framingFraction)),
    observedFrameRate: mean(frames.map((f) => f.observedFrameRate)),
    illuminationRelative: mean(frames.map((f) => f.illumination))
  };
}

export function detectMeasurableWindows(stream: FrameStream): MeasurableWindow[] {
  const windows: MeasurableWindow[] = [];

  contiguousRuns(stream.audio, (f) => f.voiced).forEach((run, i) => {
    windows.push({
      windowId: `speech-${i}`,
      modality: "speech",
      startMs: run.startMs,
      endMs: run.endMs,
      context: { kind: "spontaneous-speech", confounds: speechConfounds(run.frames) }
    });
  });

  contiguousRuns(stream.face, (f) => f.faceVisible).forEach((run, i) => {
    windows.push({
      windowId: `face-${i}`,
      modality: "face",
      startMs: run.startMs,
      endMs: run.endMs,
      context: { kind: "listening-expressive", confounds: faceConfounds(run.frames) }
    });
  });

  const modalityOrder: Record<Modality, number> = { speech: 0, face: 1 };
  return windows.sort(
    (a, b) => a.startMs - b.startMs || modalityOrder[a.modality] - modalityOrder[b.modality]
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ambient-core/src/windowing.ts packages/ambient-core/src/windowing.test.ts
git commit -m "feat: add measurable-window detection"
```

---

## Task 9: Per-biomarker robust aggregation

**Files:**
- Create: `packages/ambient-core/src/aggregate.ts`
- Test: `packages/ambient-core/src/aggregate.test.ts`

**Interfaces:**
- Consumes: `Measurement`, `MeasurementContextKind`, `BiomarkerAggregate` (Tasks 2–3); `median`, `medianAbsoluteDeviation` (Task 5).
- Produces:
  - `aggregateMeasurements(measurements: Measurement[], contextByWindowId: Map<string, MeasurementContextKind>, labelByCode: Map<string, { label: string; unit: string }>): BiomarkerAggregate[]`
  - Groups measurements by `code`, computes the median as `value` and the median absolute deviation as `spread`, sets `windowCount` to the number of contributing measurements, and carries the single shared `algorithmVersion` (throws if a code mixes versions). Aggregates are returned sorted by `code`.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/aggregate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregateMeasurements } from "./aggregate.js";
import type { Measurement, MeasurementContextKind } from "@phenometrix/contracts";

function m(code: string, value: number): Measurement {
  return {
    code, label: code, value, unit: "u", confidence: 0.9,
    uncertainty: "placeholder", algorithmVersion: "speech-acoustic-0.1",
    clinicalValidation: "none", contextRef: "speech-0", windowStartMs: 0,
    windowEndMs: 2000, evidenceSnippetRef: null
  };
}

describe("aggregateMeasurements", () => {
  it("computes median and MAD per code with a stable window count", () => {
    const context = new Map<string, MeasurementContextKind>([["speech-0", "spontaneous-speech"]]);
    const labels = new Map([["prototype.speech.pause_count", { label: "Pause count", unit: "count" }]]);
    const result = aggregateMeasurements(
      [m("prototype.speech.pause_count", 2), m("prototype.speech.pause_count", 4), m("prototype.speech.pause_count", 6)],
      context, labels
    );
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(4);
    expect(result[0].spread).toBe(2);
    expect(result[0].windowCount).toBe(3);
    expect(result[0].contextKind).toBe("spontaneous-speech");
    expect(result[0].label).toBe("Pause count");
  });

  it("throws when a code mixes algorithm versions", () => {
    const context = new Map<string, MeasurementContextKind>([["speech-0", "spontaneous-speech"]]);
    const labels = new Map([["c", { label: "c", unit: "u" }]]);
    const a = m("c", 1);
    const b = { ...m("c", 2), algorithmVersion: "speech-acoustic-0.2" };
    expect(() => aggregateMeasurements([a, b], context, labels)).toThrow(/mixes algorithm versions/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./aggregate.js`.

- [ ] **Step 3: Write the aggregator**

Create `packages/ambient-core/src/aggregate.ts`:

```ts
import type {
  BiomarkerAggregate,
  Measurement,
  MeasurementContextKind
} from "@phenometrix/contracts";
import { median, medianAbsoluteDeviation } from "./stats.js";

export function aggregateMeasurements(
  measurements: Measurement[],
  contextByWindowId: Map<string, MeasurementContextKind>,
  labelByCode: Map<string, { label: string; unit: string }>
): BiomarkerAggregate[] {
  const byCode = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const bucket = byCode.get(measurement.code) ?? [];
    bucket.push(measurement);
    byCode.set(measurement.code, bucket);
  }

  const aggregates: BiomarkerAggregate[] = [];
  for (const [code, bucket] of byCode) {
    const versions = new Set(bucket.map((m) => m.algorithmVersion));
    if (versions.size > 1) {
      throw new Error(`Biomarker ${code} mixes algorithm versions: ${[...versions].join(", ")}`);
    }
    const values = bucket.map((m) => m.value);
    const contextKind =
      contextByWindowId.get(bucket[0].contextRef) ?? "spontaneous-speech";
    const label = labelByCode.get(code) ?? { label: code, unit: bucket[0].unit };
    aggregates.push({
      code,
      label: label.label,
      unit: label.unit,
      contextKind,
      value: median(values),
      spread: medianAbsoluteDeviation(values),
      windowCount: bucket.length,
      algorithmVersion: bucket[0].algorithmVersion,
      uncertainty: "placeholder",
      clinicalValidation: "none"
    });
  }

  return aggregates.sort((a, b) => a.code.localeCompare(b.code));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ambient-core/src/aggregate.ts packages/ambient-core/src/aggregate.test.ts
git commit -m "feat: add per-biomarker robust aggregation"
```

---

## Task 10: Event factory

**Files:**
- Create: `packages/ambient-core/src/events.ts`
- Test: `packages/ambient-core/src/events.test.ts`

**Interfaces:**
- Consumes: `EventEnvelope`, `AmbientActorId`, `AmbientEventType` (Task 3).
- Produces:
  - `createEventFactory(input: { visitId: string; participantId: string; baseTimeMs: number }): EventFactory`
  - `EventFactory.next(actorId: AmbientActorId, type: AmbientEventType, summary: string, occurredAtMs: number, payload?, evidenceRefs?): EventEnvelope`
  - Each call increments a monotonic `sequence` starting at 1, sets `eventId` to `${sequence}-${type}`, sets `actor.lane` equal to `actor.id`, and computes `occurredAt` from `baseTimeMs + occurredAtMs` as an ISO string. Timestamps never move backward across calls (later calls clamp `occurredAtMs` to at least the previous value).

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEventFactory } from "./events.js";

describe("createEventFactory", () => {
  it("produces monotonic sequences, lane identity, and non-decreasing timestamps", () => {
    const factory = createEventFactory({
      visitId: "visit-001",
      participantId: "synthetic-participant-001",
      baseTimeMs: Date.parse("2026-07-18T16:00:00.000Z")
    });
    const first = factory.next("capture-conductor", "capture.window.detected", "Detected a window.", 0);
    const second = factory.next("speech-acoustic", "measurement.recorded", "Recorded a measurement.", -500);

    expect(first.sequence).toBe(1);
    expect(first.eventId).toBe("1-capture.window.detected");
    expect(first.actor.lane).toBe("capture-conductor");
    expect(first.stage).toBe("ambient-capture");
    expect(second.sequence).toBe(2);
    expect(Date.parse(second.occurredAt)).toBeGreaterThanOrEqual(Date.parse(first.occurredAt));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./events.js`.

- [ ] **Step 3: Write the event factory**

Create `packages/ambient-core/src/events.ts`:

```ts
import type { AmbientActorId, AmbientEventType, EventEnvelope } from "@phenometrix/contracts";

export interface EventFactory {
  next(
    actorId: AmbientActorId,
    type: AmbientEventType,
    summary: string,
    occurredAtMs: number,
    payload?: Record<string, unknown>,
    evidenceRefs?: string[]
  ): EventEnvelope;
}

export function createEventFactory(input: {
  visitId: string;
  participantId: string;
  baseTimeMs: number;
}): EventFactory {
  let sequence = 0;
  let lastOffsetMs = 0;

  return {
    next(actorId, type, summary, occurredAtMs, payload = {}, evidenceRefs = []) {
      sequence += 1;
      lastOffsetMs = Math.max(lastOffsetMs, occurredAtMs);
      return {
        schemaVersion: "phenometric.ambient-event.v0.1",
        eventId: `${sequence}-${type}`,
        sequence,
        occurredAt: new Date(input.baseTimeMs + lastOffsetMs).toISOString(),
        visitId: input.visitId,
        participantId: input.participantId,
        actor: { kind: "agent", id: actorId, lane: actorId, version: "0.1.0" },
        type,
        stage: "ambient-capture",
        summary,
        payload,
        evidenceRefs
      };
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ambient-core/src/events.ts packages/ambient-core/src/events.test.ts
git commit -m "feat: add ambient event factory"
```

---

## Task 11: Capture Conductor and headless end-to-end replay

**Files:**
- Create: `packages/ambient-core/src/conductor.ts`
- Create: `packages/ambient-core/fixtures/synthetic-visit.frames.json`
- Modify: `packages/ambient-core/src/index.ts`
- Test: `packages/ambient-core/src/conductor.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–10.
- Produces:
  - `runConductor(stream: FrameStream, options?: { baseTimeMs?: number }): { observation: EncounterObservation; events: EventEnvelope[] }`
  - The Conductor: detects windows; slices each window's frames by `[startMs, endMs]`; runs the matching extractor; emits `capture.window.detected` per window; emits `measurement.recorded` per measurement and `measurement.abstained` per abstention; aggregates all measurements into the per-visit `EncounterObservation`; emits a final `encounter-observation.created`. It is deterministic: identical input yields byte-identical output.
- Barrel exports `runConductor` and all public functions/constants.

- [ ] **Step 1: Write the failing test**

Create `packages/ambient-core/src/conductor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runConductor } from "./conductor.js";
import type { FrameStream } from "./primitives.js";

function loadFixture(): FrameStream {
  const path = fileURLToPath(new URL("../fixtures/synthetic-visit.frames.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as FrameStream;
}

describe("runConductor", () => {
  it("produces a per-visit observation and a lane-tagged event stream from the fixture", () => {
    const stream = loadFixture();
    const { observation, events } = runConductor(stream, { baseTimeMs: Date.parse("2026-07-18T16:00:00.000Z") });

    expect(observation.containsPHI).toBe(false);
    expect(observation.visitId).toBe(stream.visitId);
    expect(observation.aggregates.length).toBeGreaterThan(0);
    expect(observation.measurementCount).toBeGreaterThan(0);

    expect(events[0].type).toBe("capture.window.detected");
    expect(events.at(-1)!.type).toBe("encounter-observation.created");
    const lanes = new Set(events.map((e) => e.actor.lane));
    expect(lanes.has("capture-conductor")).toBe(true);
    expect(lanes.has("speech-acoustic") || lanes.has("facial-expressivity")).toBe(true);

    // sequences are monotonic 1..N
    events.forEach((event, index) => expect(event.sequence).toBe(index + 1));
  });

  it("is deterministic: identical input yields identical output", () => {
    const opts = { baseTimeMs: Date.parse("2026-07-18T16:00:00.000Z") };
    const a = runConductor(loadFixture(), opts);
    const b = runConductor(loadFixture(), opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("emits an abstention when a window is unmeasurable", () => {
    const stream = loadFixture();
    // Force the face frames low-framing so the facial agent abstains.
    const degraded: FrameStream = {
      ...stream,
      face: stream.face.map((f) => ({ ...f, framingFraction: 0.2, faceVisible: true }))
    };
    const { events } = runConductor(degraded, { baseTimeMs: 0 });
    expect(events.some((e) => e.type === "measurement.abstained")).toBe(true);
  });
});
```

- [ ] **Step 2: Create the synthetic fixture**

Create `packages/ambient-core/fixtures/synthetic-visit.frames.json`. This is a small hand-authored synthetic stream: a ~2s voiced speech run and a ~2s well-framed face run (frame steps of 100 ms). It contains no PHI and no media.

```json
{
  "visitId": "visit-001",
  "participantId": "synthetic-participant-001",
  "captureMode": "fixture-playback",
  "audio": [
    { "tMs": 0, "voiced": true, "rms": 0.40, "pitchHz": 118, "clipped": false, "snrDb": 21 },
    { "tMs": 100, "voiced": true, "rms": 0.42, "pitchHz": 122, "clipped": false, "snrDb": 21 },
    { "tMs": 200, "voiced": true, "rms": 0.38, "pitchHz": 115, "clipped": false, "snrDb": 20 },
    { "tMs": 300, "voiced": false, "rms": 0.03, "pitchHz": null, "clipped": false, "snrDb": 20 },
    { "tMs": 400, "voiced": true, "rms": 0.41, "pitchHz": 130, "clipped": false, "snrDb": 22 },
    { "tMs": 500, "voiced": true, "rms": 0.39, "pitchHz": 126, "clipped": false, "snrDb": 21 },
    { "tMs": 600, "voiced": true, "rms": 0.43, "pitchHz": 119, "clipped": false, "snrDb": 21 },
    { "tMs": 700, "voiced": true, "rms": 0.40, "pitchHz": 121, "clipped": false, "snrDb": 20 },
    { "tMs": 800, "voiced": true, "rms": 0.42, "pitchHz": 124, "clipped": false, "snrDb": 22 },
    { "tMs": 900, "voiced": true, "rms": 0.38, "pitchHz": 117, "clipped": false, "snrDb": 21 },
    { "tMs": 1000, "voiced": true, "rms": 0.41, "pitchHz": 123, "clipped": false, "snrDb": 21 },
    { "tMs": 1100, "voiced": true, "rms": 0.40, "pitchHz": 120, "clipped": false, "snrDb": 20 },
    { "tMs": 1200, "voiced": true, "rms": 0.42, "pitchHz": 128, "clipped": false, "snrDb": 22 },
    { "tMs": 1300, "voiced": true, "rms": 0.39, "pitchHz": 116, "clipped": false, "snrDb": 21 },
    { "tMs": 1400, "voiced": true, "rms": 0.41, "pitchHz": 122, "clipped": false, "snrDb": 21 },
    { "tMs": 1500, "voiced": true, "rms": 0.40, "pitchHz": 121, "clipped": false, "snrDb": 20 },
    { "tMs": 1600, "voiced": true, "rms": 0.42, "pitchHz": 125, "clipped": false, "snrDb": 22 },
    { "tMs": 1700, "voiced": true, "rms": 0.38, "pitchHz": 118, "clipped": false, "snrDb": 21 },
    { "tMs": 1800, "voiced": true, "rms": 0.41, "pitchHz": 123, "clipped": false, "snrDb": 21 },
    { "tMs": 1900, "voiced": true, "rms": 0.40, "pitchHz": 120, "clipped": false, "snrDb": 20 }
  ],
  "face": [
    { "tMs": 0, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.30, "browRaise": 0.20, "mouthOpen": 0.10, "landmarkMotion": 0.050, "observedFrameRate": 30 },
    { "tMs": 100, "faceVisible": true, "framingFraction": 0.94, "illumination": 0.80, "eyeAspectRatio": 0.31, "browRaise": 0.22, "mouthOpen": 0.12, "landmarkMotion": 0.055, "observedFrameRate": 30 },
    { "tMs": 200, "faceVisible": true, "framingFraction": 0.96, "illumination": 0.81, "eyeAspectRatio": 0.12, "browRaise": 0.24, "mouthOpen": 0.09, "landmarkMotion": 0.061, "observedFrameRate": 30 },
    { "tMs": 300, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.30, "browRaise": 0.19, "mouthOpen": 0.11, "landmarkMotion": 0.048, "observedFrameRate": 30 },
    { "tMs": 400, "faceVisible": true, "framingFraction": 0.93, "illumination": 0.79, "eyeAspectRatio": 0.29, "browRaise": 0.26, "mouthOpen": 0.10, "landmarkMotion": 0.052, "observedFrameRate": 30 },
    { "tMs": 500, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.31, "browRaise": 0.21, "mouthOpen": 0.13, "landmarkMotion": 0.057, "observedFrameRate": 30 },
    { "tMs": 600, "faceVisible": true, "framingFraction": 0.96, "illumination": 0.82, "eyeAspectRatio": 0.30, "browRaise": 0.23, "mouthOpen": 0.10, "landmarkMotion": 0.050, "observedFrameRate": 30 },
    { "tMs": 700, "faceVisible": true, "framingFraction": 0.94, "illumination": 0.80, "eyeAspectRatio": 0.11, "browRaise": 0.18, "mouthOpen": 0.09, "landmarkMotion": 0.063, "observedFrameRate": 30 },
    { "tMs": 800, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.30, "browRaise": 0.25, "mouthOpen": 0.12, "landmarkMotion": 0.049, "observedFrameRate": 30 },
    { "tMs": 900, "faceVisible": true, "framingFraction": 0.96, "illumination": 0.81, "eyeAspectRatio": 0.32, "browRaise": 0.20, "mouthOpen": 0.11, "landmarkMotion": 0.054, "observedFrameRate": 30 },
    { "tMs": 1000, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.30, "browRaise": 0.22, "mouthOpen": 0.10, "landmarkMotion": 0.051, "observedFrameRate": 30 },
    { "tMs": 1100, "faceVisible": true, "framingFraction": 0.93, "illumination": 0.79, "eyeAspectRatio": 0.29, "browRaise": 0.27, "mouthOpen": 0.13, "landmarkMotion": 0.058, "observedFrameRate": 30 },
    { "tMs": 1200, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.31, "browRaise": 0.19, "mouthOpen": 0.10, "landmarkMotion": 0.050, "observedFrameRate": 30 },
    { "tMs": 1300, "faceVisible": true, "framingFraction": 0.96, "illumination": 0.82, "eyeAspectRatio": 0.30, "browRaise": 0.24, "mouthOpen": 0.11, "landmarkMotion": 0.053, "observedFrameRate": 30 },
    { "tMs": 1400, "faceVisible": true, "framingFraction": 0.94, "illumination": 0.80, "eyeAspectRatio": 0.13, "browRaise": 0.21, "mouthOpen": 0.09, "landmarkMotion": 0.060, "observedFrameRate": 30 },
    { "tMs": 1500, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.30, "browRaise": 0.23, "mouthOpen": 0.12, "landmarkMotion": 0.052, "observedFrameRate": 30 },
    { "tMs": 1600, "faceVisible": true, "framingFraction": 0.96, "illumination": 0.81, "eyeAspectRatio": 0.31, "browRaise": 0.20, "mouthOpen": 0.10, "landmarkMotion": 0.049, "observedFrameRate": 30 },
    { "tMs": 1700, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.30, "browRaise": 0.25, "mouthOpen": 0.11, "landmarkMotion": 0.055, "observedFrameRate": 30 },
    { "tMs": 1800, "faceVisible": true, "framingFraction": 0.94, "illumination": 0.79, "eyeAspectRatio": 0.29, "browRaise": 0.22, "mouthOpen": 0.10, "landmarkMotion": 0.051, "observedFrameRate": 30 },
    { "tMs": 1900, "faceVisible": true, "framingFraction": 0.95, "illumination": 0.80, "eyeAspectRatio": 0.30, "browRaise": 0.21, "mouthOpen": 0.12, "landmarkMotion": 0.050, "observedFrameRate": 30 }
  ]
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -w test:unit`
Expected: FAIL — cannot find `./conductor.js`.

- [ ] **Step 4: Write the Conductor**

Create `packages/ambient-core/src/conductor.ts`:

```ts
import type {
  Abstention,
  EncounterObservation,
  EventEnvelope,
  Measurement,
  MeasurableWindow,
  MeasurementContextKind
} from "@phenometrix/contracts";
import type { AudioFeatureFrame, FaceLandmarkFrame, FrameStream } from "./primitives.js";
import { detectMeasurableWindows } from "./windowing.js";
import { extractSpeechAcoustic } from "./speech-acoustic.js";
import { extractFacialExpressivity } from "./facial-expressivity.js";
import { aggregateMeasurements } from "./aggregate.js";
import { createEventFactory } from "./events.js";

const LABELS = new Map<string, { label: string; unit: string }>([
  ["prototype.speech.articulation_rate", { label: "Articulation rate", unit: "voiced-fraction" }],
  ["prototype.speech.pause_count", { label: "Pause count", unit: "count" }],
  ["prototype.speech.pitch_variability", { label: "Pitch variability", unit: "hz-stddev" }],
  ["prototype.face.expressivity", { label: "Facial expressivity", unit: "motion-index" }],
  ["prototype.face.blink_rate", { label: "Blink rate", unit: "blinks-per-minute" }],
  ["prototype.face.brow_amplitude", { label: "Brow amplitude", unit: "normalized-range" }]
]);

function slice<T extends { tMs: number }>(frames: T[], window: MeasurableWindow): T[] {
  return frames.filter((f) => f.tMs >= window.startMs && f.tMs <= window.endMs);
}

function isAbstention(result: Measurement[] | Abstention): result is Abstention {
  return !Array.isArray(result);
}

export function runConductor(
  stream: FrameStream,
  options: { baseTimeMs?: number } = {}
): { observation: EncounterObservation; events: EventEnvelope[] } {
  const factory = createEventFactory({
    visitId: stream.visitId,
    participantId: stream.participantId,
    baseTimeMs: options.baseTimeMs ?? 0
  });
  const events: EventEnvelope[] = [];
  const measurements: Measurement[] = [];
  const abstentions: Abstention[] = [];
  const contextByWindowId = new Map<string, MeasurementContextKind>();

  const windows = detectMeasurableWindows(stream);
  for (const window of windows) {
    contextByWindowId.set(window.windowId, window.context.kind);
    events.push(
      factory.next(
        "capture-conductor",
        "capture.window.detected",
        `Detected a measurable ${window.modality} window.`,
        window.startMs,
        { windowId: window.windowId, modality: window.modality, contextKind: window.context.kind }
      )
    );

    const result: Measurement[] | Abstention =
      window.modality === "speech"
        ? extractSpeechAcoustic(window, slice(stream.audio as AudioFeatureFrame[], window))
        : extractFacialExpressivity(window, slice(stream.face as FaceLandmarkFrame[], window));

    const actorId = window.modality === "speech" ? "speech-acoustic" : "facial-expressivity";

    if (isAbstention(result)) {
      abstentions.push(result);
      events.push(
        factory.next(
          actorId,
          "measurement.abstained",
          `Abstained on ${window.modality} window: ${result.reasonCode}.`,
          window.startMs,
          { windowId: window.windowId, reasonCode: result.reasonCode }
        )
      );
      continue;
    }

    for (const measurement of result) {
      measurements.push(measurement);
      events.push(
        factory.next(
          actorId,
          "measurement.recorded",
          `Recorded ${measurement.label}.`,
          window.startMs,
          { windowId: window.windowId, code: measurement.code, value: measurement.value }
        )
      );
    }
  }

  const aggregates = aggregateMeasurements(measurements, contextByWindowId, LABELS);
  const observation: EncounterObservation = {
    containsPHI: false,
    captureMode: stream.captureMode,
    visitId: stream.visitId,
    participantId: stream.participantId,
    aggregates,
    abstentions,
    measurementCount: measurements.length
  };

  events.push(
    factory.next(
      "capture-conductor",
      "encounter-observation.created",
      `Created a per-visit observation with ${aggregates.length} biomarker aggregates.`,
      windows.at(-1)?.endMs ?? 0,
      { visitId: stream.visitId, aggregateCount: aggregates.length, measurementCount: measurements.length }
    )
  );

  return { observation, events };
}
```

- [ ] **Step 5: Update the barrel export**

Replace `packages/ambient-core/src/index.ts`:

```ts
export const AMBIENT_CORE_VERSION = "0.1.0";
export type { AudioFeatureFrame, FaceLandmarkFrame, FrameStream } from "./primitives.js";
export { extractSpeechAcoustic, SPEECH_ACOUSTIC_VERSION, SPEECH_SNR_FLOOR_DB } from "./speech-acoustic.js";
export { extractFacialExpressivity, FACIAL_EXPRESSIVITY_VERSION, FACE_FRAMING_FLOOR, BLINK_EAR_THRESHOLD } from "./facial-expressivity.js";
export { detectMeasurableWindows, MIN_WINDOW_MS } from "./windowing.js";
export { aggregateMeasurements } from "./aggregate.js";
export { createEventFactory } from "./events.js";
export type { EventFactory } from "./events.js";
export { runConductor } from "./conductor.js";
```

- [ ] **Step 6: Run the full suite and typecheck**

Run:
```bash
pnpm -w test:unit
pnpm --filter @phenometrix/ambient-core exec tsc --noEmit
```
Expected: all tests PASS; `tsc` reports no errors.

- [ ] **Step 7: Verify the legacy structure check still passes**

Run: `npm run check`
Expected: prints `PhenoMetrix structure and event stream are valid.`

- [ ] **Step 8: Commit**

```bash
git add packages/ambient-core/src/conductor.ts packages/ambient-core/src/conductor.test.ts packages/ambient-core/fixtures/synthetic-visit.frames.json packages/ambient-core/src/index.ts
git commit -m "feat: add Capture Conductor and headless end-to-end replay"
```

---

## Follow-up plans (explicit scope decomposition)

These are deliberately out of scope for this plan. Each becomes its own spec → plan cycle so it produces working, testable software on its own.

1. **Browser real-time ingestion pipeline** (`apps/capture-web`): tap `getUserMedia`, compute the two primitive streams live (Web Audio VAD/pitch; MediaPipe Face Landmarker), publish `AudioFeatureFrame`/`FaceLandmarkFrame` on the bus, and run `runConductor` incrementally. Includes the rolling-buffer→evidence-snippet promotion and the continuous-analysis consent surface.
2. **Longitudinal store + trending** (Capability #2 re-key): persist per-visit `EncounterObservation`s, and add `assessComparability()` that matches on `MeasurementContextKind` + confound-envelope tolerance and gates on `algorithmVersion`, producing a `TrajectoryComparison` across visits.
3. **UI: multi-lane flight recorder, longitudinal reveal, evidence card** (`apps/clinician-review`): render the lane-tagged event stream live, the camera-to-timeline transition, and the grounded evidence card with claim→measurement→snippet→event traceability and clinician accept/reject.

---

## Self-Review

**Spec coverage:**
- Subagent team (Ingestion primitives, Conductor, 2 extractors, windowing) → Tasks 4, 6, 7, 8, 11. (Live ingestion itself is a follow-up plan; its input contract is Task 4.)
- Shared stats util (mean/stdDev/median/MAD, defined once) → Task 5, consumed by Tasks 6, 7, 8, 9.
- `Task`→`MeasurementContext` + confound envelope → Task 2.
- Per-window `CaptureQuality`/abstention → Tasks 6, 7 (abstention), abstention events in Task 11.
- `EncounterObservation` as per-visit robust aggregate → Tasks 3, 9, 11.
- Agent-lane event stream → Tasks 3, 10, 11.
- Ephemeral (no raw media) → enforced by design (primitives only) + Global Constraints.
- Determinism / fixture replay testing → Task 11; abstention and aggregate-stability tests → Tasks 6/7/9/11 (comparability gating deferred with its subsystem to follow-up plan 2, noted).
- Comparability/trending, browser pipeline, UI, grounding → explicitly deferred to follow-up plans.

**Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N". Every code step shows complete code.

**Type consistency:** `Measurement`, `Abstention`, `MeasurableWindow`, `EncounterObservation`, `EventEnvelope`, `AmbientActorId` names match across contracts (Tasks 2–3) and consumers (Tasks 6–11). Shared stats helpers are defined in Task 5 and imported by Tasks 6, 7, 8, 9 (no local redefinition). Extractor return type `Measurement[] | Abstention` is consistent in Tasks 6, 7, and 11's `isAbstention` guard. `aggregateMeasurements` signature in Task 9 matches its call in Task 11. `createEventFactory`/`EventFactory.next` signature in Task 10 matches its calls in Task 11.
