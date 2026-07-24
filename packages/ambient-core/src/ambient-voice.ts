import {
  median,
  medianAbsoluteDeviation,
  stdDev
} from "./stats.js";
import { ambientMetricDefinition } from "./ambient-registry.js";
import {
  measuredOutcome,
  sortedUnique,
  withheldOutcome
} from "./ambient-outcomes.js";
import {
  AMBIENT_MAX_CAPTURE_DURATION_MS,
  AMBIENT_VOICE_TASK_CONTEXT,
  type AmbientExtractionResult,
  type AmbientMetricEvidence,
  type AmbientMetricOutcome,
  type AmbientVoiceExtractionOptions,
  type AmbientVoiceFrame,
  type AmbientVoiceMetricCode,
  type AmbientWithheldReasonCode
} from "./ambient-types.js";

export const AMBIENT_VOICE_SEGMENT_MAX_MS = 10_000;
export const AMBIENT_VOICE_SEGMENT_MIN_MS = 2_000;
export const AMBIENT_VOICE_ACTIVE_PER_SEGMENT_MIN_MS = 1_000;
export const AMBIENT_VOICE_TIMING_MIN_MS = 30_000;
export const AMBIENT_VOICE_ACTIVE_MIN_MS = 15_000;
export const AMBIENT_VOICE_PITCH_MIN_MS = 10_000;
export const AMBIENT_VOICE_MIN_SEGMENTS = 3;
export const AMBIENT_VOICE_MIN_PITCH_COVERAGE = 0.6;
export const AMBIENT_VOICE_MIN_SEGMENT_COVERAGE = 0.9;
export const AMBIENT_VOICE_MIN_F0_HZ = 50;
export const AMBIENT_VOICE_MAX_F0_HZ = 700;
export const AMBIENT_VOICE_MIN_ESTIMATOR_QUALITY = 0.55;
export const AMBIENT_VOICE_MIN_ESTIMATOR_AGREEMENT = 0.7;
export const AMBIENT_VOICE_PITCH_BIN_MS = 500;
export const AMBIENT_VOICE_MIN_VALID_BINS_PER_SEGMENT = 4;
export const AMBIENT_VOICE_MIN_SAMPLE_RATE_HZ = 44_100;
export const AMBIENT_VOICE_MAX_GAP_MS = 40;
export const AMBIENT_VOICE_MAX_LOST_BLOCK_FRACTION = 0.05;
export const AMBIENT_VOICE_MAX_CLIPPED_FRACTION = 0.01;
export const AMBIENT_VOICE_MAX_ABSOLUTE_DC_OFFSET = 0.02;
export const AMBIENT_VOICE_MIN_SPEECH_SNR_DB = 15;
export const AMBIENT_VOICE_MIN_PAUSE_MS = 200;
export const AMBIENT_VOICE_MAX_PAUSE_MS = 1_999;
export const AMBIENT_VOICE_MIN_PAUSE_OR_RUN_COUNT = 5;
export const AMBIENT_VOICE_MIN_NUCLEUS_COUNT = 30;

const VOICE_CODES: readonly AmbientVoiceMetricCode[] = [
  "ambient.voice.f0.median",
  "ambient.voice.f0.variability",
  "ambient.voice.speech_activity_fraction",
  "ambient.voice.pause_rate",
  "ambient.voice.pause_duration.median",
  "ambient.voice.speech_run_duration.median",
  "ambient.voice.acoustic_nucleus_rate"
];

const FRAME_BLOCKING_REASONS = new Set<string>([
  "microphone-unavailable",
  "audio-worklet-unavailable",
  "audio-frame-gap",
  "sample-rate-below-minimum",
  "audio-clipping",
  "dc-offset",
  "voice-worker-unavailable",
  "document-hidden"
]);

interface PreparedVoiceFrame {
  frame: AmbientVoiceFrame;
  speechActive: boolean;
  periodic: boolean;
  trackSegmentId: string;
}

interface VoiceSegment {
  frames: PreparedVoiceFrame[];
  startMs: number;
  endMs: number;
  durationMs: number;
  activeDurationMs: number;
  pitchedDurationMs: number;
  coverage: number;
  processorRef: string;
  trackSegmentId: string;
  captureEpoch: number;
  sourceWindowRef: string;
}

interface RunDurations {
  speechRunsMs: number[];
  pausesMs: number[];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function timingFrameUsable(frame: AmbientVoiceFrame): boolean {
  const active = frame.speechActive;
  return (
    frame.taskContext === AMBIENT_VOICE_TASK_CONTEXT &&
    typeof frame.speechActive === "boolean" &&
    typeof frame.periodic === "boolean" &&
    typeof frame.trackSegmentId === "string" &&
    frame.trackSegmentId.length > 0 &&
    finite(frame.tMs) &&
    finite(frame.sampleRateHz) &&
    frame.sampleRateHz >= AMBIENT_VOICE_MIN_SAMPLE_RATE_HZ &&
    finite(frame.blockGapMs) &&
    frame.blockGapMs <= AMBIENT_VOICE_MAX_GAP_MS &&
    finite(frame.lostBlockFraction) &&
    frame.lostBlockFraction <=
      AMBIENT_VOICE_MAX_LOST_BLOCK_FRACTION &&
    finite(frame.clippedSampleFraction) &&
    frame.clippedSampleFraction <=
      AMBIENT_VOICE_MAX_CLIPPED_FRACTION &&
    finite(frame.dcOffset) &&
    Math.abs(frame.dcOffset) <=
      AMBIENT_VOICE_MAX_ABSOLUTE_DC_OFFSET &&
    (!active ||
      (finite(frame.snrDb) &&
        frame.snrDb >= AMBIENT_VOICE_MIN_SPEECH_SNR_DB)) &&
    !frame.qualityReasons.some((reason) =>
      FRAME_BLOCKING_REASONS.has(reason)
    )
  );
}

function validPitch(frame: PreparedVoiceFrame): boolean {
  const f0 = frame.frame.f0Hz;
  return (
    frame.speechActive &&
    frame.periodic &&
    f0 !== null &&
    finite(f0) &&
    f0 >= AMBIENT_VOICE_MIN_F0_HZ &&
    f0 <= AMBIENT_VOICE_MAX_F0_HZ &&
    finite(frame.frame.f0Confidence) &&
    frame.frame.f0Confidence >= AMBIENT_VOICE_MIN_ESTIMATOR_QUALITY &&
    finite(frame.frame.estimatorAgreement) &&
    frame.frame.estimatorAgreement >= AMBIENT_VOICE_MIN_ESTIMATOR_AGREEMENT
  );
}

function nominalStepMs(frames: readonly PreparedVoiceFrame[]): number {
  const steps = frames
    .slice(1)
    .map((entry, index) => entry.frame.tMs - frames[index].frame.tMs)
    .filter((value) => value > 0 && value <= AMBIENT_VOICE_MAX_GAP_MS);
  return steps.length === 0 ? 10 : median(steps);
}

function frameWeightsMs(
  frames: readonly PreparedVoiceFrame[]
): number[] {
  const nominal = nominalStepMs(frames);
  return frames.map((entry, index) => {
    const next = frames[index + 1];
    return next
      ? Math.min(
          AMBIENT_VOICE_MAX_GAP_MS,
          Math.max(0, next.frame.tMs - entry.frame.tMs)
        )
      : nominal;
  });
}

function segmentFromFrames(
  frames: PreparedVoiceFrame[]
): VoiceSegment | null {
  if (frames.length < 2) return null;
  const weights = frameWeightsMs(frames);
  const durationMs = weights.reduce((total, value) => total + value, 0);
  const activeDurationMs = weights.reduce(
    (total, value, index) =>
      total + (frames[index].speechActive ? value : 0),
    0
  );
  const pitchedDurationMs = weights.reduce(
    (total, value, index) =>
      total + (validPitch(frames[index]) ? value : 0),
    0
  );
  const expectedFrames =
    Math.floor(
      (frames.at(-1)!.frame.tMs - frames[0].frame.tMs) /
        nominalStepMs(frames)
    ) + 1;
  const cadenceCoverage = Math.min(1, frames.length / expectedFrames);
  const lostCoverage =
    1 - Math.max(...frames.map((entry) => entry.frame.lostBlockFraction));
  const coverage = Math.min(cadenceCoverage, lostCoverage);
  if (
    durationMs < AMBIENT_VOICE_SEGMENT_MIN_MS ||
    activeDurationMs < AMBIENT_VOICE_ACTIVE_PER_SEGMENT_MIN_MS ||
    coverage < AMBIENT_VOICE_MIN_SEGMENT_COVERAGE
  ) {
    return null;
  }
  const first = frames[0];
  const last = frames.at(-1)!;
  return {
    frames,
    startMs: first.frame.tMs,
    endMs: last.frame.tMs + nominalStepMs(frames),
    durationMs,
    activeDurationMs,
    pitchedDurationMs,
    coverage,
    processorRef: first.frame.processorRef,
    trackSegmentId: first.trackSegmentId,
    captureEpoch: first.frame.captureEpoch,
    sourceWindowRef: [
      "voice",
      first.frame.captureEpoch,
      first.trackSegmentId,
      first.frame.tMs,
      last.frame.tMs + nominalStepMs(frames)
    ].join(":")
  };
}

function eligibleSegments(
  frames: readonly AmbientVoiceFrame[],
  sessionStartedAtMs: number
): VoiceSegment[] {
  const segments: VoiceSegment[] = [];
  let current: PreparedVoiceFrame[] = [];
  let currentBucket: number | null = null;

  const flush = (): void => {
    const segment = segmentFromFrames(current);
    if (segment) segments.push(segment);
    current = [];
    currentBucket = null;
  };

  for (const frame of frames) {
    if (!timingFrameUsable(frame)) {
      flush();
      continue;
    }
    const prepared: PreparedVoiceFrame = {
      frame,
      speechActive: frame.speechActive,
      periodic: frame.periodic,
      trackSegmentId: frame.trackSegmentId
    };
    const bucket = Math.floor(
      (frame.tMs - sessionStartedAtMs) / AMBIENT_VOICE_SEGMENT_MAX_MS
    );
    const prior = current.at(-1);
    if (
      prior &&
      (frame.tMs <= prior.frame.tMs ||
        frame.tMs - prior.frame.tMs > AMBIENT_VOICE_MAX_GAP_MS ||
        frame.captureEpoch !== prior.frame.captureEpoch ||
        frame.processorRef !== prior.frame.processorRef ||
        prepared.trackSegmentId !== prior.trackSegmentId ||
        bucket !== currentBucket)
    ) {
      flush();
    }
    currentBucket = bucket;
    current.push(prepared);
  }
  flush();
  return segments;
}

function pitchValues(segment: VoiceSegment): number[] {
  return segment.frames.flatMap((entry) =>
    validPitch(entry) ? [entry.frame.f0Hz!] : []
  );
}

function semitoneStdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = median([...values]);
  return stdDev(values.map((value) => 12 * Math.log2(value / center)));
}

function validPitchSubwindows(segment: VoiceSegment): number[][] {
  const bins = new Map<number, PreparedVoiceFrame[]>();
  for (const frame of segment.frames) {
    const index = Math.floor(
      (frame.frame.tMs - segment.startMs) / AMBIENT_VOICE_PITCH_BIN_MS
    );
    const bucket = bins.get(index) ?? [];
    bucket.push(frame);
    bins.set(index, bucket);
  }
  return [...bins.values()].flatMap((frames) => {
    const weights = frameWeightsMs(frames);
    const coveredMs = weights.reduce((total, value) => total + value, 0);
    const pitchedMs = weights.reduce(
      (total, value, index) =>
        total + (validPitch(frames[index]) ? value : 0),
      0
    );
    const values = frames.flatMap((entry) =>
      validPitch(entry) ? [entry.frame.f0Hz!] : []
    );
    return coveredMs >= 400 &&
      pitchedMs >= 300 &&
      values.length >= 2
      ? [values]
      : [];
  });
}

function internalRuns(segment: VoiceSegment): RunDurations {
  const weights = frameWeightsMs(segment.frames);
  const raw: Array<{ active: boolean; durationMs: number }> = [];
  for (let index = 0; index < segment.frames.length; index += 1) {
    const active = segment.frames[index].speechActive;
    const prior = raw.at(-1);
    if (prior?.active === active) prior.durationMs += weights[index];
    else raw.push({ active, durationMs: weights[index] });
  }
  return {
    speechRunsMs: raw
      .filter((run) => run.active)
      .map((run) => run.durationMs),
    // Leading and trailing quiet are exposure, not a pause between speech runs.
    pausesMs: raw
      .slice(1, -1)
      .filter(
        (run) =>
          !run.active &&
          run.durationMs >= AMBIENT_VOICE_MIN_PAUSE_MS &&
          run.durationMs <= AMBIENT_VOICE_MAX_PAUSE_MS
      )
      .map((run) => run.durationMs)
  };
}

function dispersion(values: readonly number[]): number | null {
  return values.length >= 2
    ? medianAbsoluteDeviation([...values])
    : null;
}

/**
 * Lowest estimator confidence and agreement among the frames that actually
 * contributed pitch. Both gates are enforced per frame inside {@link validPitch},
 * so the worst accepted frame is what a threshold has to hold against.
 *
 * Returns no facts when nothing contributed pitch. A pitch metric cannot be
 * measured in that case, and emitting a placeholder would assert evidence the
 * session does not contain.
 */
function estimatorFacts(segments: readonly VoiceSegment[]): {
  estimatorQuality?: number;
  estimatorAgreement?: number;
} {
  const pitched = segments.flatMap((segment) =>
    segment.frames.filter((frame) => validPitch(frame))
  );
  if (pitched.length === 0) return {};
  return {
    estimatorQuality: Math.min(
      ...pitched.map((frame) => frame.frame.f0Confidence)
    ),
    estimatorAgreement: Math.min(
      ...pitched.map((frame) => frame.frame.estimatorAgreement)
    )
  };
}

function evidenceFor(
  sourceFrames: readonly AmbientVoiceFrame[],
  segments: readonly VoiceSegment[],
  overrides: Partial<AmbientMetricEvidence> = {}
): AmbientMetricEvidence {
  const observed = sourceFrames.filter((frame) => finite(frame.tMs));
  const eligibleDurationMs = segments.reduce(
    (total, segment) => total + segment.durationMs,
    0
  );
  const activeSpeechDurationMs = segments.reduce(
    (total, segment) => total + segment.activeDurationMs,
    0
  );
  const pitchedDurationMs = segments.reduce(
    (total, segment) => total + segment.pitchedDurationMs,
    0
  );
  return {
    observedStartMs: observed[0]?.tMs ?? null,
    observedEndMs: observed.at(-1)?.tMs ?? null,
    eligibleDurationMs,
    sampleCount: segments.reduce(
      (total, segment) => total + segment.frames.length,
      0
    ),
    segmentCount: segments.length,
    qualifyingBinCount: 0,
    activeSpeechDurationMs,
    pitchedDurationMs,
    pitchCoverage:
      activeSpeechDurationMs > 0
        ? pitchedDurationMs / activeSpeechDurationMs
        : 0,
    // Worst contributing segment bounds the timing evidence. Every accepted
    // segment already cleared AMBIENT_VOICE_MIN_SEGMENT_COVERAGE, so this
    // lets the report layer re-verify that gate on the same statistic
    // rather than inferring it from voicing.
    timingCoverage:
      segments.length > 0
        ? Math.min(...segments.map((segment) => segment.coverage))
        : undefined,
    // Same worst-case rule, extended to the remaining per-segment gates so the
    // report can re-verify each one instead of skipping it.
    segmentSpanMs:
      segments.length > 0
        ? Math.min(...segments.map((segment) => segment.durationMs))
        : undefined,
    activeSpeechPerSegmentMs:
      segments.length > 0
        ? Math.min(...segments.map((segment) => segment.activeDurationMs))
        : undefined,
    validBinsPerSegment:
      segments.length > 0
        ? Math.min(
            ...segments.map(
              (segment) => validPitchSubwindows(segment).length
            )
          )
        : undefined,
    // The two estimator gates are enforced per frame, so the worst accepted
    // frame is what the threshold has to hold against.
    ...estimatorFacts(segments),
    processorRefs: sortedUnique(
      segments.length > 0
        ? segments.map((segment) => segment.processorRef)
        : observed.map((frame) => frame.processorRef)
    ),
    trackSegmentIds: sortedUnique(
      segments.length > 0
        ? segments.map((segment) => segment.trackSegmentId)
        : observed.flatMap((frame) =>
            typeof frame.trackSegmentId === "string" &&
            frame.trackSegmentId.length > 0
              ? [frame.trackSegmentId]
              : []
          )
    ),
    sourceWindowRefs: segments.map((segment) => segment.sourceWindowRef),
    ...overrides
  };
}

function technicalQualityScore(segments: readonly VoiceSegment[]): number {
  if (segments.length === 0) return 0;
  const frames = segments.flatMap((segment) => segment.frames);
  const active = frames.filter((entry) => entry.speechActive);
  const coverage = median(segments.map((segment) => segment.coverage));
  const snr =
    active.length === 0
      ? 0
      : clamp01(
          (median(active.map((entry) => entry.frame.snrDb)) - 15) / 15
        );
  const clipping =
    1 -
    clamp01(
      Math.max(...frames.map((entry) => entry.frame.clippedSampleFraction)) /
        AMBIENT_VOICE_MAX_CLIPPED_FRACTION
    );
  const continuity =
    1 -
    clamp01(
      Math.max(...frames.map((entry) => entry.frame.lostBlockFraction)) /
        AMBIENT_VOICE_MAX_LOST_BLOCK_FRACTION
    );
  return clamp01(0.35 * coverage + 0.3 * snr + 0.2 * clipping + 0.15 * continuity);
}

function commonFailure(
  segments: readonly VoiceSegment[],
  evidence: AmbientMetricEvidence
): { reasonCode: AmbientWithheldReasonCode; detail: string } | null {
  if (segments.length === 0) {
    return {
      reasonCode: "no-usable-signal",
      detail:
        "No audio segment met continuity, sample-rate, clipping, DC-offset, active-speech SNR, duration, and coverage requirements."
    };
  }
  if (
    new Set(segments.map((segment) => segment.processorRef)).size > 1 ||
    new Set(
      segments.map(
        (segment) =>
          `${segment.captureEpoch}\u0000${segment.trackSegmentId}`
      )
    ).size > 1
  ) {
    return {
      reasonCode: "quality-threshold-failed",
      detail:
        "Eligible audio crossed a processor, capture epoch, or track segment."
    };
  }
  if (segments.length < AMBIENT_VOICE_MIN_SEGMENTS) {
    return {
      reasonCode: "insufficient-segments",
      detail: `At least ${AMBIENT_VOICE_MIN_SEGMENTS} eligible audio segments are required.`
    };
  }
  if ((evidence.eligibleDurationMs ?? 0) < AMBIENT_VOICE_TIMING_MIN_MS) {
    return {
      reasonCode: "insufficient-duration",
      detail: `At least ${AMBIENT_VOICE_TIMING_MIN_MS / 1_000} seconds of eligible audio are required.`
    };
  }
  if (
    (evidence.activeSpeechDurationMs ?? 0) < AMBIENT_VOICE_ACTIVE_MIN_MS
  ) {
    return {
      reasonCode: "insufficient-active-speech",
      detail: `At least ${AMBIENT_VOICE_ACTIVE_MIN_MS / 1_000} seconds of active speech are required.`
    };
  }
  return null;
}

export function extractAmbientVoiceMetrics(
  frames: readonly AmbientVoiceFrame[],
  options: AmbientVoiceExtractionOptions
): AmbientExtractionResult {
  const captureEndMs =
    options.sessionStartedAtMs + AMBIENT_MAX_CAPTURE_DURATION_MS;
  const inRange = frames.filter(
    (frame) =>
      finite(frame.tMs) &&
      frame.tMs >= options.sessionStartedAtMs &&
      frame.tMs < captureEndMs
  );
  const ignoredFrameCount = frames.length - inRange.length;
  const segments = eligibleSegments(inRange, options.sessionStartedAtMs);
  const baseEvidence = evidenceFor(inRange, segments);

  if (options.noiseCalibrationDurationMs < 2_000) {
    return {
      ignoredFrameCount,
      outcomes: VOICE_CODES.map((code) =>
        withheldOutcome(
          code,
          options,
          baseEvidence,
          "quality-threshold-failed",
          "At least two seconds of non-speech noise calibration are required."
        )
      )
    };
  }

  const qualityScore = technicalQualityScore(segments);
  const common = commonFailure(segments, baseEvidence);
  const outcomes: AmbientMetricOutcome[] = [];

  const pitchSegments = segments.filter(
    (segment) => segment.pitchedDurationMs >= 1_000
  );
  const pitchCoverage = baseEvidence.pitchCoverage ?? 0;
  const pitchFailure =
    common ??
    (pitchSegments.length < AMBIENT_VOICE_MIN_SEGMENTS ||
    (baseEvidence.pitchedDurationMs ?? 0) < AMBIENT_VOICE_PITCH_MIN_MS ||
    pitchCoverage < AMBIENT_VOICE_MIN_PITCH_COVERAGE
      ? {
          reasonCode: "insufficient-pitched-speech" as const,
          detail:
            "Pitch requires three eligible segments with at least one pitched second each, ten pitched seconds total, and 60% pitch coverage."
        }
      : null);

  const f0Code: AmbientVoiceMetricCode = "ambient.voice.f0.median";
  if (pitchFailure) {
    outcomes.push(
      withheldOutcome(
        f0Code,
        options,
        baseEvidence,
        pitchFailure.reasonCode,
        pitchFailure.detail
      )
    );
  } else {
    const values = pitchSegments.map((segment) =>
      median(pitchValues(segment))
    );
    outcomes.push(
      measuredOutcome(
        f0Code,
        options,
        baseEvidence,
        median(values),
        qualityScore,
        dispersion(values)
      )
    );
  }

  const variabilityCode: AmbientVoiceMetricCode =
    "ambient.voice.f0.variability";
  const variabilitySegments = pitchSegments.flatMap((segment) => {
    const subwindows = validPitchSubwindows(segment);
    return subwindows.length >= AMBIENT_VOICE_MIN_VALID_BINS_PER_SEGMENT
      ? [
          semitoneStdDev(
            subwindows.map((values) => median(values))
          )
        ]
      : [];
  });
  if (pitchFailure || variabilitySegments.length < 3) {
    outcomes.push(
      withheldOutcome(
        variabilityCode,
        options,
        baseEvidence,
        pitchFailure?.reasonCode ?? "insufficient-pitch-bins",
        pitchFailure?.detail ??
          "Pitch variability requires four valid 500 ms subwindows in each of three eligible segments."
      )
    );
  } else {
    outcomes.push(
      measuredOutcome(
        variabilityCode,
        options,
        baseEvidence,
        median(variabilitySegments),
        qualityScore,
        dispersion(variabilitySegments)
      )
    );
  }

  const runsBySegment = segments.map((segment) => internalRuns(segment));
  const pauses = runsBySegment.flatMap((runs) => runs.pausesMs);
  const speechRuns = runsBySegment.flatMap((runs) => runs.speechRunsMs);
  const nucleiBySegment = segments.map(
    (segment) =>
      segment.frames.filter(
        (entry) => entry.speechActive && entry.frame.syllabicNucleus
      ).length
  );
  const nucleusCount = nucleiBySegment.reduce(
    (total, value) => total + value,
    0
  );
  const timingEvidence = evidenceFor(inRange, segments, {
    pauseCount: pauses.length,
    speechRunCount: speechRuns.length,
    nucleusCount
  });
  const timingFailure = commonFailure(segments, timingEvidence);

  const activityCode: AmbientVoiceMetricCode =
    "ambient.voice.speech_activity_fraction";
  if (timingFailure) {
    outcomes.push(
      withheldOutcome(
        activityCode,
        options,
        timingEvidence,
        timingFailure.reasonCode,
        timingFailure.detail
      )
    );
  } else {
    const ratios = segments.map(
      (segment) => segment.activeDurationMs / segment.durationMs
    );
    outcomes.push(
      measuredOutcome(
        activityCode,
        options,
        timingEvidence,
        (timingEvidence.activeSpeechDurationMs ?? 0) /
          timingEvidence.eligibleDurationMs,
        qualityScore,
        dispersion(ratios)
      )
    );
  }

  const pauseRateCode: AmbientVoiceMetricCode =
    "ambient.voice.pause_rate";
  if (timingFailure) {
    outcomes.push(
      withheldOutcome(
        pauseRateCode,
        options,
        timingEvidence,
        timingFailure.reasonCode,
        timingFailure.detail
      )
    );
  } else {
    const rates = segments.map((segment, index) =>
      segment.durationMs > 0
        ? runsBySegment[index].pausesMs.length /
          (segment.durationMs / 60_000)
        : 0
    );
    outcomes.push(
      measuredOutcome(
        pauseRateCode,
        options,
        timingEvidence,
        pauses.length / (timingEvidence.eligibleDurationMs / 60_000),
        qualityScore,
        dispersion(rates)
      )
    );
  }

  const pauseDurationCode: AmbientVoiceMetricCode =
    "ambient.voice.pause_duration.median";
  if (timingFailure || pauses.length < AMBIENT_VOICE_MIN_PAUSE_OR_RUN_COUNT) {
    outcomes.push(
      withheldOutcome(
        pauseDurationCode,
        options,
        timingEvidence,
        timingFailure?.reasonCode ?? "insufficient-events",
        timingFailure?.detail ??
          `At least ${AMBIENT_VOICE_MIN_PAUSE_OR_RUN_COUNT} bounded internal pauses are required.`
      )
    );
  } else {
    const perSegment = runsBySegment.flatMap((runs) =>
      runs.pausesMs.length > 0 ? [median(runs.pausesMs) / 1_000] : []
    );
    outcomes.push(
      measuredOutcome(
        pauseDurationCode,
        options,
        timingEvidence,
        median(pauses) / 1_000,
        qualityScore,
        dispersion(perSegment)
      )
    );
  }

  const runDurationCode: AmbientVoiceMetricCode =
    "ambient.voice.speech_run_duration.median";
  if (
    timingFailure ||
    speechRuns.length < AMBIENT_VOICE_MIN_PAUSE_OR_RUN_COUNT
  ) {
    outcomes.push(
      withheldOutcome(
        runDurationCode,
        options,
        timingEvidence,
        timingFailure?.reasonCode ?? "insufficient-events",
        timingFailure?.detail ??
          `At least ${AMBIENT_VOICE_MIN_PAUSE_OR_RUN_COUNT} speech runs are required.`
      )
    );
  } else {
    const perSegment = runsBySegment.flatMap((runs) =>
      runs.speechRunsMs.length > 0
        ? [median(runs.speechRunsMs) / 1_000]
        : []
    );
    outcomes.push(
      measuredOutcome(
        runDurationCode,
        options,
        timingEvidence,
        median(speechRuns) / 1_000,
        qualityScore,
        dispersion(perSegment)
      )
    );
  }

  const nucleusCode: AmbientVoiceMetricCode =
    "ambient.voice.acoustic_nucleus_rate";
  if (timingFailure || nucleusCount < AMBIENT_VOICE_MIN_NUCLEUS_COUNT) {
    outcomes.push(
      withheldOutcome(
        nucleusCode,
        options,
        timingEvidence,
        timingFailure?.reasonCode ?? "insufficient-nuclei",
        timingFailure?.detail ??
          `At least ${AMBIENT_VOICE_MIN_NUCLEUS_COUNT} acoustic nuclei are required.`
      )
    );
  } else {
    const perSegment = segments.map((segment, index) =>
      nucleiBySegment[index] / (segment.activeDurationMs / 1_000)
    );
    outcomes.push(
      measuredOutcome(
        nucleusCode,
        options,
        timingEvidence,
        nucleusCount /
          ((timingEvidence.activeSpeechDurationMs ?? 0) / 1_000),
        qualityScore,
        dispersion(perSegment)
      )
    );
  }

  const ordered = VOICE_CODES.map((code) => {
    const outcome = outcomes.find((candidate) => candidate.code === code);
    if (!outcome) {
      const definition = ambientMetricDefinition(code);
      throw new Error(`Missing outcome for ${definition.label}.`);
    }
    return outcome;
  });
  return {
    outcomes: ordered,
    ignoredFrameCount
  };
}
