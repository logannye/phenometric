/**
 * Tier-2 kinematic event records.
 *
 * The session aggregates this pipeline publishes are counts and medians: a
 * blink rate, a pause rate, a median run duration. Those are projections of
 * events that were fully observed and then discarded. A blink is not a count --
 * it is a closing edge, a closed interval, and a reopening edge, and which of
 * those three is abnormal is what separates one condition from another. Keeping
 * the parameters means a measure defined later can be computed from sessions
 * already captured, instead of requiring them to be recaptured.
 *
 * These records stay provider-side. They are deliberately NOT in
 * `@phenometrix/contracts`: nothing here crosses a boundary, so nothing here
 * needs a Zod schema, an identity, or a place in the protocol pack.
 *
 * Naming constraint: three separate tests assert that no serialised structure
 * carries a field matching `landmarks`, `mouthCorners`, `eyeAperture`, `pcm`,
 * `waveform`, `embedding`, or `voiceprint`. The lid fields below are named
 * `lidAperture*` for that reason, not by preference.
 *
 * Every duration is milliseconds and every geometric quantity is in inter-eye
 * units, matching the frame contract. Velocities are therefore inter-eye units
 * per second.
 */

/** Which side of the subject an event or measurement belongs to. */
export type SubjectSide = "left" | "right";

/**
 * One eyelid closure.
 *
 * Recorded per eye rather than for the pair. The existing detector requires
 * both eyes below threshold simultaneously, which cannot see a unilateral
 * closure at all -- precisely the case a facial palsy produces, and precisely
 * the case the pair-wise rule discards.
 *
 * The three phases are separated because they dissociate clinically: reduced
 * rate is hypomimia, a slow or incomplete `closingVelocity` with a shallow
 * `depth` is orbicularis weakness, and a delayed reopening is the fatigable
 * pattern of a neuromuscular junction disorder.
 */
export interface BlinkEventRecord {
  side: SubjectSide;
  /** Frame time at which the lid began to close. */
  onsetMs: number;
  /** Frame time of maximum closure. */
  peakMs: number;
  /** Frame time at which the lid returned to its open reference. */
  offsetMs: number;
  /** Lid aperture at rest for this eye, the reference the phases are against. */
  openReference: number;
  /** Minimum lid aperture reached. Lower is more closed. */
  lidApertureMinimum: number;
  /**
   * Fraction of the open reference that was actually traversed, 0 to 1. A
   * complete closure approaches 1; lagophthalmos is the case that does not.
   */
  depth: number;
  /** Mean rate of closing, inter-eye units per second. */
  closingVelocity: number;
  /** Mean rate of reopening, inter-eye units per second. */
  openingVelocity: number;
  /** Time held at or below the closure threshold. */
  closedDwellMs: number;
  /** Frames that contributed. A low count means the phases are coarse. */
  frameCount: number;
  /**
   * Whether every frame spanning this event stayed inside the pose limits the
   * session metrics require.
   *
   * Detection runs on a looser stream than measurement, because a blink or a
   * mouth movement is recoverable at a head angle that would invalidate a
   * left-versus-right geometric comparison. Rate and timing can use every
   * event; anything comparing the two sides should use only those flagged
   * true.
   */
  poseWithinMeasurementLimits: boolean;
}

/**
 * A spontaneous facial movement, with the shape of its trajectory.
 *
 * The existing record keeps only the peak. Rise, dwell, and decay are what
 * distinguish a flaccid movement from a synkinetic one, which reach similar
 * peaks by different paths.
 */
export interface ExpressionEventRecord {
  startMs: number;
  peakMs: number;
  endMs: number;
  frameCount: number;
  /** Corner elevation above the resting baseline, per side, at peak. */
  peakElevationLeft: number;
  peakElevationRight: number;
  /** Onset to peak. Short is abrupt; long is a slow recruit. */
  riseMs: number;
  /** Time held within a small band of the peak. */
  dwellMs: number;
  /**
   * Exponential time constant of the return to baseline, or null when the
   * decay does not fit one -- a movement cut short by the end of the window,
   * or one that never returns. Null is a real abstention: a fitted constant
   * over a truncated tail would be a number without a movement behind it.
   */
  decayTauMs: number | null;
  /** Lid aperture change at peak, per side, for oculo-oral coupling. */
  lidApertureDeltaLeft: number;
  lidApertureDeltaRight: number;
  /**
   * Whether every frame spanning this event stayed inside the pose limits the
   * session metrics require.
   *
   * Detection runs on a looser stream than measurement, because a blink or a
   * mouth movement is recoverable at a head angle that would invalidate a
   * left-versus-right geometric comparison. Rate and timing can use every
   * event; anything comparing the two sides should use only those flagged
   * true.
   */
  poseWithinMeasurementLimits: boolean;
}

/** What ended a stretch of speech, which decides what the silence measures. */
export type PauseKind =
  /**
   * Followed by an audible inspiration. A respiratory quantity: it reflects
   * breath-group length and the work of drawing the next breath.
   */
  | "breath"
  /**
   * No inspiration detected. A cognitive and linguistic quantity: retrieval
   * time, planning, hesitation.
   */
  | "hesitation"
  /**
   * Bounded by the start or end of the observation window, so its true extent
   * is unknown. Retained rather than dropped -- the current path filters these
   * out and records nothing, which makes an unobserved pause indistinguishable
   * from a pause that did not happen.
   */
  | "truncated";

/** One silence between stretches of speech. */
export interface PauseEventRecord {
  startMs: number;
  endMs: number;
  durationMs: number;
  kind: PauseKind;
}

/**
 * One continuous stretch of speech between pauses.
 *
 * `phonatedMs` is separated from `durationMs` because a run can be long while
 * little of it is voiced. The ratio is a different quantity from either.
 */
export interface SpeechRunEventRecord {
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Portion carrying periodic phonation. */
  phonatedMs: number;
  /** Syllabic nuclei counted within the run. */
  nucleusCount: number;
  /** Mean and peak intensity, relative units -- AGC is off, but SPL is not calibrated. */
  meanIntensity: number;
  peakIntensity: number;
}

/**
 * Everything Tier 2 extracted from one session.
 *
 * Ordered by time within each array. Empty arrays mean the detector ran and
 * found nothing, which is distinct from the detector not having run; the
 * latter is represented by the whole record being absent.
 */
export interface SessionEventRecords {
  blinks: readonly BlinkEventRecord[];
  expressions: readonly ExpressionEventRecord[];
  pauses: readonly PauseEventRecord[];
  speechRuns: readonly SpeechRunEventRecord[];
}

/*
 * What a detector produces, before pose context is attached.
 *
 * The detectors work on geometry alone and have no view of the pose limits the
 * session metrics impose, so they must not assert that field. Whatever holds
 * both the events and the pose stream fills it in.
 */
export type DetectedBlink = Omit<
  BlinkEventRecord,
  "poseWithinMeasurementLimits"
>;
export type DetectedExpression = Omit<
  ExpressionEventRecord,
  "poseWithinMeasurementLimits"
>;
