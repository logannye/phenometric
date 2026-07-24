import type { ExpressionEventRecord } from "./kinematic-events.js";
/**
 * Spontaneous facial expression events.
 *
 * Design: docs/superpowers/specs/2026-07-24-facial-palsy-protocol-pack-design.md
 *
 * Spontaneous and volitional facial movement travel different neural pathways,
 * and spontaneity cannot be elicited — asking someone to smile makes the
 * movement volitional by definition. So the events here are detected in
 * ordinary conversation and never prompted.
 *
 * Everything in this module is a pure function over frames that have already
 * passed the caller's pose and quality gates. No landmark ever reaches this
 * code: `mouthCorners`, `eyeAperture`, and `pose` are derived scalars that
 * already cross the worker boundary, so adding these measures moves no new
 * data across any boundary.
 *
 * Coordinate convention (from the visual pipeline): origin at the midpoint
 * between eye centres, x along the inter-eye axis with +x toward the subject's
 * LEFT, y perpendicular and increasing DOWNWARD, all scaled by the inter-eye
 * distance. A mouth corner therefore sits at positive y, and a rising corner
 * DECREASES y. "Elevation" below always means `baseline.y - current.y`.
 *
 * NOTE ON THRESHOLDS: the constants below are engineering defaults chosen from
 * the geometry, not from data. No calibration set exists. They must be
 * revisited against real recordings before any measurement derived from them
 * is interpreted.
 */
import { median, percentile } from "./stats.js";
import type { AmbientFacialFrame } from "./ambient-types.js";

/** Corner rise (inter-eye units) that opens an event. */
export const EXPRESSION_ONSET_ELEVATION = 0.04;
/** Lower bar to stay in an event, so a wavering peak is not chopped in two. */
export const EXPRESSION_OFFSET_ELEVATION = 0.02;
/** Shorter excursions are twitches, chewing, or speech articulation. */
export const EXPRESSION_MIN_DURATION_MS = 300;
/** Longer ones are a sustained posture, not a discrete expression. */
export const EXPRESSION_MAX_DURATION_MS = 10_000;
/** Both sides must move at least this much before coupling can be measured. */
export const SYNKINESIS_MIN_ELEVATION = 0.02;
/** Fewer events than this and the session cannot support event statistics. */
export const EXPRESSION_MIN_EVENTS = 3;

/**
 * Longest inter-frame gap an expression may span.
 *
 * Callers pass the concatenated frames of the accepted bins, and a rejected bin
 * leaves a hole in that sequence. Without this check an event opening before
 * the hole closes after it, fabricating one movement out of two unrelated
 * moments. The duration filter only catches holes wider than
 * {@link EXPRESSION_MAX_DURATION_MS}; a single rejected 5 s bin sits inside the
 * accepted window and passes.
 *
 * Matches the 200 ms gap the bin screener already tolerates within a bin, so
 * anything larger is by definition a discontinuity the screener rejected.
 * {@link detectBlinks} guards its own state machine the same way.
 */
export const EXPRESSION_MAX_FRAME_GAP_MS = 200;

export interface ExpressionPoint {
  x: number;
  y: number;
}

export interface ExpressionBaseline {
  leftCorner: ExpressionPoint;
  rightCorner: ExpressionPoint;
  leftEyeAperture: number;
  rightEyeAperture: number;
  /** Frames that contributed, for evidence reporting. */
  sampleCount: number;
}

/**
 * A detected expression, with the shape of its trajectory.
 *
 * Structurally the Tier-2 {@link ExpressionEventRecord}. Kept as its own name
 * because the detector's callers predate the record type; the fields are the
 * same set.
 */
export type ExpressionEvent = ExpressionEventRecord;

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function usable(frame: AmbientFacialFrame): boolean {
  return (
    frame.faceVisible &&
    frame.mouthCorners !== null &&
    finite(frame.mouthCorners.left.y) &&
    finite(frame.mouthCorners.right.y) &&
    finite(frame.tMs)
  );
}

/**
 * Resting mouth and eye geometry for the session.
 *
 * Uses the median over every usable frame rather than over frames known to be
 * outside an event. That avoids a circular dependency (events are defined
 * relative to the baseline) and is safe as long as expressions occupy well
 * under half the session, which holds for ordinary clinical conversation. If
 * a session were more than half smiling, the baseline would ride up and
 * events would be under-detected — a conservative failure, not a false signal.
 */
export function restingBaseline(
  frames: readonly AmbientFacialFrame[]
): ExpressionBaseline | null {
  const eligible = frames.filter(usable);
  if (eligible.length === 0) return null;
  const leftEyes = eligible
    .map((frame) => frame.eyeAperture?.left)
    .filter(finite);
  const rightEyes = eligible
    .map((frame) => frame.eyeAperture?.right)
    .filter(finite);
  return {
    leftCorner: {
      x: median(eligible.map((frame) => frame.mouthCorners!.left.x)),
      y: median(eligible.map((frame) => frame.mouthCorners!.left.y))
    },
    rightCorner: {
      x: median(eligible.map((frame) => frame.mouthCorners!.right.x)),
      y: median(eligible.map((frame) => frame.mouthCorners!.right.y))
    },
    leftEyeAperture: leftEyes.length > 0 ? median(leftEyes) : Number.NaN,
    rightEyeAperture: rightEyes.length > 0 ? median(rightEyes) : Number.NaN,
    sampleCount: eligible.length
  };
}

/** Corner rise above resting, per side. Negative values clamp to zero. */
function elevations(
  frame: AmbientFacialFrame,
  baseline: ExpressionBaseline
): { left: number; right: number } {
  const corners = frame.mouthCorners!;
  return {
    left: Math.max(0, baseline.leftCorner.y - corners.left.y),
    right: Math.max(0, baseline.rightCorner.y - corners.right.y)
  };
}

/**
 * The signal that opens and closes an event.
 *
 * Deliberately the MAXIMUM of the two sides, not the mean or a bilateral AND.
 * In unilateral palsy the affected side barely moves, so any rule requiring
 * both sides to clear the threshold would detect fewer events the more severe
 * the palsy — the instrument would go blind exactly where it is needed. Taking
 * the max keeps detection sensitivity independent of asymmetry; the asymmetry
 * itself is then measured within the detected event.
 */
function drive(frame: AmbientFacialFrame, baseline: ExpressionBaseline): number {
  const { left, right } = elevations(frame, baseline);
  return Math.max(left, right);
}

/**
 * Segment the frame stream into discrete expression events using Schmitt-style
 * hysteresis: open above the onset threshold, stay open until the drive falls
 * below the lower offset threshold.
 *
 * Detection is geometric. No affective state is inferred, labelled, or
 * returned; an "expression event" here is a named movement pattern of the
 * mouth, nothing more.
 */

interface DriveSample {
  tMs: number;
  value: number;
}

/** Time spent within 10% of the peak drive. */
function dwellAtPeak(drives: readonly DriveSample[], peakDrive: number): number {
  if (peakDrive <= 0 || drives.length < 2) return 0;
  const threshold = peakDrive * 0.9;
  let total = 0;
  for (let index = 1; index < drives.length; index += 1) {
    if (drives[index].value >= threshold && drives[index - 1].value >= threshold) {
      total += drives[index].tMs - drives[index - 1].tMs;
    }
  }
  return total;
}

/**
 * Exponential time constant of the return to baseline.
 *
 * Fitted as a least-squares line through ln(drive) after the peak; tau is the
 * negative reciprocal of its slope. The relaxation shape is what separates a
 * flaccid movement from a synkinetic one, which can reach similar peaks by
 * different paths.
 *
 * Null when the decay does not support a fit -- fewer than three usable points,
 * or a slope that is flat or rising, which is what a movement cut short by the
 * end of the window looks like. Fitting a constant to a truncated tail would
 * produce a number with no relaxation behind it.
 */
function decayTimeConstant(
  drives: readonly DriveSample[],
  peakMs: number,
  peakDrive: number
): number | null {
  if (peakDrive <= 0) return null;
  const tail = drives.filter(
    (sample) => sample.tMs > peakMs && sample.value > peakDrive * 0.05
  );
  if (tail.length < 3) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXy = 0;
  let sumXx = 0;
  for (const sample of tail) {
    const x = sample.tMs - peakMs;
    const y = Math.log(sample.value);
    sumX += x;
    sumY += y;
    sumXy += x * y;
    sumXx += x * x;
  }
  const count = tail.length;
  const denominator = count * sumXx - sumX * sumX;
  if (denominator === 0) return null;
  const slope = (count * sumXy - sumX * sumY) / denominator;
  if (!(slope < 0)) return null;
  const tau = -1 / slope;
  return Number.isFinite(tau) && tau > 0 ? tau : null;
}

export function detectExpressionEvents(
  frames: readonly AmbientFacialFrame[],
  baseline: ExpressionBaseline
): ExpressionEvent[] {
  const eligible = frames
    .filter(usable)
    .slice()
    .sort((left, right) => left.tMs - right.tMs || left.sequence - right.sequence);

  const events: ExpressionEvent[] = [];
  let open: AmbientFacialFrame[] = [];

  const close = (): void => {
    if (open.length === 0) return;
    const startMs = open[0].tMs;
    const endMs = open.at(-1)!.tMs;
    const durationMs = endMs - startMs;
    if (
      durationMs >= EXPRESSION_MIN_DURATION_MS &&
      durationMs <= EXPRESSION_MAX_DURATION_MS
    ) {
      let peak = open[0];
      let peakDrive = drive(peak, baseline);
      for (const frame of open) {
        const value = drive(frame, baseline);
        if (value > peakDrive) {
          peak = frame;
          peakDrive = value;
        }
      }
      const peakElevation = elevations(peak, baseline);
      const drives = open.map((frame) => ({
        tMs: frame.tMs,
        value: drive(frame, baseline)
      }));
      events.push({
        startMs,
        endMs,
        peakMs: peak.tMs,
        frameCount: open.length,
        peakElevationLeft: peakElevation.left,
        peakElevationRight: peakElevation.right,
        // Onset to peak. A brisk recruit and a slow one can reach the same
        // height, and only this separates them.
        riseMs: peak.tMs - startMs,
        dwellMs: dwellAtPeak(drives, peakDrive),
        decayTauMs: decayTimeConstant(drives, peak.tMs, peakDrive),
        lidApertureDeltaLeft: finite(peak.eyeAperture?.left)
          ? peak.eyeAperture.left - baseline.leftEyeAperture
          : Number.NaN,
        lidApertureDeltaRight: finite(peak.eyeAperture?.right)
          ? peak.eyeAperture.right - baseline.rightEyeAperture
          : Number.NaN
      });
    }
    open = [];
  };

  let previous: AmbientFacialFrame | null = null;
  for (const frame of eligible) {
    // A hole in the sequence -- a bin the screener rejected -- ends whatever
    // was open. Discarding rather than closing is deliberate: the movement's
    // real extent is unobserved, so its duration and peak are unknown.
    if (previous && frame.tMs - previous.tMs > EXPRESSION_MAX_FRAME_GAP_MS) {
      open = [];
    }
    previous = frame;
    const value = drive(frame, baseline);
    if (open.length === 0) {
      if (value >= EXPRESSION_ONSET_ELEVATION) open.push(frame);
      continue;
    }
    if (value >= EXPRESSION_OFFSET_ELEVATION) {
      open.push(frame);
      // A posture that never relaxes is not a discrete expression; cut it.
      if (frame.tMs - open[0].tMs > EXPRESSION_MAX_DURATION_MS) open = [];
      continue;
    }
    close();
  }
  close();
  return events;
}

/**
 * Signed left/right excursion asymmetry for one event, in [-1, 1].
 *
 * Zero is symmetric; positive means the subject's LEFT corner rose further.
 * Normalising by the sum makes this invariant to how big the expression was,
 * which is the point — expression amplitude depends on how funny the
 * conversation was, and that confound acts on both hemifaces equally.
 */
export function excursionAsymmetry(event: ExpressionEvent): number | null {
  const sum = event.peakElevationLeft + event.peakElevationRight;
  if (!finite(sum) || sum <= 0) return null;
  return (event.peakElevationLeft - event.peakElevationRight) / sum;
}

/**
 * Oculo-oral coupling difference for one event.
 *
 * A Duchenne smile narrows both eyes, so eye narrowing during a smile is
 * normal and is not by itself pathological. What distinguishes aberrant
 * regeneration is narrowing on one side that is disproportionate to the mouth
 * movement producing it:
 *
 *   (dEye_left / dMouth_left) - (dEye_right / dMouth_right)
 *
 * Negative means the subject's LEFT eye narrows more per unit of mouth
 * movement. Returns null when either side moved too little to divide by —
 * coupling is undefined on a side that does not move, and inventing a value
 * there would be exactly the imputation this system refuses elsewhere.
 */
export function synkinesisIndex(event: ExpressionEvent): number | null {
  const {
    peakElevationLeft,
    peakElevationRight,
    lidApertureDeltaLeft,
    lidApertureDeltaRight
  } = event;
  if (
    peakElevationLeft < SYNKINESIS_MIN_ELEVATION ||
    peakElevationRight < SYNKINESIS_MIN_ELEVATION ||
    !finite(lidApertureDeltaLeft) ||
    !finite(lidApertureDeltaRight)
  ) {
    return null;
  }
  return (
    lidApertureDeltaLeft / peakElevationLeft -
    lidApertureDeltaRight / peakElevationRight
  );
}

export interface ExpressionSummary {
  baseline: ExpressionBaseline;
  events: readonly ExpressionEvent[];
  eventCount: number;
  /** Events per minute of eligible observation. */
  eventRatePerMinute: number | null;
  /** P90 of the larger-side corner rise across events; expression magnitude. */
  excursionP90: number | null;
  /** Median signed left/right asymmetry across events. */
  excursionAsymmetryMedian: number | null;
  /** Median oculo-oral coupling difference across measurable events. */
  synkinesisIndexMedian: number | null;
  /** Events that met the movement floor on both sides. */
  synkinesisEventCount: number;
  /** Signed resting mouth-corner asymmetry; positive means left sits higher. */
  restMouthCornerAsymmetry: number;
  /** Signed resting eye-aperture asymmetry; positive means left is wider. */
  restEyeApertureAsymmetry: number | null;
}

export function summarizeExpressions(
  frames: readonly AmbientFacialFrame[],
  eligibleDurationMs: number
): ExpressionSummary | null {
  const baseline = restingBaseline(frames);
  if (!baseline) return null;
  const events = detectExpressionEvents(frames, baseline);

  const asymmetries = events
    .map(excursionAsymmetry)
    .filter((value): value is number => value !== null);
  const couplings = events
    .map(synkinesisIndex)
    .filter((value): value is number => value !== null);
  const magnitudes = events.map((event) =>
    Math.max(event.peakElevationLeft, event.peakElevationRight)
  );

  return {
    baseline,
    events,
    eventCount: events.length,
    eventRatePerMinute:
      eligibleDurationMs > 0
        ? events.length / (eligibleDurationMs / 60_000)
        : null,
    excursionP90: magnitudes.length > 0 ? percentile(magnitudes, 0.9) : null,
    excursionAsymmetryMedian:
      asymmetries.length > 0 ? median(asymmetries) : null,
    synkinesisIndexMedian: couplings.length > 0 ? median(couplings) : null,
    synkinesisEventCount: couplings.length,
    // Resting sign convention matches the event measures: +y is downward, so
    // a HIGHER corner has a SMALLER y. Subtracting left from right therefore
    // makes "left sits higher" positive, consistent with excursionAsymmetry.
    restMouthCornerAsymmetry:
      baseline.rightCorner.y - baseline.leftCorner.y,
    restEyeApertureAsymmetry:
      finite(baseline.leftEyeAperture) && finite(baseline.rightEyeAperture)
        ? baseline.leftEyeAperture - baseline.rightEyeAperture
        : null
  };
}
