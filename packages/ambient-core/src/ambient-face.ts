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

function ambientFrameUsable(
  frame: AmbientFacialFrame,
  options: AmbientFaceExtractionOptions
): boolean {
  const pose = frame.pose;
  return (
    frame.faceCount === 1 &&
    faceTrackSegmentId(frame) !== null &&
    evaluateVisualQuality(frame, null).usable &&
    pose !== null &&
    finite(pose.yawDegrees) &&
    Math.abs(pose.yawDegrees) <= AMBIENT_FACE_MAX_YAW_DEGREES &&
    finite(pose.pitchDegrees) &&
    Math.abs(pose.pitchDegrees) <= AMBIENT_FACE_MAX_PITCH_DEGREES &&
    finite(pose.rollDegrees) &&
    Math.abs(pose.rollDegrees) <= AMBIENT_FACE_MAX_ROLL_DEGREES &&
    calibratedSizeUsable(frame, options) &&
    completeGeometry(frame)
  );
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
  frames: AmbientFacialFrame[],
  options: AmbientFaceExtractionOptions
): FacialBin | null {
  if (frames.length < AMBIENT_FACE_MIN_SAMPLES_PER_BIN) return null;
  if (!frames.every((frame) => ambientFrameUsable(frame, options))) return null;
  const processorRefs = new Set(frames.map((frame) => frame.processorRef));
  const trackSegmentIds = new Set(frames.map(faceTrackSegmentId));
  const epochs = new Set(frames.map((frame) => frame.captureEpoch));
  if (
    processorRefs.size !== 1 ||
    trackSegmentIds.size !== 1 ||
    epochs.size !== 1
  ) {
    return null;
  }
  const gaps = frames
    .slice(1)
    .map((frame, frameIndex) => frame.tMs - frames[frameIndex].tMs);
  if (
    gaps.some(
      (gap) => gap <= 0 || gap > AMBIENT_FACE_MAX_FRAME_GAP_MS
    )
  ) {
    return null;
  }
  const actualSpanMs = frames.at(-1)!.tMs - frames[0].tMs;
  const stepMs = nominalStepMs(frames);
  const durationMs = Math.min(
    AMBIENT_FACE_BIN_MS,
    Math.round(
      (gaps.reduce((total, gap) => total + gap, 0) + stepMs) * 1_000
    ) / 1_000
  );
  if (
    actualSpanMs < AMBIENT_FACE_MIN_BIN_SPAN_MS ||
    durationMs < AMBIENT_FACE_MIN_BIN_DATA_MS
  ) {
    return null;
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
    return null;
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
  const bins = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([index, bucket]) => {
      const bin = qualifyBin(index, bucket, options);
      return bin ? [bin] : [];
    });
  return { bins, attributionFailureCount, qualityFailureCount };
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
    ...overrides
  };
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

function detectBlinks(
  bins: readonly FacialBin[]
): { count: number; perBinCounts: number[] } {
  const leftReference = percentile(
    bins.flatMap((bin) => bin.frames.map((frame) => frame.eyeAperture!.left)),
    0.9
  );
  const rightReference = percentile(
    bins.flatMap((bin) => bin.frames.map((frame) => frame.eyeAperture!.right)),
    0.9
  );
  const perBinCounts = bins.map(() => 0);
  let count = 0;
  let closureStartedAt: number | null = null;
  let suppressUntilRecovery = false;
  let lastAcceptedAt = Number.NEGATIVE_INFINITY;
  let previousFrame: AmbientFacialFrame | null = null;
  let previousBinIndex: number | null = null;

  for (let binIndex = 0; binIndex < bins.length; binIndex += 1) {
    const bin = bins[binIndex];
    const contiguousBin =
      previousBinIndex === null || bin.index === previousBinIndex + 1;
    if (!contiguousBin) {
      closureStartedAt = null;
      suppressUntilRecovery = false;
      previousFrame = null;
    }
    for (const frame of bin.frames) {
      if (
        previousFrame &&
        frame.tMs - previousFrame.tMs > AMBIENT_BLINK_MAX_P95_GAP_MS
      ) {
        closureStartedAt = null;
        suppressUntilRecovery = false;
      }
      const left = frame.eyeAperture!.left;
      const right = frame.eyeAperture!.right;
      const closed =
        left <= leftReference * AMBIENT_BLINK_CLOSURE_FRACTION &&
        right <= rightReference * AMBIENT_BLINK_CLOSURE_FRACTION;
      const recovered =
        left >= leftReference * AMBIENT_BLINK_RECOVERY_FRACTION &&
        right >= rightReference * AMBIENT_BLINK_RECOVERY_FRACTION;
      if (suppressUntilRecovery) {
        if (recovered) suppressUntilRecovery = false;
      } else if (closureStartedAt === null) {
        if (closed && frame.tMs - lastAcceptedAt >= AMBIENT_BLINK_REFRACTORY_MS) {
          closureStartedAt = frame.tMs;
        }
      } else {
        const elapsed = frame.tMs - closureStartedAt;
        if (elapsed > AMBIENT_BLINK_MAX_RECOVERY_MS) {
          closureStartedAt = null;
          suppressUntilRecovery = true;
        } else if (recovered) {
          if (elapsed >= AMBIENT_BLINK_MIN_CLOSURE_MS) {
            count += 1;
            perBinCounts[binIndex] += 1;
            lastAcceptedAt = frame.tMs;
          }
          closureStartedAt = null;
        }
      }
      previousFrame = frame;
    }
    previousBinIndex = bin.index;
  }
  return { count, perBinCounts };
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
    const blinks = detectBlinks(screening.bins);
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
    ignoredFrameCount
  };
}
