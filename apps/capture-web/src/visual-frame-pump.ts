import type { VisualTaskContext } from "@phenometrix/contracts";

export const FRAME_STREAM_SCHEMA_VERSION =
  "phenometric.visual-frame-stream.v1" as const;

export interface CloseableFrame {
  close(): void;
}

export interface FrameStreamCounters {
  presented: number;
  submitted: number;
  processed: number;
  skipped: number;
  stale: number;
  failed: number;
}

export interface FrameStreamDiagnostics extends FrameStreamCounters {
  schemaVersion: typeof FRAME_STREAM_SCHEMA_VERSION;
  analyzedCadenceHz: number;
  latestInterResultGapMs: number | null;
  maximumInterResultGapMs: number | null;
  busyDropFraction: number;
  rollingWindowMs: number;
}

export interface PresentedVisualFrame<TFrame extends CloseableFrame> {
  frame: TFrame;
  acquisitionTimestampMs: number;
  width: number;
  height: number;
  taskContext?: VisualTaskContext;
}

export interface ScheduledVisualFrame<TFrame extends CloseableFrame>
  extends PresentedVisualFrame<TFrame> {
  captureEpoch: number;
  sequence: number;
  stream: FrameStreamDiagnostics;
}

export interface VisualFrameResult {
  captureEpoch: number;
  sequence: number;
  acquisitionTimestampMs: number;
}

export interface LatestFrameSchedulerOptions<TFrame extends CloseableFrame> {
  captureEpoch: number;
  onSubmit(frame: ScheduledVisualFrame<TFrame>): void;
  rollingWindowMs?: number;
}

interface TimelineSample {
  timestampMs: number;
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function trimTimeline(
  timeline: TimelineSample[],
  nowMs: number,
  rollingWindowMs: number
): void {
  const floor = nowMs - rollingWindowMs;
  while (timeline.length > 0 && timeline[0].timestampMs < floor) {
    timeline.shift();
  }
}

/**
 * Exactly one inference may be in flight. Busy frames are dropped before a
 * bitmap is retained. Transferred frames belong to the worker, which closes
 * them in a finally block.
 */
export class LatestFrameScheduler<TFrame extends CloseableFrame> {
  private captureEpoch: number;
  private readonly onSubmit: (
    frame: ScheduledVisualFrame<TFrame>
  ) => void;
  private readonly rollingWindowMs: number;
  private counters: FrameStreamCounters = {
    presented: 0,
    submitted: 0,
    processed: 0,
    skipped: 0,
    stale: 0,
    failed: 0
  };
  private sequence = 0;
  // The transferable frame itself is deliberately not retained after submit.
  // Its lifecycle belongs to the worker, which closes it in a finally block.
  private inFlight: VisualFrameResult | null = null;
  private latestPresentedTimestampMs: number | null = null;
  private latestProcessedTimestampMs: number | null = null;
  private latestInterResultGapMs: number | null = null;
  private maximumInterResultGapMs: number | null = null;
  private stopped = false;
  private readonly presentedTimeline: TimelineSample[] = [];
  private readonly skippedTimeline: TimelineSample[] = [];
  private readonly processedTimeline: TimelineSample[] = [];

  constructor(options: LatestFrameSchedulerOptions<TFrame>) {
    if (!Number.isInteger(options.captureEpoch) || options.captureEpoch < 0) {
      throw new Error("captureEpoch must be a nonnegative integer.");
    }
    this.captureEpoch = options.captureEpoch;
    this.onSubmit = options.onSubmit;
    this.rollingWindowMs = options.rollingWindowMs ?? 2_000;
    if (!finiteNonnegative(this.rollingWindowMs) || this.rollingWindowMs === 0) {
      throw new Error("rollingWindowMs must be greater than zero.");
    }
  }

  offer(frame: PresentedVisualFrame<TFrame>): boolean {
    this.counters.presented += 1;
    if (!finiteNonnegative(frame.acquisitionTimestampMs)) {
      this.counters.failed += 1;
      frame.frame.close();
      return false;
    }
    this.presentedTimeline.push({
      timestampMs: frame.acquisitionTimestampMs
    });

    if (
      this.stopped ||
      (this.latestPresentedTimestampMs !== null &&
        frame.acquisitionTimestampMs <= this.latestPresentedTimestampMs)
    ) {
      this.counters.stale += 1;
      frame.frame.close();
      return false;
    }
    this.latestPresentedTimestampMs = frame.acquisitionTimestampMs;

    if (this.inFlight === null) {
      this.submit(frame);
      return true;
    }

    this.counters.skipped += 1;
    this.skippedTimeline.push({
      timestampMs: frame.acquisitionTimestampMs
    });
    frame.frame.close();
    return false;
  }

  accept(result: VisualFrameResult): boolean {
    if (!this.matchesInFlight(result)) {
      this.counters.stale += 1;
      return false;
    }

    this.counters.processed += 1;
    if (this.latestProcessedTimestampMs !== null) {
      const gap =
        result.acquisitionTimestampMs - this.latestProcessedTimestampMs;
      this.latestInterResultGapMs = gap;
      this.maximumInterResultGapMs =
        this.maximumInterResultGapMs === null
          ? gap
          : Math.max(this.maximumInterResultGapMs, gap);
    }
    this.latestProcessedTimestampMs = result.acquisitionTimestampMs;
    this.processedTimeline.push({
      timestampMs: result.acquisitionTimestampMs
    });
    this.inFlight = null;
    return true;
  }

  fail(result: VisualFrameResult): boolean {
    if (!this.matchesInFlight(result)) {
      this.counters.stale += 1;
      return false;
    }
    this.counters.failed += 1;
    this.inFlight = null;
    return true;
  }

  discard(result: VisualFrameResult): boolean {
    if (!this.matchesInFlight(result)) {
      this.counters.stale += 1;
      return false;
    }
    this.counters.stale += 1;
    this.inFlight = null;
    return true;
  }

  recordBusyDrop(acquisitionTimestampMs: number): void {
    this.counters.presented += 1;
    this.counters.skipped += 1;
    if (finiteNonnegative(acquisitionTimestampMs)) {
      this.presentedTimeline.push({ timestampMs: acquisitionTimestampMs });
      this.skippedTimeline.push({ timestampMs: acquisitionTimestampMs });
      this.latestPresentedTimestampMs = Math.max(
        this.latestPresentedTimestampMs ?? 0,
        acquisitionTimestampMs
      );
    }
  }

  recordCaptureFailure(acquisitionTimestampMs: number): void {
    this.counters.presented += 1;
    this.counters.failed += 1;
    if (finiteNonnegative(acquisitionTimestampMs)) {
      this.presentedTimeline.push({ timestampMs: acquisitionTimestampMs });
      this.latestPresentedTimestampMs = Math.max(
        this.latestPresentedTimestampMs ?? 0,
        acquisitionTimestampMs
      );
    }
  }

  reset(captureEpoch: number): void {
    if (!Number.isInteger(captureEpoch) || captureEpoch < 0) {
      throw new Error("captureEpoch must be a nonnegative integer.");
    }
    this.captureEpoch = captureEpoch;
    this.sequence = 0;
    this.counters = {
      presented: 0,
      submitted: 0,
      processed: 0,
      skipped: 0,
      stale: 0,
      failed: 0
    };
    this.inFlight = null;
    this.latestPresentedTimestampMs = null;
    this.latestProcessedTimestampMs = null;
    this.latestInterResultGapMs = null;
    this.maximumInterResultGapMs = null;
    this.presentedTimeline.length = 0;
    this.skippedTimeline.length = 0;
    this.processedTimeline.length = 0;
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.inFlight = null;
  }

  diagnostics(nowMs = this.latestPresentedTimestampMs ?? 0): FrameStreamDiagnostics {
    trimTimeline(this.presentedTimeline, nowMs, this.rollingWindowMs);
    trimTimeline(this.skippedTimeline, nowMs, this.rollingWindowMs);
    trimTimeline(this.processedTimeline, nowMs, this.rollingWindowMs);

    const cadence =
      this.processedTimeline.length < 2
        ? 0
        : ((this.processedTimeline.length - 1) * 1_000) /
          Math.max(
            1,
            this.processedTimeline.at(-1)!.timestampMs -
              this.processedTimeline[0].timestampMs
          );
    return {
      schemaVersion: FRAME_STREAM_SCHEMA_VERSION,
      ...this.counters,
      analyzedCadenceHz: cadence,
      latestInterResultGapMs: this.latestInterResultGapMs,
      maximumInterResultGapMs: this.maximumInterResultGapMs,
      busyDropFraction:
        this.presentedTimeline.length === 0
          ? 0
          : this.skippedTimeline.length / this.presentedTimeline.length,
      rollingWindowMs: this.rollingWindowMs
    };
  }

  get activeRequest(): VisualFrameResult | null {
    return this.inFlight;
  }

  private matchesInFlight(result: VisualFrameResult): boolean {
    return (
      this.inFlight !== null &&
      result.captureEpoch === this.inFlight.captureEpoch &&
      result.sequence === this.inFlight.sequence &&
      result.acquisitionTimestampMs ===
        this.inFlight.acquisitionTimestampMs
    );
  }

  private submit(frame: PresentedVisualFrame<TFrame>): void {
    this.sequence += 1;
    this.counters.submitted += 1;
    const scheduled: ScheduledVisualFrame<TFrame> = {
      ...frame,
      captureEpoch: this.captureEpoch,
      sequence: this.sequence,
      stream: this.diagnostics(frame.acquisitionTimestampMs)
    };
    try {
      this.onSubmit(scheduled);
      this.inFlight = {
        captureEpoch: scheduled.captureEpoch,
        sequence: scheduled.sequence,
        acquisitionTimestampMs: scheduled.acquisitionTimestampMs
      };
    } catch {
      // postMessage failed before ownership transferred.
      scheduled.frame.close();
      this.counters.failed += 1;
      this.inFlight = null;
    }
  }

}

export const MAX_WORKER_RESTARTS_PER_CAPTURE = 1;

export class VisualWorkerRestartBudget {
  private restarts = 0;

  requestRestart(): "restart" | "withhold" {
    if (this.restarts >= MAX_WORKER_RESTARTS_PER_CAPTURE) {
      return "withhold";
    }
    this.restarts += 1;
    return "restart";
  }

  reset(): void {
    this.restarts = 0;
  }

  get used(): number {
    return this.restarts;
  }
}

export type VisualLaneWithholdingReason =
  | "page-hidden"
  | "camera-unavailable"
  | "worker-unavailable"
  | "visual-frame-gap";

export interface VisualLaneHealth {
  measurable: boolean;
  reasons: VisualLaneWithholdingReason[];
}

export class VisualLaneGuard {
  private pageVisible = true;
  private cameraAvailable = true;
  private workerAvailable = true;
  private lastProcessedAtMs: number | null = null;

  markPageVisible(visible: boolean): void {
    this.pageVisible = visible;
  }

  markCameraAvailable(available: boolean): void {
    this.cameraAvailable = available;
  }

  markWorkerAvailable(available: boolean): void {
    this.workerAvailable = available;
  }

  markProcessed(atMs: number): void {
    if (finiteNonnegative(atMs)) this.lastProcessedAtMs = atMs;
  }

  evaluate(nowMs: number, maximumGapMs = 200): VisualLaneHealth {
    const reasons: VisualLaneWithholdingReason[] = [];
    if (!this.pageVisible) reasons.push("page-hidden");
    if (!this.cameraAvailable) reasons.push("camera-unavailable");
    if (!this.workerAvailable) reasons.push("worker-unavailable");
    if (
      this.lastProcessedAtMs !== null &&
      nowMs - this.lastProcessedAtMs > maximumGapMs
    ) {
      reasons.push("visual-frame-gap");
    }
    return { measurable: reasons.length === 0, reasons };
  }

  reset(): void {
    this.lastProcessedAtMs = null;
    this.pageVisible = true;
    this.cameraAvailable = true;
    this.workerAvailable = true;
  }
}

/**
 * Rejects inference results acquired at or before an external withholding
 * boundary. This complements capture epochs for interruptions that must
 * invalidate an already in-flight result without restarting the worker.
 */
export class VisualResultAcceptanceGuard {
  private invalidatedThroughMs = Number.NEGATIVE_INFINITY;

  invalidateThrough(atMs: number): void {
    if (!finiteNonnegative(atMs)) return;
    this.invalidatedThroughMs = Math.max(
      this.invalidatedThroughMs,
      atMs
    );
  }

  accepts(acquiredAtMs: number): boolean {
    return (
      finiteNonnegative(acquiredAtMs) &&
      acquiredAtMs > this.invalidatedThroughMs
    );
  }

  reset(): void {
    this.invalidatedThroughMs = Number.NEGATIVE_INFINITY;
  }
}

export class OverlayRenderThrottle {
  private lastRenderedAtMs: number | null = null;

  constructor(private readonly framesPerSecond = 12) {
    if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
      throw new Error("framesPerSecond must be greater than zero.");
    }
  }

  shouldRender(atMs: number): boolean {
    if (!finiteNonnegative(atMs)) return false;
    if (
      this.lastRenderedAtMs !== null &&
      atMs - this.lastRenderedAtMs < 1_000 / this.framesPerSecond
    ) {
      return false;
    }
    this.lastRenderedAtMs = atMs;
    return true;
  }

  reset(): void {
    this.lastRenderedAtMs = null;
  }
}

export interface VideoFrameCallbackMetadataLike {
  expectedDisplayTime?: number;
  presentationTime?: number;
  width?: number;
  height?: number;
}

export interface VideoFrameCallbackSource {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly currentTime?: number;
  requestVideoFrameCallback?(
    callback: (
      now: number,
      metadata: VideoFrameCallbackMetadataLike
    ) => void
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
  requestAnimationFrame?(
    callback: (now: number) => void
  ): number;
  cancelAnimationFrame?(handle: number): void;
}

export interface VideoFramePumpOptions<TFrame extends CloseableFrame> {
  source: VideoFrameCallbackSource;
  scheduler: LatestFrameScheduler<TFrame>;
  capture(source: VideoFrameCallbackSource): Promise<TFrame>;
  taskContextAtAcquisition?: () => VisualTaskContext;
}

/**
 * Thin requestVideoFrameCallback adapter. It captures each presented frame,
 * while LatestFrameScheduler owns ordering and latest-frame-wins policy.
 */
export class VideoFramePump<TFrame extends CloseableFrame> {
  private readonly options: VideoFramePumpOptions<TFrame>;
  private callbackHandle: number | null = null;
  private running = false;
  private generation = 0;
  private callbackKind: "video" | "animation" | null = null;
  private lastObservedMediaTime: number | null = null;
  private capturePending = false;

  constructor(options: VideoFramePumpOptions<TFrame>) {
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.lastObservedMediaTime = null;
    this.capturePending = false;
    this.schedule(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (
      this.callbackHandle !== null &&
      this.callbackKind === "video" &&
      this.options.source.cancelVideoFrameCallback
    ) {
      this.options.source.cancelVideoFrameCallback(this.callbackHandle);
    } else if (
      this.callbackHandle !== null &&
      this.callbackKind === "animation" &&
      this.options.source.cancelAnimationFrame
    ) {
      this.options.source.cancelAnimationFrame(this.callbackHandle);
    }
    this.callbackHandle = null;
    this.callbackKind = null;
    this.capturePending = false;
    this.options.scheduler.stop();
  }

  private schedule(generation: number): void {
    if (this.options.source.requestVideoFrameCallback) {
      this.callbackKind = "video";
      this.callbackHandle =
        this.options.source.requestVideoFrameCallback((now, metadata) => {
          if (!this.running || generation !== this.generation) return;
          this.schedule(generation);
          this.capturePresentedFrame(
            generation,
            metadata.presentationTime ??
              metadata.expectedDisplayTime ??
              now,
            metadata.width ?? this.options.source.videoWidth,
            metadata.height ?? this.options.source.videoHeight
          );
        });
      return;
    }

    const requestAnimationFrame =
      this.options.source.requestAnimationFrame ??
      globalThis.requestAnimationFrame?.bind(globalThis);
    if (!requestAnimationFrame) {
      throw new Error(
        "Neither requestVideoFrameCallback nor requestAnimationFrame is available."
      );
    }
    this.callbackKind = "animation";
    this.callbackHandle = requestAnimationFrame((now) => {
      if (!this.running || generation !== this.generation) return;
      this.schedule(generation);
      const currentMediaTime = this.options.source.currentTime;
      if (
        currentMediaTime !== undefined &&
        this.lastObservedMediaTime === currentMediaTime
      ) {
        return;
      }
      this.lastObservedMediaTime = currentMediaTime ?? null;
      this.capturePresentedFrame(
        generation,
        now,
        this.options.source.videoWidth,
        this.options.source.videoHeight
      );
    });
  }

  private capturePresentedFrame(
    generation: number,
    acquisitionTimestampMs: number,
    width: number,
    height: number
  ): void {
    if (this.capturePending || this.options.scheduler.activeRequest !== null) {
      this.options.scheduler.recordBusyDrop(acquisitionTimestampMs);
      return;
    }
    this.capturePending = true;
    const taskContext =
      this.options.taskContextAtAcquisition?.();
    void this.options
      .capture(this.options.source)
      .then((frame) => {
        this.capturePending = false;
        if (!this.running || generation !== this.generation) {
          frame.close();
          return;
        }
        this.options.scheduler.offer({
          frame,
          acquisitionTimestampMs,
          width,
          height,
          ...(taskContext ? { taskContext } : {})
        });
      })
      .catch(() => {
        this.capturePending = false;
        if (generation === this.generation) {
          this.options.scheduler.recordCaptureFailure(
            acquisitionTimestampMs
          );
        }
      });
  }
}
