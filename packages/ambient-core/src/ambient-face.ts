import {
  median,
  medianAbsoluteDeviation,
  percentile
} from "./stats.js";
import { evaluateVisualQuality } from "./visual-quality.js";
import {
  EXPRESSION_MIN_EVENTS as AMBIENT_EXPRESSION_MIN_EVENTS,
  excursionAsymmetry,
  summarizeExpressions,
  synkinesisIndex
} from "./expression-events.js";
import type {
  BlinkEventRecord,
  DetectedBlink,
  ExpressionEventRecord,
  SubjectSide
} from "./kinematic-events.js";
import {
  measuredOutcome,
  sortedUnique,
  withheldOutcome
} from "./ambient-outcomes.js";
import {
  AMBIENT_MAX_CAPTURE_DURATION_MS,
  type AmbientExtractionResult,
  type AmbientFaceExtractionOptions,
  type AmbientFaceMetricCode,
  type AmbientFacialFrame,
  type AmbientMetricEvidence,
  type AmbientMetricOutcome,
  type AmbientWithheldReasonCode
} from "./ambient-types.js";

export const AMBIENT_FACE_BIN_MS = 5_000;
export const AMBIENT_FACE_MIN_BIN_DATA_MS = 4_000;
export const AMBIENT_FACE_MIN_BIN_SPAN_MS = 4_800;
export const AMBIENT_FACE_MIN_SAMPLES_PER_BIN = 80;
export const AMBIENT_FACE_MAX_FRAME_GAP_MS = 200;
export const AMBIENT_FACE_MIN_BINS = 3;
export const AMBIENT_FACE_MIN_SPAN_MS = 30_000;
export const AMBIENT_FACE_MAX_YAW_DEGREES = 7;
export const AMBIENT_FACE_MAX_PITCH_DEGREES = 10;
export const AMBIENT_FACE_MAX_ROLL_DEGREES = 5;
export const AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA = 0.2;
export const AMBIENT_FACE_MAX_WITHIN_BIN_SIZE_RATIO = 1.15;
export const AMBIENT_BLINK_MIN_EXPOSURE_MS = 60_000;
export const AMBIENT_BLINK_MIN_CADENCE_HZ = 24;
export const AMBIENT_BLINK_MAX_P95_GAP_MS = 75;
export const AMBIENT_BLINK_MIN_CLOSURE_MS = 50;
export const AMBIENT_BLINK_MAX_RECOVERY_MS = 800;
export const AMBIENT_BLINK_REFRACTORY_MS = 150;
export const AMBIENT_BLINK_CLOSURE_FRACTION = 0.6;
export const AMBIENT_BLINK_RECOVERY_FRACTION = 0.8;

const FACE_CODES: readonly AmbientFaceMetricCode[] = [
  "ambient.face.eye_aperture.left",
  "ambient.face.eye_aperture.right",
  "ambient.face.eye_aperture.asymmetry",
  "ambient.face.mouth_width",
  "ambient.face.mouth_aperture.median",
  "ambient.face.mouth_aperture.p90",
  "ambient.face.mouth_corner_position.asymmetry",
  "ambient.face.landmark_speed.p90",
  "ambient.face.blink_rate.bilateral",
  "ambient.face.rest_mouth_corner_asymmetry.signed",
  "ambient.face.rest_eye_aperture_asymmetry.signed",
  "ambient.face.spontaneous_event_rate",
  "ambient.face.spontaneous_excursion.p90",
  "ambient.face.spontaneous_excursion_asymmetry.median",
  "ambient.face.oculo_oral_synkinesis_index",
  "ambient.face.brow_height.left",
  "ambient.face.brow_height.right",
  "ambient.face.brow_height_asymmetry.signed",
  "ambient.face.lid_closure_completeness.left",
  "ambient.face.lid_closure_completeness.right"
];

interface TimedValue {
  tMs: number;
  value: number;
}

interface FacialBinValues {
  eyeLeft: number;
  eyeRight: number;
  eyeAsymmetry: number;
  /** Most-closed state reached in this bin, per eye. */
  eyeClosedLeft: number;
  eyeClosedRight: number;
  browLeft: number | null;
  browRight: number | null;
  mouthWidth: number;
  mouthApertureMedian: number;
  mouthApertureP90: number;
  mouthCornerAsymmetry: number;
  movementP90: number | null;
}

interface FacialBin {
  index: number;
  startMs: number;
  endMs: number;
  frames: AmbientFacialFrame[];
  durationMs: number;
  actualSpanMs: number;
  cadenceHz: number;
  processorRef: string;
  trackSegmentId: string;
  captureEpoch: number;
  sourceWindowRef: string;
  values: FacialBinValues;
}

interface BinScreening {
  bins: FacialBin[];
  attributionFailureCount: number;
  qualityFailureCount: number;
  diagnostics: FaceScreeningDiagnostics;
}

/**
 * Why a session measured what it measured, or why it measured nothing.
 *
 * Diagnostic only: no metric reads this, and it carries counts and pose
 * statistics rather than any per-frame series. It exists because a report full
 * of abstentions currently looks identical whether the camera saw nobody or saw
 * a face that never held still enough for a bin to qualify -- and those call
 * for opposite fixes.
 */
export interface FaceScreeningDiagnostics {
  frameCount: number;
  usableFrameCount: number;
  /** Frames failing each gate. A frame can fail several, so these overlap. */
  frameGateFailures: Record<string, number>;
  /** Absolute pose in degrees across all frames carrying one. */
  pose: {
    yawP50: number; yawP95: number;
    pitchP50: number; pitchP95: number;
    rollP50: number; rollP95: number;
  } | null;
  binsConsidered: number;
  binsAccepted: number;
  /** First failing check per rejected bin. */
  binRejections: Record<string, number>;
  /**
   * Per bin, how much of it survived the frame gate and what that leaves.
   *
   * `maxUsableGapMs` is the largest hole between consecutive USABLE frames --
   * the gap that would exist if unusable frames were dropped rather than the
   * whole bin. It is the reason a fractional gate is not obviously a fix:
   * dropping a burst of bad frames leaves a hole, and the gap rule may simply
   * become the new binding constraint.
   */
  bins: Array<{
    index: number;
    frameCount: number;
    usableFrameCount: number;
    usableFraction: number;
    maxUsableGapMs: number;
    /** Wall-clock extent of the usable frames; the span rule tests this. */
    usableSpanMs: number;
  }>;
  /**
   * Bins that WOULD qualify at each candidate frame-usability threshold, if the
   * all-or-nothing rule were replaced by a fractional one.
   *
   * Simulates the full consequence, not just the fraction: a bin counts only if
   * it also keeps enough usable frames and leaves no gap wider than the
   * existing limit. This is what the threshold should be chosen from.
   */
  acceptanceCurve: Array<{
    threshold: number;
    binsAccepted: number;
    lostToGap: number;
    lostToSampleCount: number;
    lostToSpan: number;
  }>;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function faceTrackSegmentId(frame: AmbientFacialFrame): string | null {
  return frame.trackSegmentId && frame.trackSegmentId.length > 0
    ? frame.trackSegmentId
    : null;
}

function nominalStepMs(frames: readonly AmbientFacialFrame[]): number {
  const gaps = frames
    .slice(1)
    .map((frame, index) => frame.tMs - frames[index].tMs)
    .filter((gap) => gap > 0 && gap <= AMBIENT_FACE_MAX_FRAME_GAP_MS);
  return gaps.length > 0 ? median(gaps) : 1000 / 30;
}

function timedPercentile(
  samples: readonly TimedValue[],
  probability: number,
  defaultStepMs: number
): number {
  if (samples.length === 0) {
    throw new Error("A time-weighted percentile requires samples.");
  }
  const sortedByTime = [...samples].sort((left, right) => left.tMs - right.tMs);
  const weighted = sortedByTime.map((sample, index) => ({
    value: sample.value,
    weight:
      index + 1 < sortedByTime.length
        ? Math.max(0, sortedByTime[index + 1].tMs - sample.tMs)
        : defaultStepMs
  }));
  const total = weighted.reduce((sum, sample) => sum + sample.weight, 0);
  if (total <= 0) {
    return percentile(
      sortedByTime.map((sample) => sample.value),
      probability
    );
  }
  weighted.sort((left, right) => left.value - right.value);
  const target = total * probability;
  let cumulative = 0;
  for (const sample of weighted) {
    cumulative += sample.weight;
    if (cumulative >= target) return sample.value;
  }
  return weighted.at(-1)!.value;
}

function validPoint(point: { x: number; y: number }): boolean {
  return finite(point.x) && finite(point.y);
}

function completeGeometry(frame: AmbientFacialFrame): boolean {
  return (
    frame.eyeAperture !== null &&
    finite(frame.eyeAperture.left) &&
    frame.eyeAperture.left >= 0 &&
    finite(frame.eyeAperture.right) &&
    frame.eyeAperture.right >= 0 &&
    frame.mouthCorners !== null &&
    validPoint(frame.mouthCorners.left) &&
    validPoint(frame.mouthCorners.right) &&
    frame.mouthApertureRatio !== null &&
    finite(frame.mouthApertureRatio) &&
    frame.mouthApertureRatio >= 0
  );
}

function calibratedSizeUsable(
  frame: AmbientFacialFrame,
  options: AmbientFaceExtractionOptions
): boolean {
  const box = frame.boundingBox;
  const calibration = options.calibration;
  if (!box || !calibration) return false;
  const widthRatio = box.widthPixels / calibration.baselineBoxWidthPixels;
  const heightRatio = box.heightPixels / calibration.baselineBoxHeightPixels;
  return (
    finite(widthRatio) &&
    finite(heightRatio) &&
    widthRatio >= 1 - AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA &&
    widthRatio <= 1 + AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA &&
    heightRatio >= 1 - AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA &&
    heightRatio <= 1 + AMBIENT_FACE_MAX_CALIBRATION_SIZE_DELTA
  );
}

/**
 * Every gate a frame failed, empty when it is usable.
 *
 * The boolean predicate is derived from this rather than duplicating it, so the
 * diagnostic view and the measurement path can never disagree about why a frame
 * was dropped. Without this the extractor rejects frames silently, and a session
 * that abstains is indistinguishable from one that never saw a face.
 */
export function frameGateFailures(
  frame: AmbientFacialFrame,
  options: AmbientFaceExtractionOptions
): string[] {
  const reasons: string[] = [];
  const pose = frame.pose;
  if (frame.faceCount !== 1) reasons.push("face-count");
  if (faceTrackSegmentId(frame) === null) reasons.push("no-track-id");
  if (!evaluateVisualQuality(frame, null).usable) reasons.push("image-quality");
  if (pose === null) {
    reasons.push("no-pose");
  } else {
    if (!finite(pose.yawDegrees) ||
        Math.abs(pose.yawDegrees) > AMBIENT_FACE_MAX_YAW_DEGREES) {
      reasons.push("yaw");
    }
    if (!finite(pose.pitchDegrees) ||
        Math.abs(pose.pitchDegrees) > AMBIENT_FACE_MAX_PITCH_DEGREES) {
      reasons.push("pitch");
    }
    if (!finite(pose.rollDegrees) ||
        Math.abs(pose.rollDegrees) > AMBIENT_FACE_MAX_ROLL_DEGREES) {
      reasons.push("roll");
    }
  }
  if (!calibratedSizeUsable(frame, options)) reasons.push("face-scale");
  if (!completeGeometry(frame)) reasons.push("incomplete-geometry");
  return reasons;
}

function ambientFrameUsable(
  frame: AmbientFacialFrame,
  options: AmbientFaceExtractionOptions
): boolean {
  return frameGateFailures(frame, options).length === 0;
}

/**
 * Whether a frame can support Tier-2 event detection.
 *
 * Deliberately looser than {@link ambientFrameUsable}: it drops the pose and
 * calibrated-scale gates and keeps attribution, image quality, and geometry
 * completeness.
 *
 * Those pose limits exist so that CROSS-FRAME GEOMETRIC COMPARISON stays valid
 * -- comparing one corner against the other, measuring asymmetry. A blink is
 * not that. It is a relative aperture change within one eye over about 150 ms,
 * during which the head pose is essentially constant, so it survives a 15 degree
 * turn intact. Holding event detection to a standard designed for a different
 * measurement cost a real 70-second session every blink and expression it
 * contained.
 *
 * Events carry {@link BlinkEventRecord.poseWithinMeasurementLimits} so a
 * consumer that DOES need geometric comparability can still filter to the
 * stricter set.
 */
function tier2FrameUsable(frame: AmbientFacialFrame): boolean {
  return (
    frame.faceCount === 1 &&
    faceTrackSegmentId(frame) !== null &&
    evaluateVisualQuality(frame, null).usable &&
    completeGeometry(frame)
  );
}

/** Whether every frame spanning an event stayed inside the Tier-3 pose limits. */
function poseWithinLimits(
  frames: readonly AmbientFacialFrame[],
  startMs: number,
  endMs: number,
  options: AmbientFaceExtractionOptions
): boolean {
  const spanning = frames.filter(
    (frame) => frame.tMs >= startMs && frame.tMs <= endMs
  );
  if (spanning.length === 0) return false;
  return spanning.every((frame) => {
    const failures = frameGateFailures(frame, options);
    return !failures.some((reason) =>
      reason === "yaw" || reason === "pitch" || reason === "roll"
    );
  });
}

function mouthWidth(frame: AmbientFacialFrame): number {
  const corners = frame.mouthCorners!;
  return Math.hypot(
    corners.left.x - corners.right.x,
    corners.left.y - corners.right.y
  );
}

function mouthCornerAsymmetry(frame: AmbientFacialFrame): number {
  const corners = frame.mouthCorners!;
  // Coordinates are inter-eye normalized around the facial midline. A
  // bilaterally mirrored pair has x values that sum to zero and equal y.
  return Math.hypot(
    corners.left.x + corners.right.x,
    corners.left.y - corners.right.y
  );
}

function makeTimed(
  frames: readonly AmbientFacialFrame[],
  selector: (frame: AmbientFacialFrame) => number | null
): TimedValue[] {
  return frames.flatMap((frame) => {
    const value = selector(frame);
    return value !== null && finite(value) ? [{ tMs: frame.tMs, value }] : [];
  });
}

function binValues(
  frames: readonly AmbientFacialFrame[],
  stepMs: number
): FacialBinValues {
  const eyeLeft = makeTimed(frames, (frame) => frame.eyeAperture!.left);
  const eyeRight = makeTimed(frames, (frame) => frame.eyeAperture!.right);
  const eyeAsymmetry = makeTimed(frames, (frame) =>
    Math.abs(frame.eyeAperture!.left - frame.eyeAperture!.right)
  );
  const browLeft = makeTimed(frames, (frame) => frame.browHeight?.left ?? null);
  const browRight = makeTimed(frames, (frame) => frame.browHeight?.right ?? null);
  const widths = makeTimed(frames, mouthWidth);
  const apertures = makeTimed(frames, (frame) => frame.mouthApertureRatio);
  const cornerAsymmetry = makeTimed(frames, mouthCornerAsymmetry);
  // The first derivative in every bin is ignored so a value calculated across
  // a bin boundary cannot masquerade as within-bin movement evidence.
  const movement = makeTimed(frames.slice(1), (frame) => {
    if (
      frame.interResultGapMs === null ||
      frame.interResultGapMs <= 0 ||
      frame.interResultGapMs > AMBIENT_FACE_MAX_FRAME_GAP_MS
    ) {
      return null;
    }
    const speed = frame.regionalMovementSpeed;
    return speed !== null && finite(speed) && speed >= 0 ? speed : null;
  });
  return {
    // P90 represents the open-eye reference while remaining robust to blinks.
    eyeLeft: timedPercentile(eyeLeft, 0.9, stepMs),
    eyeRight: timedPercentile(eyeRight, 0.9, stepMs),
    eyeAsymmetry: timedPercentile(eyeAsymmetry, 0.5, stepMs),
    // The most-closed state the eye actually reaches in this bin. A low
    // percentile will not do: at normal blink rates only a few percent of a
    // bin's frames are mid-blink, so even P05 sits above the closed state and
    // would report an eye that never closes. Robustness comes from taking the
    // median of these per-bin minima across bins, not from smoothing here.
    eyeClosedLeft: Math.min(...eyeLeft.map((sample) => sample.value)),
    eyeClosedRight: Math.min(...eyeRight.map((sample) => sample.value)),
    browLeft: browLeft.length > 0 ? timedPercentile(browLeft, 0.5, stepMs) : null,
    browRight: browRight.length > 0 ? timedPercentile(browRight, 0.5, stepMs) : null,
    mouthWidth: timedPercentile(widths, 0.5, stepMs),
    mouthApertureMedian: timedPercentile(apertures, 0.5, stepMs),
    mouthApertureP90: timedPercentile(apertures, 0.9, stepMs),
    mouthCornerAsymmetry: timedPercentile(cornerAsymmetry, 0.5, stepMs),
    movementP90:
      movement.length > 0
        ? timedPercentile(movement, 0.9, stepMs)
        : null
  };
}

function qualifyBin(
  index: number,
  candidateFrames: readonly AmbientFacialFrame[],
  options: AmbientFaceExtractionOptions,
  onReject?: (reason: string) => void
): FacialBin | null {
  const reject = (reason: string): null => {
    onReject?.(reason);
    return null;
  };
  /*
   * Unusable frames are dropped; the bin is not.
   *
   * This used to require EVERY frame to pass, which in real capture discarded
   * 82% of a session's bins to exclude 22% of its frames -- one glance away
   * costing the surrounding five seconds. Measured across three real sessions,
   * it was the single reason nothing was ever measurable.
   *
   * No new threshold replaces it, because the pack already carries one:
   * `minimumDataPerBinMs` of 4000 in a 5000 ms bin IS an 80% requirement. The
   * all-or-nothing rule was redundant with it and far stricter. Dropping bad
   * frames and letting the published requirement do its job makes the code
   * enforce what the pack always said.
   *
   * Every retained frame is individually pose-valid, so the geometry stays
   * sound -- the bin simply rests on less of it, which is exactly what
   * `minimumDataPerBinMs` and `minimumSamplesPerBin` exist to bound.
   */
  const frames = candidateFrames.filter((frame) =>
    ambientFrameUsable(frame, options)
  );
  if (frames.length < AMBIENT_FACE_MIN_SAMPLES_PER_BIN) {
    return reject("too-few-usable-frames");
  }
  const processorRefs = new Set(frames.map((frame) => frame.processorRef));
  const trackSegmentIds = new Set(frames.map(faceTrackSegmentId));
  const epochs = new Set(frames.map((frame) => frame.captureEpoch));
  if (
    processorRefs.size !== 1 ||
    trackSegmentIds.size !== 1 ||
    epochs.size !== 1
  ) {
    return reject("mixed-provenance");
  }
  const gaps = frames
    .slice(1)
    .map((frame, frameIndex) => frame.tMs - frames[frameIndex].tMs);
  if (
    gaps.some(
      (gap) => gap <= 0 || gap > AMBIENT_FACE_MAX_FRAME_GAP_MS
    )
  ) {
    return reject("frame-gap");
  }
  const actualSpanMs = frames.at(-1)!.tMs - frames[0].tMs;
  const stepMs = nominalStepMs(frames);
  /*
   * How much of this bin was actually ANALYZED, not how much time elapsed
   * across it.
   *
   * Summing raw inter-frame gaps counted a hole as data: two frames 200 ms
   * apart contributed 200 ms while carrying two samples. That was harmless
   * while the frame gate guaranteed no holes and wrong the moment it stopped.
   * Each retained frame now represents one nominal step of observation, which
   * is what `minimumDataPerBinMs` is checked against.
   */
  const durationMs = Math.min(
    AMBIENT_FACE_BIN_MS,
    Math.round(frames.length * stepMs * 1_000) / 1_000
  );
  if (
    actualSpanMs < AMBIENT_FACE_MIN_BIN_SPAN_MS ||
    durationMs < AMBIENT_FACE_MIN_BIN_DATA_MS
  ) {
    return reject("short-bin");
  }
  const sizes = frames.map((frame) =>
    Math.sqrt(
      frame.boundingBox!.widthPixels * frame.boundingBox!.heightPixels
    )
  );
  const sizeP10 = percentile(sizes, 0.1);
  const sizeP90 = percentile(sizes, 0.9);
  if (
    !finite(sizeP10) ||
    sizeP10 <= 0 ||
    sizeP90 / sizeP10 > AMBIENT_FACE_MAX_WITHIN_BIN_SIZE_RATIO
  ) {
    return reject("scale-drift");
  }
  const startMs = options.sessionStartedAtMs + index * AMBIENT_FACE_BIN_MS;
  const processorRef = frames[0].processorRef;
  const trackId = faceTrackSegmentId(frames[0])!;
  const captureEpoch = frames[0].captureEpoch;
  return {
    index,
    startMs,
    endMs: startMs + AMBIENT_FACE_BIN_MS,
    frames,
    durationMs,
    actualSpanMs,
    cadenceHz: frames.length / (durationMs / 1_000),
    processorRef,
    trackSegmentId: trackId,
    captureEpoch,
    sourceWindowRef: [
      "face",
      captureEpoch,
      trackId,
      startMs,
      startMs + AMBIENT_FACE_BIN_MS
    ].join(":"),
    values: binValues(frames, stepMs)
  };
}

function screenBins(
  frames: readonly AmbientFacialFrame[],
  options: AmbientFaceExtractionOptions
): BinScreening {
  const buckets = new Map<number, AmbientFacialFrame[]>();
  let attributionFailureCount = 0;
  let qualityFailureCount = 0;
  for (const frame of frames) {
    if (frame.faceCount !== 1 || faceTrackSegmentId(frame) === null) {
      attributionFailureCount += 1;
    }
    if (!ambientFrameUsable(frame, options)) qualityFailureCount += 1;
    const index = Math.floor(
      (frame.tMs - options.sessionStartedAtMs) / AMBIENT_FACE_BIN_MS
    );
    const bucket = buckets.get(index) ?? [];
    bucket.push(frame);
    buckets.set(index, bucket);
  }
  const gateFailures: Record<string, number> = {};
  let usableFrameCount = 0;
  for (const frame of frames) {
    const failures = frameGateFailures(frame, options);
    if (failures.length === 0) usableFrameCount += 1;
    for (const reason of failures) {
      gateFailures[reason] = (gateFailures[reason] ?? 0) + 1;
    }
  }
  const poses = frames
    .map((frame) => frame.pose)
    .filter((pose): pose is NonNullable<typeof pose> => pose !== null);
  const absAt = (pick: (p: NonNullable<AmbientFacialFrame["pose"]>) => number, q: number) =>
    percentile(poses.map((pose) => Math.abs(pick(pose))), q);

  const binRejections: Record<string, number> = {};
  const entries = [...buckets.entries()].sort(([left], [right]) => left - right);

  const binStats = entries.map(([index, bucket]) => {
    const usable = bucket.filter((frame) => ambientFrameUsable(frame, options));
    let maxUsableGapMs = 0;
    for (let position = 1; position < usable.length; position += 1) {
      maxUsableGapMs = Math.max(
        maxUsableGapMs,
        usable[position].tMs - usable[position - 1].tMs
      );
    }
    return {
      index,
      frameCount: bucket.length,
      usableFrameCount: usable.length,
      usableFraction:
        bucket.length > 0 ? usable.length / bucket.length : 0,
      maxUsableGapMs,
      usableSpanMs:
        usable.length > 1 ? usable.at(-1)!.tMs - usable[0].tMs : 0
    };
  });

  const acceptanceCurve = [1, 0.98, 0.95, 0.9, 0.85, 0.8].map((threshold) => {
    let binsAccepted = 0;
    let lostToGap = 0;
    let lostToSampleCount = 0;
    let lostToSpan = 0;
    for (const bin of binStats) {
      if (bin.usableFraction < threshold) continue;
      if (bin.usableFrameCount < AMBIENT_FACE_MIN_SAMPLES_PER_BIN) {
        lostToSampleCount += 1;
        continue;
      }
      if (bin.maxUsableGapMs > AMBIENT_FACE_MAX_FRAME_GAP_MS) {
        lostToGap += 1;
        continue;
      }
      // Omitting this made an earlier projection optimistic: losing frames from
      // a bin EDGE shortens the usable span one-for-one, and the span rule is
      // far tighter than the data rule -- 200 ms of slack against 1000 ms.
      if (bin.usableSpanMs < AMBIENT_FACE_MIN_BIN_SPAN_MS) {
        lostToSpan += 1;
        continue;
      }
      binsAccepted += 1;
    }
    return { threshold, binsAccepted, lostToGap, lostToSampleCount, lostToSpan };
  });
  const bins = entries.flatMap(([index, bucket]) => {
    const bin = qualifyBin(index, bucket, options, (reason) => {
      binRejections[reason] = (binRejections[reason] ?? 0) + 1;
    });
    return bin ? [bin] : [];
  });
  return {
    bins,
    attributionFailureCount,
    qualityFailureCount,
    diagnostics: {
      frameCount: frames.length,
      usableFrameCount,
      frameGateFailures: gateFailures,
      pose: poses.length > 0
        ? {
            yawP50: absAt((pose) => pose.yawDegrees, 0.5),
            yawP95: absAt((pose) => pose.yawDegrees, 0.95),
            pitchP50: absAt((pose) => pose.pitchDegrees, 0.5),
            pitchP95: absAt((pose) => pose.pitchDegrees, 0.95),
            rollP50: absAt((pose) => pose.rollDegrees, 0.5),
            rollP95: absAt((pose) => pose.rollDegrees, 0.95)
          }
        : null,
      binsConsidered: entries.length,
      binsAccepted: bins.length,
      binRejections,
      bins: binStats,
      acceptanceCurve
    }
  };
}

function evidenceFor(
  sourceFrames: readonly AmbientFacialFrame[],
  bins: readonly FacialBin[],
  overrides: Partial<AmbientMetricEvidence> = {}
): AmbientMetricEvidence {
  return {
    observedStartMs: sourceFrames[0]?.tMs ?? null,
    observedEndMs: sourceFrames.at(-1)?.tMs ?? null,
    eligibleDurationMs: bins.reduce(
      (total, bin) => total + bin.durationMs,
      0
    ),
    sampleCount: bins.reduce((total, bin) => total + bin.frames.length, 0),
    segmentCount: new Set(
      bins.map(
        (bin) => `${bin.captureEpoch}\u0000${bin.trackSegmentId}`
      )
    ).size,
    qualifyingBinCount: bins.length,
    processorRefs: sortedUnique(
      bins.length > 0
        ? bins.map((bin) => bin.processorRef)
        : sourceFrames.map((frame) => frame.processorRef)
    ),
    trackSegmentIds: sortedUnique(
      bins.length > 0
        ? bins.map((bin) => bin.trackSegmentId)
        : sourceFrames.flatMap((frame) => {
            const track = faceTrackSegmentId(frame);
            return track ? [track] : [];
          })
    ),
    sourceWindowRefs: bins.map((bin) => bin.sourceWindowRef),
    // Worst accepted bin per gate, so the report can re-verify each threshold
    // on the statistic the screener enforced rather than skipping it. Minima
    // for `minimum*` gates, maxima for `maximum*` ones.
    ...(bins.length > 0
      ? {
          cadenceHz: Math.min(...bins.map((bin) => bin.cadenceHz)),
          dataPerBinMs: Math.min(...bins.map((bin) => bin.durationMs)),
          samplesPerBin: Math.min(...bins.map((bin) => bin.frames.length)),
          binSpanMs: Math.min(...bins.map((bin) => bin.actualSpanMs)),
          p95FrameGapMs: p95Gaps(bins),
          maximumFrameGapMs: maximumGap(bins)
        }
      : {}),
    ...overrides
  };
}

/**
 * Largest inter-frame gap across accepted bins. Zero when no bin holds two
 * frames, which is the correct floor: a gap that was never observed cannot
 * exceed a ceiling.
 */
function maximumGap(bins: readonly FacialBin[]): number {
  let largest = 0;
  for (const bin of bins) {
    for (let index = 1; index < bin.frames.length; index += 1) {
      largest = Math.max(
        largest,
        bin.frames[index].tMs - bin.frames[index - 1].tMs
      );
    }
  }
  return largest;
}

function dispersion(values: readonly number[]): number | null {
  return values.length >= 2
    ? medianAbsoluteDeviation([...values])
    : null;
}

function technicalQualityScore(bins: readonly FacialBin[]): number {
  if (bins.length === 0) return 0;
  const cadence = clamp01(
    median(bins.map((bin) => bin.cadenceHz)) / 30
  );
  const coverage = clamp01(
    median(bins.map((bin) => bin.durationMs / AMBIENT_FACE_BIN_MS))
  );
  const sizeStability = median(
    bins.map((bin) => {
      const sizes = bin.frames.map((frame) =>
        Math.sqrt(
          frame.boundingBox!.widthPixels * frame.boundingBox!.heightPixels
        )
      );
      const ratio = percentile(sizes, 0.9) / percentile(sizes, 0.1);
      return clamp01(
        1 -
          (ratio - 1) /
            (AMBIENT_FACE_MAX_WITHIN_BIN_SIZE_RATIO - 1)
      );
    })
  );
  const pose = median(
    bins.flatMap((bin) =>
      bin.frames.map((frame) => {
        const value = frame.pose!;
        return clamp01(
          1 -
            Math.max(
              Math.abs(value.yawDegrees) / AMBIENT_FACE_MAX_YAW_DEGREES,
              Math.abs(value.pitchDegrees) /
                AMBIENT_FACE_MAX_PITCH_DEGREES,
              Math.abs(value.rollDegrees) / AMBIENT_FACE_MAX_ROLL_DEGREES
            )
        );
      })
    )
  );
  return clamp01(
    0.3 * cadence + 0.3 * coverage + 0.2 * sizeStability + 0.2 * pose
  );
}

function commonFailure(
  screening: BinScreening,
  options: AmbientFaceExtractionOptions
): { reasonCode: AmbientWithheldReasonCode; detail: string } | null {
  const calibration = options.calibration;
  if (
    calibration === null ||
    calibration.durationMs < 1_500 ||
    !finite(calibration.baselineBoxWidthPixels) ||
    calibration.baselineBoxWidthPixels <= 0 ||
    !finite(calibration.baselineBoxHeightPixels) ||
    calibration.baselineBoxHeightPixels <= 0
  ) {
    return {
      reasonCode: "quality-threshold-failed",
      detail:
        "A 1.5-second technical face-size calibration is required."
    };
  }
  if (screening.bins.length === 0) {
    if (screening.attributionFailureCount > 0) {
      return {
        reasonCode: "multiple-faces",
        detail:
          "No five-second bin contained exactly one explicitly tracked face throughout."
      };
    }
    return {
      reasonCode: "no-usable-signal",
      detail:
        "No five-second bin met visual quality, frontal pose, calibrated size, continuity, and sample-count requirements."
    };
  }
  if (
    new Set(screening.bins.map((bin) => bin.processorRef)).size > 1 ||
    new Set(
      screening.bins.map(
        (bin) => `${bin.captureEpoch}\u0000${bin.trackSegmentId}`
      )
    ).size > 1
  ) {
    return {
      reasonCode: "quality-threshold-failed",
      detail:
        "Qualifying face bins crossed a processor, capture epoch, or track segment."
    };
  }
  if (screening.bins.length < AMBIENT_FACE_MIN_BINS) {
    return {
      reasonCode: "insufficient-bins",
      detail: `At least ${AMBIENT_FACE_MIN_BINS} qualifying five-second face bins are required.`
    };
  }
  const span =
    screening.bins.at(-1)!.endMs - screening.bins[0].startMs;
  if (span < AMBIENT_FACE_MIN_SPAN_MS) {
    return {
      reasonCode: "insufficient-duration",
      detail: "Qualifying face bins must span at least 30 seconds."
    };
  }
  return null;
}

function p95Gaps(bins: readonly FacialBin[]): number {
  const gaps: number[] = [];
  for (const bin of bins) {
    gaps.push(
      ...bin.frames
        .slice(1)
        .map((frame, index) => frame.tMs - bin.frames[index].tMs)
    );
  }
  return gaps.length > 0 ? percentile(gaps, 0.95) : Number.POSITIVE_INFINITY;
}

/**
 * The detector needs only an ordered group of frames and an index to attribute
 * results to. A qualifying bin satisfies this, and so does the raw frame stream
 * wrapped as a single group -- which is what lets Tier-2 extraction run without
 * inheriting the pose gating a bin implies.
 */
interface FrameGroup {
  index: number;
  frames: AmbientFacialFrame[];
}

/** One eye's blink, plus the bin it peaked in so per-bin rates survive. */
interface BinnedBlink extends DetectedBlink {
  binIndex: number;
}

/**
 * Blink detection for a single eye.
 *
 * Previously both eyes had to be below threshold on the same frame to register
 * anything, which cannot see a unilateral closure at all -- and unilateral
 * incomplete closure is the finding a facial palsy actually produces. Running
 * the machine per eye removes that blind spot as a consequence of the shape
 * rather than as a special case.
 *
 * The phases are kept because they dissociate: a reduced rate is hypomimia, a
 * shallow depth is orbicularis weakness, a slow reopening is fatigable. One
 * waveform, three findings, none of them recoverable from a count.
 */
function detectBlinksForEye(
  bins: readonly FrameGroup[],
  side: SubjectSide,
  apertureOf: (frame: AmbientFacialFrame) => number
): BinnedBlink[] {
  const openReference = percentile(
    bins.flatMap((bin) => bin.frames.map(apertureOf)),
    0.9
  );
  if (!(openReference > 0)) return [];
  const closureThreshold = openReference * AMBIENT_BLINK_CLOSURE_FRACTION;
  const recoveryThreshold = openReference * AMBIENT_BLINK_RECOVERY_FRACTION;

  const events: BinnedBlink[] = [];
  let closure:
    | {
        binIndex: number;
        startMs: number;
        /** Last frame above the recovery threshold: the true onset of movement. */
        onsetMs: number;
        peakMs: number;
        minimum: number;
        frameCount: number;
        closedDwellMs: number;
      }
    | null = null;
  let suppressUntilRecovery = false;
  let lastAcceptedAt = Number.NEGATIVE_INFINITY;
  let lastOpenMs: number | null = null;
  let previousFrame: AmbientFacialFrame | null = null;
  let previousBinIndex: number | null = null;

  const reset = (): void => {
    closure = null;
    suppressUntilRecovery = false;
    previousFrame = null;
    lastOpenMs = null;
  };

  for (let binIndex = 0; binIndex < bins.length; binIndex += 1) {
    const bin = bins[binIndex];
    if (previousBinIndex !== null && bin.index !== previousBinIndex + 1) reset();
    for (const frame of bin.frames) {
      if (
        previousFrame &&
        frame.tMs - previousFrame.tMs > AMBIENT_BLINK_MAX_P95_GAP_MS
      ) {
        reset();
      }
      const aperture = apertureOf(frame);
      const closed = aperture <= closureThreshold;
      const recovered = aperture >= recoveryThreshold;

      if (suppressUntilRecovery) {
        if (recovered) suppressUntilRecovery = false;
      } else if (closure === null) {
        if (closed && frame.tMs - lastAcceptedAt >= AMBIENT_BLINK_REFRACTORY_MS) {
          closure = {
            binIndex,
            startMs: frame.tMs,
            // Falling back to the closure frame keeps onset defined when the
            // window opens mid-blink; the phases are then conservative rather
            // than absent.
            onsetMs: lastOpenMs ?? frame.tMs,
            peakMs: frame.tMs,
            minimum: aperture,
            frameCount: 1,
            closedDwellMs: 0
          };
        }
      } else {
        const elapsed = frame.tMs - closure.startMs;
        closure.frameCount += 1;
        if (aperture < closure.minimum) {
          closure.minimum = aperture;
          closure.peakMs = frame.tMs;
        }
        if (closed && previousFrame) {
          closure.closedDwellMs += frame.tMs - previousFrame.tMs;
        }
        if (elapsed > AMBIENT_BLINK_MAX_RECOVERY_MS) {
          closure = null;
          suppressUntilRecovery = true;
        } else if (recovered) {
          if (elapsed >= AMBIENT_BLINK_MIN_CLOSURE_MS) {
            const travel = openReference - closure.minimum;
            const closingMs = closure.peakMs - closure.onsetMs;
            const openingMs = frame.tMs - closure.peakMs;
            events.push({
              side,
              binIndex: closure.binIndex,
              onsetMs: closure.onsetMs,
              peakMs: closure.peakMs,
              offsetMs: frame.tMs,
              openReference,
              lidApertureMinimum: closure.minimum,
              // Clamped: an aperture above the open reference on a noisy frame
              // would otherwise read as negative depth.
              depth: Math.min(1, Math.max(0, travel / openReference)),
              closingVelocity:
                closingMs > 0 ? (travel / closingMs) * 1_000 : 0,
              openingVelocity:
                openingMs > 0 ? (travel / openingMs) * 1_000 : 0,
              closedDwellMs: closure.closedDwellMs,
              frameCount: closure.frameCount
            });
            lastAcceptedAt = frame.tMs;
          }
          closure = null;
        }
      }
      if (recovered) lastOpenMs = frame.tMs;
      previousFrame = frame;
    }
    previousBinIndex = bin.index;
  }
  return events;
}

/** Every blink from both eyes, ordered by the moment of maximum closure. */
function detectBlinkEvents(bins: readonly FrameGroup[]): BinnedBlink[] {
  return [
    ...detectBlinksForEye(bins, "left", (frame) => frame.eyeAperture!.left),
    ...detectBlinksForEye(bins, "right", (frame) => frame.eyeAperture!.right)
  ].sort((a, b) => a.peakMs - b.peakMs || (a.side === "left" ? -1 : 1));
}

/**
 * Bilateral blink counts, from per-eye events whose closures overlap in time.
 *
 * The published rate metric is explicitly bilateral, so it keeps counting
 * conjugate blinks and is unchanged by the per-eye rewrite. A unilateral
 * closure now exists as an event without inflating that count.
 */
function detectBlinks(
  bins: readonly FrameGroup[]
): { count: number; perBinCounts: number[]; events: BinnedBlink[] } {
  const events = detectBlinkEvents(bins);
  const perBinCounts = bins.map(() => 0);
  const rights = events.filter((event) => event.side === "right");
  const paired = new Set<BinnedBlink>();
  let count = 0;
  for (const left of events.filter((event) => event.side === "left")) {
    const match = rights.find(
      (right) =>
        !paired.has(right) &&
        right.onsetMs <= left.offsetMs &&
        left.onsetMs <= right.offsetMs
    );
    if (match) {
      paired.add(match);
      count += 1;
      perBinCounts[left.binIndex] += 1;
    }
  }
  return { count, perBinCounts, events };
}

export function extractAmbientFaceMetrics(
  frames: readonly AmbientFacialFrame[],
  options: AmbientFaceExtractionOptions
): AmbientExtractionResult {
  const captureEndMs =
    options.sessionStartedAtMs + AMBIENT_MAX_CAPTURE_DURATION_MS;
  const inRange = frames
    .filter(
      (frame) =>
        finite(frame.tMs) &&
        frame.tMs >= options.sessionStartedAtMs &&
        frame.tMs < captureEndMs
    )
    .sort((left, right) => left.tMs - right.tMs || left.sequence - right.sequence);
  const ignoredFrameCount = frames.length - inRange.length;
  // Tier-2 records, collected as the detectors run and returned alongside the
  // outcomes. An outcome carries one value by construction, so a series cannot
  // travel inside it.
  const blinkEvents: BlinkEventRecord[] = [];
  // Ordered, attribution- and geometry-complete frames without the pose gate.
  const tier2Frames = [...inRange]
    .filter(tier2FrameUsable)
    .sort((left, right) => left.tMs - right.tMs);
  const screening = screenBins(inRange, options);
  const evidence = evidenceFor(inRange, screening.bins);
  const failure = commonFailure(screening, options);
  const qualityScore = technicalQualityScore(screening.bins);
  const outcomes: AmbientMetricOutcome[] = [];

  const selectors: ReadonlyArray<{
    code: Exclude<AmbientFaceMetricCode, "ambient.face.blink_rate.bilateral">;
    select: (values: FacialBinValues) => number | null;
  }> = [
    {
      code: "ambient.face.eye_aperture.left",
      select: (values) => values.eyeLeft
    },
    {
      code: "ambient.face.eye_aperture.right",
      select: (values) => values.eyeRight
    },
    {
      code: "ambient.face.eye_aperture.asymmetry",
      select: (values) => values.eyeAsymmetry
    },
    {
      code: "ambient.face.mouth_width",
      select: (values) => values.mouthWidth
    },
    {
      code: "ambient.face.mouth_aperture.median",
      select: (values) => values.mouthApertureMedian
    },
    {
      code: "ambient.face.mouth_aperture.p90",
      select: (values) => values.mouthApertureP90
    },
    {
      code: "ambient.face.mouth_corner_position.asymmetry",
      select: (values) => values.mouthCornerAsymmetry
    },
    {
      code: "ambient.face.landmark_speed.p90",
      select: (values) => values.movementP90
    }
  ];

  for (const { code, select } of selectors) {
    const values = screening.bins.flatMap((bin) => {
      const value = select(bin.values);
      return value !== null && finite(value) ? [value] : [];
    });
    if (failure || values.length < AMBIENT_FACE_MIN_BINS) {
      outcomes.push(
        withheldOutcome(
          code,
          options,
          evidence,
          failure?.reasonCode ?? "insufficient-bins",
          failure?.detail ??
            "The metric did not have a finite value in three qualifying face bins."
        )
      );
    } else {
      outcomes.push(
        measuredOutcome(
          code,
          options,
          evidence,
          median(values),
          qualityScore,
          dispersion(values)
        )
      );
    }
  }

  const blinkCode: AmbientFaceMetricCode =
    "ambient.face.blink_rate.bilateral";
  const frontalExposureMs = screening.bins.reduce(
    (total, bin) => total + bin.durationMs,
    0
  );
  const blinkEvidenceBase = evidenceFor(inRange, screening.bins, {
    frontalExposureMs
  });
  const cadenceHz =
    frontalExposureMs > 0
      ? blinkEvidenceBase.sampleCount / (frontalExposureMs / 1_000)
      : 0;
  let blinkFailure = failure;
  if (!blinkFailure && frontalExposureMs < AMBIENT_BLINK_MIN_EXPOSURE_MS) {
    blinkFailure = {
      reasonCode: "insufficient-exposure",
      detail: "Bilateral blink rate requires 60 seconds of eligible frontal exposure."
    };
  }
  if (!blinkFailure && cadenceHz < AMBIENT_BLINK_MIN_CADENCE_HZ) {
    blinkFailure = {
      reasonCode: "insufficient-frame-cadence",
      detail: "Bilateral blink rate requires at least 24 analyzed frames per second."
    };
  }
  if (
    !blinkFailure &&
    p95Gaps(screening.bins) > AMBIENT_BLINK_MAX_P95_GAP_MS
  ) {
    blinkFailure = {
      reasonCode: "quality-threshold-failed",
      detail: "Bilateral blink rate requires a P95 frame gap no greater than 75 ms."
    };
  }
  /*
   * Detection runs whenever there are bins to run it on, independent of whether
   * the blink METRIC publishes.
   *
   * This used to sit inside the else branch below, so a session that failed the
   * 60-second exposure gate discarded every blink it had actually observed. A
   * 54-second session with a face in frame throughout reported zero blinks --
   * not because none occurred, but because a publication threshold suppressed
   * the extraction feeding it. Tier 2 exists precisely so an abstaining metric
   * still leaves its observations behind.
   */
  const blinks =
    screening.bins.length > 0
      ? detectBlinks(screening.bins)
      : { count: 0, perBinCounts: [] as number[], events: [] as BinnedBlink[] };

  /*
   * Tier-2 events come from the LOOSE stream, not the qualifying bins.
   *
   * The published blink rate above stays bin-derived and unchanged: it is
   * explicitly a rate over pose-qualified windows. These events answer a
   * different question -- what did the session actually contain -- and a
   * session whose bins all failed the pose gate still contained blinks.
   */
  if (tier2Frames.length > 0) {
    for (const event of detectBlinkEvents([
      { index: 0, frames: tier2Frames }
    ])) {
      const { binIndex: _binIndex, ...record } = event;
      blinkEvents.push({
        ...record,
        poseWithinMeasurementLimits: poseWithinLimits(
          tier2Frames,
          record.onsetMs,
          record.offsetMs,
          options
        )
      });
    }
  }

  if (blinkFailure) {
    outcomes.push(
      withheldOutcome(
        blinkCode,
        options,
        blinkEvidenceBase,
        blinkFailure.reasonCode,
        blinkFailure.detail
      )
    );
  } else {
    const blinkEvidence = evidenceFor(inRange, screening.bins, {
      frontalExposureMs,
      blinkCount: blinks.count
    });
    const perBinRates = blinks.perBinCounts.map(
      (count) => count / (AMBIENT_FACE_BIN_MS / 60_000)
    );
    outcomes.push(
      measuredOutcome(
        blinkCode,
        options,
        blinkEvidence,
        blinks.count / (frontalExposureMs / 60_000),
        qualityScore,
        dispersion(perBinRates)
      )
    );
  }

  // Resting geometry and spontaneous expression dynamics. These read the
  // frames inside qualifying bins, so they inherit the same pose, scale,
  // cadence, and attribution gates as every other face metric.
  const expressionFrames = screening.bins.flatMap((bin) => bin.frames);
  const expressionSummary =
    expressionFrames.length > 0
      ? summarizeExpressions(
          expressionFrames,
          screening.bins.reduce((total, bin) => total + bin.durationMs, 0)
        )
      : null;

  /*
   * Expressions are detected on the loose stream for the same reason blinks are:
   * a mouth movement is recoverable at a head angle that would invalidate a
   * left-versus-right comparison of it. The per-side excursion METRICS below
   * still come from the qualifying bins; these events are the record of what
   * the session contained.
   */
  const looseExpressions =
    tier2Frames.length > 0
      ? summarizeExpressions(
          tier2Frames,
          tier2Frames.length > 1
            ? tier2Frames.at(-1)!.tMs - tier2Frames[0].tMs
            : 0
        )
      : null;
  const expressionEvents: ExpressionEventRecord[] = (
    looseExpressions?.events ?? []
  ).map((event) => ({
    ...event,
    poseWithinMeasurementLimits: poseWithinLimits(
      tier2Frames,
      event.startMs,
      event.endMs,
      options
    )
  }));

  const expressionEvidence = evidenceFor(inRange, screening.bins, {
    expressionEventCount: expressionSummary?.eventCount,
    coupledExpressionEventCount: expressionSummary?.synkinesisEventCount
  });

  const emitExpression = (
    code: AmbientFaceMetricCode,
    value: number | null | undefined,
    dispersionValues: number[] | null,
    shortfall: { reasonCode: AmbientWithheldReasonCode; detail: string } | null
  ): void => {
    const blocked = failure ?? shortfall;
    if (blocked || value === null || value === undefined || !finite(value)) {
      outcomes.push(
        withheldOutcome(
          code,
          options,
          expressionEvidence,
          blocked?.reasonCode ?? "no-usable-signal",
          blocked?.detail ??
            "No resting face geometry was available in the eligible bins."
        )
      );
      return;
    }
    outcomes.push(
      measuredOutcome(
        code,
        options,
        expressionEvidence,
        value,
        qualityScore,
        dispersionValues && dispersionValues.length > 0
          ? dispersion(dispersionValues)
          : null
      )
    );
  };

  const eventCount = expressionSummary?.eventCount ?? 0;
  const tooFewEvents =
    eventCount < AMBIENT_EXPRESSION_MIN_EVENTS
      ? {
          reasonCode: "insufficient-events" as AmbientWithheldReasonCode,
          detail:
            "Spontaneous expression statistics require at least three detected expression events."
        }
      : null;
  const tooFewCoupled =
    (expressionSummary?.synkinesisEventCount ?? 0) <
    AMBIENT_EXPRESSION_MIN_EVENTS
      ? {
          reasonCode: "insufficient-events" as AmbientWithheldReasonCode,
          detail:
            "Oculo-oral coupling requires at least three events where both sides cleared the movement floor."
        }
      : null;

  emitExpression(
    "ambient.face.rest_mouth_corner_asymmetry.signed",
    expressionSummary?.restMouthCornerAsymmetry,
    null,
    null
  );
  emitExpression(
    "ambient.face.rest_eye_aperture_asymmetry.signed",
    expressionSummary?.restEyeApertureAsymmetry,
    null,
    null
  );
  // A rate of zero is a measurement, not an absence: the session was observed
  // and contained no expressions. Only the per-event statistics below need
  // events to exist before they mean anything.
  emitExpression(
    "ambient.face.spontaneous_event_rate",
    expressionSummary?.eventRatePerMinute,
    null,
    null
  );
  emitExpression(
    "ambient.face.spontaneous_excursion.p90",
    expressionSummary?.excursionP90,
    null,
    tooFewEvents
  );
  emitExpression(
    "ambient.face.spontaneous_excursion_asymmetry.median",
    expressionSummary?.excursionAsymmetryMedian,
    (expressionSummary?.events ?? [])
      .map(excursionAsymmetry)
      .filter((value): value is number => value !== null),
    tooFewEvents
  );
  emitExpression(
    "ambient.face.oculo_oral_synkinesis_index",
    expressionSummary?.synkinesisIndexMedian,
    (expressionSummary?.events ?? [])
      .map(synkinesisIndex)
      .filter((value): value is number => value !== null),
    tooFewEvents ?? tooFewCoupled
  );

  // Brow geometry and per-eye closure. Both read the same qualifying bins as
  // every other face metric, so they inherit the identical pose, scale,
  // cadence, and attribution gates.
  const binStat = (
    select: (values: FacialBinValues) => number | null,
    probability = 0.5
  ): number | null => {
    const values = screening.bins
      .map((bin) => select(bin.values))
      .filter((value): value is number => value !== null && finite(value));
    if (values.length === 0) return null;
    return probability === 0.5
      ? median(values)
      : percentile(values, probability);
  };
  const binMedian = (select: (values: FacialBinValues) => number | null) =>
    binStat(select);

  const browLeft = binMedian((values) => values.browLeft);
  const browRight = binMedian((values) => values.browRight);
  // Completeness of 1 means the lid reaches full closure; 0 means it never
  // moves off its open reference. Referenced to the eye's OWN open state, so
  // it is a within-eye ratio and does not depend on face scale.
  const closure = (
    open: number | null,
    closed: number | null
  ): number | null => {
    if (open === null || closed === null || !finite(open) || !finite(closed)) {
      return null;
    }
    if (open <= 0) return null;
    return Math.max(0, Math.min(1, 1 - closed / open));
  };
  // Closure is an intermittent event, so the closed reference is a LOW
  // percentile of the per-bin minima rather than their median. A bin that
  // happens to contain no blink reports its open value as the minimum, and a
  // median over a mix of blink and no-blink bins lands between the two —
  // reporting an eye that half-closes when it in fact closes fully. P25 is
  // low enough to sit in a blink-bearing bin at any normal blink rate while
  // still discarding a single mistracked bin.
  const closureLeft = closure(
    binMedian((values) => values.eyeLeft),
    binStat((values) => values.eyeClosedLeft, 0.25)
  );
  const closureRight = closure(
    binMedian((values) => values.eyeRight),
    binStat((values) => values.eyeClosedRight, 0.25)
  );

  const zoneEvidence = evidenceFor(inRange, screening.bins);
  const emitZone = (
    code: AmbientFaceMetricCode,
    value: number | null,
    dispersionValues: number[]
  ): void => {
    if (failure || value === null || !finite(value)) {
      outcomes.push(
        withheldOutcome(
          code,
          options,
          zoneEvidence,
          failure?.reasonCode ?? "no-usable-signal",
          failure?.detail ??
            "The eligible bins did not carry the geometry this metric requires."
        )
      );
      return;
    }
    outcomes.push(
      measuredOutcome(
        code,
        options,
        zoneEvidence,
        value,
        qualityScore,
        dispersionValues.length > 0 ? dispersion(dispersionValues) : null
      )
    );
  };

  const perBin = (select: (values: FacialBinValues) => number | null) =>
    screening.bins
      .map((bin) => select(bin.values))
      .filter((value): value is number => value !== null && finite(value));

  emitZone(
    "ambient.face.brow_height.left",
    browLeft,
    perBin((values) => values.browLeft)
  );
  emitZone(
    "ambient.face.brow_height.right",
    browRight,
    perBin((values) => values.browRight)
  );
  emitZone(
    "ambient.face.brow_height_asymmetry.signed",
    browLeft !== null && browRight !== null ? browLeft - browRight : null,
    []
  );
  emitZone("ambient.face.lid_closure_completeness.left", closureLeft, []);
  emitZone("ambient.face.lid_closure_completeness.right", closureRight, []);

  return {
    outcomes: FACE_CODES.map((code) => {
      const outcome = outcomes.find((candidate) => candidate.code === code);
      if (!outcome) throw new Error(`Missing ambient face outcome ${code}.`);
      return outcome;
    }),
    ignoredFrameCount,
    events: {
      blinks: blinkEvents,
      // Already fully computed for the summary and previously reduced to two
      // integers before anything could see them.
      expressions: expressionEvents
    },
    diagnostics: screening.diagnostics
  };
}
