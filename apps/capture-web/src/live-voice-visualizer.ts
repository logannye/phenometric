import type { VoiceSignalFrameV1 } from "@phenometric/ambient-core";

export const LIVE_VOICE_WINDOW_MS = 8_000;
export const MAX_LIVE_VOICE_SAMPLES = 800;
export const MIN_LIVE_PITCH_HZ = 60;
export const MAX_LIVE_PITCH_HZ = 400;

/**
 * Display ballistics for the live gauges. The voice worker emits a frame every
 * 10 ms (100 Hz); painting raw per-frame values reads as flicker rather than
 * signal, so the gauges are given meter ballistics and the numerics are
 * stepped at a rate a person can actually read.
 *
 * These are the "calm instrument" values. For a more obviously live-feeling
 * readout use attack 40 / release 250 / numeric 12 / voiced fade 250.
 *
 * Presentation only: nothing here touches a measured value. The history that
 * feeds the traces, and every frame handed to ambient-core, stay raw.
 */
export const LIVE_VOICE_BALLISTICS = {
  /** Rise time constant — short, so onsets still feel immediate. */
  attackMs: 80,
  /** Fall time constant — long, so the needle settles instead of chattering. */
  releaseMs: 450,
  /** How often the digits are allowed to change. */
  numericHz: 8,
  /** Fade of the pitch gauge when phonation stops. */
  voicedFadeMs: 500,
  /** How long a new activity state must persist before the badge follows. */
  stateDwellMs: 180
} as const;

/** Below this the gauge has settled and the animation loop can stop. */
const SETTLED_EPSILON = 0.001;

/**
 * One exponential step toward `target`, with separate rise and fall time
 * constants. Derived from elapsed time rather than frame count so the motion
 * is identical on a 60 Hz and a 120 Hz display.
 */
export function ballisticsStep(
  current: number,
  target: number,
  dtMs: number,
  attackMs: number,
  releaseMs: number
): number {
  if (!Number.isFinite(target)) return current;
  if (!Number.isFinite(current)) return target;
  const tau = target > current ? attackMs : releaseMs;
  if (tau <= 0 || !Number.isFinite(dtMs) || dtMs <= 0) return target;
  const alpha = 1 - Math.exp(-dtMs / tau);
  const next = current + (target - current) * alpha;
  return Math.abs(target - next) < SETTLED_EPSILON ? target : next;
}

/** Integer dBFS — a tenth of a dB churns faster than it informs. */
export function formatLevelDbfs(levelDbfs: number): string {
  if (!Number.isFinite(levelDbfs)) return "—";
  return `${Math.round(levelDbfs)} dBFS`;
}

/** Integer hertz, or an explicit dash when there is no phonation to report. */
export function formatPitchHz(pitchHz: number | null): string {
  if (pitchHz === null || !Number.isFinite(pitchHz)) return "—";
  return `${Math.round(pitchHz)} Hz`;
}

export function formatSnrDb(snrDb: number): string {
  if (!Number.isFinite(snrDb)) return "—";
  return `${Math.round(snrDb)} dB`;
}

/** Percentages in 5-point steps; single points are noise at this cadence. */
export function quantizedPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const bounded = Math.max(0, Math.min(1, value));
  return `${Math.round((bounded * 100) / 5) * 5}%`;
}

/**
 * Holds a candidate state until it has persisted long enough to be worth
 * showing. Without this the badge restates itself at frame rate, which reads
 * as strobing even though each individual classification is correct.
 */
export class StateHysteresis<T> {
  private committed: T;
  private candidate: T;
  private candidateSinceMs: number | null = null;

  constructor(
    initial: T,
    private readonly dwellMs: number
  ) {
    this.committed = initial;
    this.candidate = initial;
  }

  /** Returns the state that should currently be displayed. */
  observe(next: T, nowMs: number): T {
    if (next === this.committed) {
      this.candidate = next;
      this.candidateSinceMs = null;
      return this.committed;
    }
    if (next !== this.candidate) {
      this.candidate = next;
      this.candidateSinceMs = nowMs;
      return this.committed;
    }
    if (
      this.candidateSinceMs !== null &&
      nowMs - this.candidateSinceMs >= this.dwellMs
    ) {
      this.committed = next;
      this.candidateSinceMs = null;
    }
    return this.committed;
  }

  reset(value: T): void {
    this.committed = value;
    this.candidate = value;
    this.candidateSinceMs = null;
  }
}

export type LiveVoiceState =
  | "waiting"
  | "quiet"
  | "speech-noise"
  | "voiced"
  | "unavailable";

export interface LiveVoiceSample {
  tMs: number;
  levelDbfs: number;
  pitchHz: number | null;
  confidence: number;
}

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

export interface AnimationScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

const browserAnimationScheduler: AnimationScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle)
};

/**
 * Read once at construction. The stylesheet's reduced-motion block cannot
 * reach canvas painting, so the ballistics have to opt out in script.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function rmsToDbfs(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return -60;
  return Math.max(-60, Math.min(0, 20 * Math.log10(rms)));
}

export function liveVoiceStateFor(
  frame: Pick<VoiceSignalFrameV1, "speechActive" | "periodic">
): Exclude<LiveVoiceState, "waiting" | "unavailable"> {
  if (frame.speechActive && frame.periodic) return "voiced";
  if (frame.speechActive) return "speech-noise";
  return "quiet";
}

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

export class LiveVoiceHistory {
  private samples: LiveVoiceSample[] = [];

  add(frame: VoiceSignalFrameV1): readonly LiveVoiceSample[] {
    const previous = this.samples.at(-1);
    if (previous && frame.tMs < previous.tMs) this.samples = [];
    this.samples.push({
      tMs: frame.tMs,
      levelDbfs: rmsToDbfs(frame.rms),
      pitchHz:
        frame.periodic && frame.f0Hz !== null && Number.isFinite(frame.f0Hz)
          ? Math.max(
              MIN_LIVE_PITCH_HZ,
              Math.min(MAX_LIVE_PITCH_HZ, frame.f0Hz)
            )
          : null,
      confidence: Number.isFinite(frame.f0Confidence)
        ? Math.max(0, Math.min(1, frame.f0Confidence))
        : 0
    });
    const cutoff = frame.tMs - LIVE_VOICE_WINDOW_MS;
    while (
      this.samples.length > MAX_LIVE_VOICE_SAMPLES ||
      (this.samples[0]?.tMs ?? cutoff) < cutoff
    ) {
      this.samples.shift();
    }
    return this.snapshot();
  }

  snapshot(): readonly LiveVoiceSample[] {
    return this.samples;
  }

  clear(): void {
    this.samples = [];
  }
}

function finitePercent(value: number): string {
  const bounded = Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
  return `${Math.round(bounded * 100)}%`;
}

function stateLabel(state: LiveVoiceState): string {
  if (state === "voiced") return "Voiced speech";
  if (state === "speech-noise") return "Speech/noise";
  if (state === "quiet") return "Quiet/background";
  if (state === "unavailable") return "Microphone unavailable";
  return "Waiting for signal";
}

function prepareCanvas(
  canvas: HTMLCanvasElement
): { context: CanvasRenderingContext2D; width: number; height: number } | null {
  const context = canvas.getContext("2d");
  if (!context) return null;
  // The caps also prevent an intrinsic-size feedback loop if stylesheet
  // loading is delayed or blocked while the development bundle starts.
  const width = Math.max(
    1,
    Math.min(640, canvas.clientWidth || canvas.width || 320)
  );
  const height = Math.max(
    1,
    Math.min(160, canvas.clientHeight || canvas.height || 96)
  );
  const ratio = Math.max(
    1,
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
  );
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  context.strokeStyle = "rgba(216, 223, 218, 0.72)";
  context.lineWidth = 1;
  context.beginPath();
  for (let index = 1; index < 4; index += 1) {
    const y = (height * index) / 4;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
}

function drawTrace(
  canvas: HTMLCanvasElement,
  samples: readonly LiveVoiceSample[],
  kind: "energy" | "pitch" | "clarity"
): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  drawGrid(context, width, height);
  if (samples.length === 0) return;

  const latestMs = samples.at(-1)?.tMs ?? 0;
  const windowStartMs = Math.max(0, latestMs - LIVE_VOICE_WINDOW_MS);
  const xFor = (tMs: number) =>
    ((tMs - windowStartMs) / LIVE_VOICE_WINDOW_MS) * width;
  const yFor = (sample: LiveVoiceSample) => {
    if (kind === "energy") {
      return ((0 - sample.levelDbfs) / 60) * height;
    }
    if (kind === "clarity") {
      return (1 - sample.confidence) * height;
    }
    return (
      ((MAX_LIVE_PITCH_HZ - (sample.pitchHz ?? MIN_LIVE_PITCH_HZ)) /
        (MAX_LIVE_PITCH_HZ - MIN_LIVE_PITCH_HZ)) *
      height
    );
  };

  if (kind === "clarity") {
    const first = samples[0];
    const last = samples.at(-1);
    if (!first || !last) return;
    context.fillStyle = "rgba(127, 240, 207, .28)";
    context.beginPath();
    context.moveTo(xFor(first.tMs), height);
    for (const sample of samples) {
      const x = xFor(sample.tMs);
      const y = yFor(sample);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      context.lineTo(x, y);
    }
    context.lineTo(xFor(last.tMs), height);
    context.closePath();
    context.fill();
    return;
  }

  context.strokeStyle = kind === "energy" ? "#0b8d6b" : "#6b55c5";
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  let drawing = false;
  for (const sample of samples) {
    if (kind === "pitch" && sample.pitchHz === null) {
      drawing = false;
      continue;
    }
    const x = xFor(sample.tMs);
    const y = yFor(sample);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (drawing) context.lineTo(x, y);
    else context.moveTo(x, y);
    drawing = true;
  }
  context.stroke();
}

interface GaugeOptions {
  /**
   * 0..1 presence of the arc and its readout. Used to fade the pitch gauge
   * out while phonation is absent, rather than driving it to zero — zero is a
   * pitch reading, and there is no pitch to report.
   */
  alpha?: number;
  /** Readout drawn inside the arc. Defaults to the fraction as a percentage. */
  valueText?: string;
}

function drawGauge(
  canvas: HTMLCanvasElement,
  fraction: number,
  label: string,
  options: GaugeOptions = {}
): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  const clamped = Number.isFinite(fraction)
    ? Math.max(0, Math.min(1, fraction))
    : 0;
  const alpha = Number.isFinite(options.alpha ?? 1)
    ? Math.max(0, Math.min(1, options.alpha ?? 1))
    : 1;
  const centerX = width / 2;
  // A 270° gauge (open at the bottom) spans ~2·r horizontally and ~1.71·r
  // vertically; bound the radius by BOTH so the arc never clips its canvas.
  const radius = Math.max(4, Math.min(width * 0.4, (height - 14) / 2.05));
  const lineWidth = Math.max(3, radius * 0.2);
  // Seat the arc's top just below the canvas top so its full sweep + the label fit.
  const centerY = radius + lineWidth / 2 + 2;
  const startAngle = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;

  context.lineCap = "round";
  context.lineWidth = lineWidth;

  // The track stays at full strength so the gauge keeps its shape while the
  // reading fades; only the value arc and its readout carry `alpha`.
  context.strokeStyle = "rgba(140, 128, 255, .22)";
  context.beginPath();
  context.arc(centerX, centerY, radius, startAngle, startAngle + sweep);
  context.stroke();

  if (alpha > 0) {
    context.strokeStyle = `rgba(127, 240, 207, ${alpha.toFixed(3)})`;
    context.beginPath();
    context.arc(
      centerX,
      centerY,
      radius,
      startAngle,
      startAngle + sweep * clamped
    );
    context.stroke();
  }

  context.fillStyle = `rgba(233, 236, 255, ${Math.max(0.25, alpha).toFixed(3)})`;
  context.font = "700 .62rem ui-monospace, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    options.valueText ?? `${Math.round(clamped * 100)}%`,
    centerX,
    centerY
  );

  context.fillStyle = "#8b97c8";
  context.font = "600 .5rem ui-monospace, monospace";
  context.fillText(label, centerX, height - 6);
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

export class LiveVoiceVisualizer {
  private readonly elements: LiveVoiceElements;
  private readonly history = new LiveVoiceHistory();
  private readonly scheduler: AnimationScheduler;
  private readonly reducedMotion: boolean;
  private animationHandle: number | null = null;

  /** Latest frame; the paint reads this rather than painting per frame. */
  private latest: VoiceSignalFrameV1 | null = null;
  private displayedLevel = 0;
  private displayedPitch = 0;
  /** Presence of the pitch reading, faded rather than zeroed. */
  private voicedAlpha = 0;
  /** Last pitch actually observed, held through unvoiced stretches. */
  private heldPitchHz: number | null = null;
  private lastPaintAtMs: number | null = null;
  private lastNumericAtMs: number | null = null;
  private readonly stateGate = new StateHysteresis<LiveVoiceState>(
    "waiting",
    LIVE_VOICE_BALLISTICS.stateDwellMs
  );

  constructor(
    elements: LiveVoiceElements,
    scheduler: AnimationScheduler = browserAnimationScheduler,
    reducedMotion: boolean = prefersReducedMotion()
  ) {
    this.elements = elements;
    this.scheduler = scheduler;
    this.reducedMotion = reducedMotion;
    this.reset();
  }

  push(frame: VoiceSignalFrameV1): void {
    const samples = this.history.add(frame);
    this.latest = frame;
    // Sample counts are structural state the e2e suite asserts on, so they
    // stay synchronous; everything a human reads is painted on the loop.
    this.elements.energyCanvas.dataset.sampleCount = String(samples.length);
    this.elements.pitchCanvas.dataset.sampleCount = String(samples.length);
    this.elements.clarityCanvas.dataset.sampleCount = String(samples.length);
    this.schedule();
  }

  private schedule(): void {
    if (this.animationHandle !== null) return;
    this.animationHandle = this.scheduler.request((timestamp) => {
      this.animationHandle = null;
      this.render(timestamp);
    });
  }

  setUnavailable(): void {
    this.reset();
    this.setState("unavailable");
    this.elements.quality.textContent =
      "No microphone frames are available for live display.";
  }

  reset(): void {
    this.history.clear();
    if (this.animationHandle !== null) {
      this.scheduler.cancel(this.animationHandle);
      this.animationHandle = null;
    }
    this.latest = null;
    this.displayedLevel = 0;
    this.displayedPitch = 0;
    this.voicedAlpha = 0;
    this.heldPitchHz = null;
    this.lastPaintAtMs = null;
    this.lastNumericAtMs = null;
    this.stateGate.reset("waiting");
    clearCanvas(this.elements.energyCanvas);
    clearCanvas(this.elements.pitchCanvas);
    clearCanvas(this.elements.clarityCanvas);
    clearCanvas(this.elements.levelGauge);
    clearCanvas(this.elements.pitchGauge);
    this.elements.energyCanvas.dataset.sampleCount = "0";
    this.elements.pitchCanvas.dataset.sampleCount = "0";
    this.elements.clarityCanvas.dataset.sampleCount = "0";
    this.elements.level.textContent = "—";
    this.elements.pitch.textContent = "—";
    this.elements.snr.textContent = "—";
    this.elements.confidence.textContent = "—";
    this.elements.agreement.textContent = "—";
    this.elements.quality.textContent = "No live signal yet.";
    this.setState("waiting");
  }

  sampleCount(): number {
    return this.history.snapshot().length;
  }

  private render(timestamp: number): void {
    const nowMs = Number.isFinite(timestamp) ? timestamp : 0;
    // Clamp so a backgrounded tab resuming doesn't jump the needle.
    const dtMs =
      this.lastPaintAtMs === null
        ? 16
        : Math.max(0, Math.min(100, nowMs - this.lastPaintAtMs));
    this.lastPaintAtMs = nowMs;

    const samples = this.history.snapshot();
    drawTrace(this.elements.energyCanvas, samples, "energy");
    drawTrace(this.elements.pitchCanvas, samples, "pitch");
    drawTrace(this.elements.clarityCanvas, samples, "clarity");

    const latest = samples.at(-1);
    const frame = this.latest;
    const levelTarget = latest ? levelGaugeFraction(latest.levelDbfs) : 0;
    const voiced = latest?.pitchHz !== null && latest?.pitchHz !== undefined;
    if (voiced) this.heldPitchHz = latest?.pitchHz ?? this.heldPitchHz;
    // Hold the last pitch through unvoiced frames. Driving this to zero would
    // paint 0 Hz, which is a reading rather than the absence of one.
    const pitchTarget = pitchGaugeFraction(this.heldPitchHz);
    const alphaTarget = voiced ? 1 : 0;

    if (this.reducedMotion) {
      this.displayedLevel = levelTarget;
      this.displayedPitch = pitchTarget;
      this.voicedAlpha = alphaTarget;
    } else {
      const { attackMs, releaseMs, voicedFadeMs } = LIVE_VOICE_BALLISTICS;
      this.displayedLevel = ballisticsStep(
        this.displayedLevel,
        levelTarget,
        dtMs,
        attackMs,
        releaseMs
      );
      this.displayedPitch = ballisticsStep(
        this.displayedPitch,
        pitchTarget,
        dtMs,
        attackMs,
        releaseMs
      );
      this.voicedAlpha = ballisticsStep(
        this.voicedAlpha,
        alphaTarget,
        dtMs,
        attackMs,
        voicedFadeMs
      );
    }

    drawGauge(this.elements.levelGauge, this.displayedLevel, "LVL");
    drawGauge(this.elements.pitchGauge, this.displayedPitch, "F0", {
      alpha: this.voicedAlpha,
      valueText: formatPitchHz(this.voicedAlpha > 0.02 ? this.heldPitchHz : null)
    });

    if (frame) {
      this.setState(this.stateGate.observe(liveVoiceStateFor(frame), nowMs));
      this.paintNumerics(frame, nowMs);
    }

    // Keep painting while anything is still easing, so a release finishes
    // even after the frames stop arriving.
    if (
      Math.abs(this.displayedLevel - levelTarget) > SETTLED_EPSILON ||
      Math.abs(this.displayedPitch - pitchTarget) > SETTLED_EPSILON ||
      Math.abs(this.voicedAlpha - alphaTarget) > SETTLED_EPSILON
    ) {
      this.schedule();
    }
  }

  /** Digits step at a readable rate rather than at frame rate. */
  private paintNumerics(frame: VoiceSignalFrameV1, nowMs: number): void {
    const intervalMs = 1_000 / LIVE_VOICE_BALLISTICS.numericHz;
    if (
      this.lastNumericAtMs !== null &&
      nowMs - this.lastNumericAtMs < intervalMs
    ) {
      return;
    }
    this.lastNumericAtMs = nowMs;
    this.elements.level.textContent = formatLevelDbfs(rmsToDbfs(frame.rms));
    this.elements.pitch.textContent = formatPitchHz(
      frame.periodic ? frame.f0Hz : this.heldPitchHz
    );
    this.elements.snr.textContent = formatSnrDb(frame.snrDb);
    this.elements.confidence.textContent = quantizedPercent(frame.f0Confidence);
    this.elements.agreement.textContent = quantizedPercent(
      frame.estimatorAgreement
    );
    const quality =
      frame.qualityReasons.length > 0
        ? `Signal checks: ${frame.qualityReasons.join(", ")}`
        : "Signal checks passing";
    if (this.elements.quality.textContent !== quality) {
      this.elements.quality.textContent = quality;
    }
  }

  private setState(state: LiveVoiceState): void {
    if (this.elements.state.dataset.state === state) return;
    this.elements.state.dataset.state = state;
    this.elements.state.textContent = stateLabel(state);
  }
}
