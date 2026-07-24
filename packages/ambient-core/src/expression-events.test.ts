import { describe, expect, it } from "vitest";
import { syntheticFacialFrame } from "./test-helpers.js";
import type { AmbientFacialFrame } from "./ambient-types.js";
import {
  EXPRESSION_MIN_DURATION_MS,
  detectExpressionEvents,
  excursionAsymmetry,
  restingBaseline,
  summarizeExpressions,
  synkinesisIndex
} from "./expression-events.js";

const REST_CORNER_Y = 0.9;
const REST_EYE = 0.3;

interface Shape {
  /** Corner rise above rest, inter-eye units. +y is down, so rise lowers y. */
  liftLeft: number;
  liftRight: number;
  /** Eye aperture change; negative narrows. */
  eyeDeltaLeft?: number;
  eyeDeltaRight?: number;
}

function frameAt(tMs: number, shape: Shape): AmbientFacialFrame {
  return {
    ...syntheticFacialFrame(tMs, "ambient-frontal", {
      eyeAperture: {
        left: REST_EYE + (shape.eyeDeltaLeft ?? 0),
        right: REST_EYE + (shape.eyeDeltaRight ?? 0)
      },
      mouthCorners: {
        left: { x: 0.3, y: REST_CORNER_Y - shape.liftLeft },
        right: { x: -0.3, y: REST_CORNER_Y - shape.liftRight }
      }
    }),
    faceCount: 1,
    trackSegmentId: "face:track:one"
  };
}

/** Rest for `restMs`, then one expression of `holdMs` at the given shape. */
function session(
  shape: Shape,
  { restMs = 6_000, holdMs = 1_000, stepMs = 40 } = {}
): AmbientFacialFrame[] {
  const frames: AmbientFacialFrame[] = [];
  for (let tMs = 0; tMs < restMs; tMs += stepMs) {
    frames.push(frameAt(tMs, { liftLeft: 0, liftRight: 0 }));
  }
  for (let tMs = restMs; tMs < restMs + holdMs; tMs += stepMs) {
    frames.push(frameAt(tMs, shape));
  }
  for (let tMs = restMs + holdMs; tMs < restMs + holdMs + 2_000; tMs += stepMs) {
    frames.push(frameAt(tMs, { liftLeft: 0, liftRight: 0 }));
  }
  return frames;
}

describe("resting baseline", () => {
  it("recovers rest geometry despite a minority of expression frames", () => {
    const baseline = restingBaseline(session({ liftLeft: 0.2, liftRight: 0.2 }));
    expect(baseline?.leftCorner.y).toBeCloseTo(REST_CORNER_Y, 3);
    expect(baseline?.rightCorner.y).toBeCloseTo(REST_CORNER_Y, 3);
    expect(baseline?.leftEyeAperture).toBeCloseTo(REST_EYE, 3);
  });

  it("returns null when no frame carries usable mouth geometry", () => {
    const frames = [0, 40, 80].map((tMs) => ({
      ...syntheticFacialFrame(tMs, "ambient-frontal", { mouthCorners: null }),
      faceCount: 1
    })) as AmbientFacialFrame[];
    expect(restingBaseline(frames)).toBeNull();
  });
});

describe("event detection", () => {
  it("finds a symmetric expression and locates its peak", () => {
    const frames = session({ liftLeft: 0.12, liftRight: 0.12 });
    const baseline = restingBaseline(frames)!;
    const events = detectExpressionEvents(frames, baseline);
    expect(events).toHaveLength(1);
    expect(events[0].peakElevationLeft).toBeCloseTo(0.12, 2);
    expect(events[0].peakElevationRight).toBeCloseTo(0.12, 2);
    expect(events[0].endMs - events[0].startMs).toBeGreaterThanOrEqual(
      EXPRESSION_MIN_DURATION_MS
    );
  });

  it("ignores excursions too brief to be an expression", () => {
    const frames = session({ liftLeft: 0.12, liftRight: 0.12 }, { holdMs: 120 });
    const baseline = restingBaseline(frames)!;
    expect(detectExpressionEvents(frames, baseline)).toHaveLength(0);
  });

  it("ignores movement that never clears the onset threshold", () => {
    const frames = session({ liftLeft: 0.01, liftRight: 0.01 });
    const baseline = restingBaseline(frames)!;
    expect(detectExpressionEvents(frames, baseline)).toHaveLength(0);
  });

  // The failure this design most needs to avoid: if detection required BOTH
  // sides to move, a severe unilateral palsy would yield fewer and fewer
  // events as it worsened, and the instrument would go blind exactly where it
  // matters. Detection must not degrade with asymmetry.
  it("detects a fully unilateral expression with a flaccid opposite side", () => {
    const frames = session({ liftLeft: 0.14, liftRight: 0 });
    const baseline = restingBaseline(frames)!;
    const events = detectExpressionEvents(frames, baseline);
    expect(events).toHaveLength(1);
    expect(events[0].peakElevationLeft).toBeCloseTo(0.14, 2);
    expect(events[0].peakElevationRight).toBeCloseTo(0, 2);
  });

  it("detects the same number of events regardless of which side is affected", () => {
    const baselineOf = (frames: AmbientFacialFrame[]) =>
      detectExpressionEvents(frames, restingBaseline(frames)!).length;
    expect(baselineOf(session({ liftLeft: 0.14, liftRight: 0 }))).toBe(1);
    expect(baselineOf(session({ liftLeft: 0, liftRight: 0.14 }))).toBe(1);
    expect(baselineOf(session({ liftLeft: 0.14, liftRight: 0.14 }))).toBe(1);
  });
});

describe("excursion asymmetry", () => {
  const event = (left: number, right: number) => ({
    startMs: 0,
    endMs: 1_000,
    peakMs: 500,
    frameCount: 25,
    peakElevationLeft: left,
    peakElevationRight: right,
    riseMs: 500,
    dwellMs: 100,
    decayTauMs: 200,
    lidApertureDeltaLeft: 0,
    lidApertureDeltaRight: 0
  });

  it("is zero for a symmetric expression and signed toward the larger side", () => {
    expect(excursionAsymmetry(event(0.12, 0.12))).toBeCloseTo(0, 6);
    expect(excursionAsymmetry(event(0.12, 0))).toBeCloseTo(1, 6);
    expect(excursionAsymmetry(event(0, 0.12))).toBeCloseTo(-1, 6);
  });

  it("is invariant to how large the expression was", () => {
    const small = excursionAsymmetry(event(0.06, 0.03));
    const large = excursionAsymmetry(event(0.2, 0.1));
    expect(small).toBeCloseTo(large!, 6);
  });

  it("abstains when neither corner moved", () => {
    expect(excursionAsymmetry(event(0, 0))).toBeNull();
  });
});

describe("synkinesis index", () => {
  const event = (over: Partial<Parameters<typeof synkinesisIndex>[0]> = {}) => ({
    startMs: 0,
    endMs: 1_000,
    peakMs: 500,
    frameCount: 25,
    peakElevationLeft: 0.1,
    peakElevationRight: 0.1,
    riseMs: 500,
    dwellMs: 100,
    decayTauMs: 200,
    lidApertureDeltaLeft: -0.01,
    lidApertureDeltaRight: -0.01,
    ...over
  });

  it("is zero when both eyes narrow proportionally to their own mouth movement", () => {
    expect(synkinesisIndex(event())).toBeCloseTo(0, 6);
    // Same coupling ratio, different absolute movement, still symmetric.
    expect(
      synkinesisIndex(
        event({ peakElevationLeft: 0.2, lidApertureDeltaLeft: -0.02 })
      )
    ).toBeCloseTo(0, 6);
  });

  it("is negative when the left eye narrows disproportionately", () => {
    const value = synkinesisIndex(event({ lidApertureDeltaLeft: -0.05 }));
    expect(value).toBeLessThan(0);
  });

  it("abstains rather than dividing by a side that barely moved", () => {
    expect(synkinesisIndex(event({ peakElevationRight: 0.001 }))).toBeNull();
    expect(synkinesisIndex(event({ lidApertureDeltaLeft: Number.NaN }))).toBeNull();
  });
});

describe("session summary", () => {
  it("summarizes a unilateral session with the affected side signed", () => {
    const frames = session({ liftLeft: 0.14, liftRight: 0.02 });
    const summary = summarizeExpressions(frames, 9_000)!;
    expect(summary.eventCount).toBe(1);
    expect(summary.excursionAsymmetryMedian).toBeGreaterThan(0.5);
    expect(summary.excursionP90).toBeCloseTo(0.14, 2);
    expect(summary.eventRatePerMinute).toBeCloseTo(1 / (9_000 / 60_000), 3);
  });

  it("reports a resting asymmetry when one corner sits lower at rest", () => {
    // Subject-left corner droops 0.05 below the right at rest.
    const frames = Array.from({ length: 150 }, (_, index) =>
      frameAt(index * 40, { liftLeft: -0.05, liftRight: 0 })
    );
    const summary = summarizeExpressions(frames, 6_000)!;
    // Left sits LOWER, so the signed rest asymmetry is negative.
    expect(summary.restMouthCornerAsymmetry).toBeCloseTo(-0.05, 3);
  });

  it("withholds event statistics for a session with no expressions", () => {
    const frames = session({ liftLeft: 0, liftRight: 0 });
    const summary = summarizeExpressions(frames, 9_000)!;
    expect(summary.eventCount).toBe(0);
    expect(summary.excursionAsymmetryMedian).toBeNull();
    expect(summary.synkinesisIndexMedian).toBeNull();
    expect(summary.excursionP90).toBeNull();
  });

  it("withholds synkinesis when the affected side never clears the floor", () => {
    const frames = session({ liftLeft: 0.14, liftRight: 0.001 });
    const summary = summarizeExpressions(frames, 9_000)!;
    expect(summary.eventCount).toBe(1);
    // Excursion asymmetry is still measurable; coupling is not.
    expect(summary.excursionAsymmetryMedian).not.toBeNull();
    expect(summary.synkinesisIndexMedian).toBeNull();
    expect(summary.synkinesisEventCount).toBe(0);
  });
});

describe("rejected-bin holes", () => {
  /**
   * Frames either side of a hole, each side individually too brief to be an
   * expression, but jointly inside the 300 ms - 10 s window. Without a gap
   * check the detector stitches them into one event that never happened.
   */
  function acrossHole(holeMs: number): AmbientFacialFrame[] {
    const frames: AmbientFacialFrame[] = [];
    for (let tMs = 0; tMs < 6_000; tMs += 40) {
      frames.push(frameAt(tMs, { liftLeft: 0, liftRight: 0 }));
    }
    // 200 ms raised, then the hole, then 200 ms raised again.
    for (let tMs = 6_000; tMs < 6_200; tMs += 40) {
      frames.push(frameAt(tMs, { liftLeft: 0.12, liftRight: 0.12 }));
    }
    const resume = 6_200 + holeMs;
    for (let tMs = resume; tMs < resume + 200; tMs += 40) {
      frames.push(frameAt(tMs, { liftLeft: 0.12, liftRight: 0.12 }));
    }
    for (let tMs = resume + 200; tMs < resume + 2_200; tMs += 40) {
      frames.push(frameAt(tMs, { liftLeft: 0, liftRight: 0 }));
    }
    return frames;
  }

  it("does not stitch an event across a rejected bin", () => {
    // One rejected 5 s bin. Both raised stretches are 200 ms -- under the
    // 300 ms floor -- so neither is an event on its own, and the span across
    // the hole sits inside the 10 s ceiling that would otherwise catch it.
    const frames = acrossHole(5_000);
    const baseline = restingBaseline(frames)!;
    expect(detectExpressionEvents(frames, baseline)).toHaveLength(0);
  });

  it("still detects a contiguous expression of the same total length", () => {
    // Same geometry, no hole: the two stretches are now one 400 ms movement,
    // which is a real event. Guards against the fix suppressing everything.
    const frames = acrossHole(40);
    const baseline = restingBaseline(frames)!;
    expect(detectExpressionEvents(frames, baseline)).toHaveLength(1);
  });
});

describe("expression kinematics", () => {
  /** Rise, hold, then exponential relaxation back to rest. */
  function shapedExpression(
    { riseMs = 400, holdMs = 600, tauMs = 300 } = {}
  ): AmbientFacialFrame[] {
    const frames: AmbientFacialFrame[] = [];
    const peak = 0.12;
    const step = 40;
    for (let tMs = 0; tMs < 6_000; tMs += step) {
      frames.push(frameAt(tMs, { liftLeft: 0, liftRight: 0 }));
    }
    for (let tMs = 0; tMs < riseMs; tMs += step) {
      const lift = peak * (tMs / riseMs);
      frames.push(frameAt(6_000 + tMs, { liftLeft: lift, liftRight: lift }));
    }
    for (let tMs = 0; tMs < holdMs; tMs += step) {
      frames.push(
        frameAt(6_000 + riseMs + tMs, { liftLeft: peak, liftRight: peak })
      );
    }
    for (let tMs = 0; tMs < 2_000; tMs += step) {
      const lift = peak * Math.exp(-tMs / tauMs);
      frames.push(
        frameAt(6_000 + riseMs + holdMs + tMs, {
          liftLeft: lift,
          liftRight: lift
        })
      );
    }
    return frames;
  }

  it("separates rise from dwell", () => {
    // riseMs is onset-to-peak where onset is the threshold crossing, not the
    // true start of movement, so it UNDERSTATES the real rise. A 400 ms ramp to
    // a peak of 0.12 crosses the 0.04 onset threshold a third of the way up,
    // leaving about 267 ms visible. That is a property of detecting movement by
    // threshold, and it is why this is a relative measure between events rather
    // than an absolute duration.
    const frames = shapedExpression({ riseMs: 400, holdMs: 600 });
    const baseline = restingBaseline(frames)!;
    const [event] = detectExpressionEvents(frames, baseline);
    expect(event).toBeDefined();
    expect(event.riseMs).toBeGreaterThan(200);
    expect(event.riseMs).toBeLessThan(400);
    expect(event.dwellMs).toBeGreaterThan(400);
    // The distinction the measure has to support: a hold is not a rise.
    expect(event.dwellMs).toBeGreaterThan(event.riseMs);
  });

  it("orders decay constants by how fast the movement relaxes", () => {
    const eventFor = (tau: number) => {
      const frames = shapedExpression({ tauMs: tau });
      return detectExpressionEvents(frames, restingBaseline(frames)!)[0];
    };
    // Only the ORDERING is asserted. The fitted value runs high -- the resting
    // baseline is estimated from frames that include the expression, so the
    // decay asymptotes slightly above true rest and biases the log fit. A
    // sustained relaxation still has to come out slower than a brisk one, which
    // is the clinical distinction; the absolute constant is not calibrated and
    // is not claimed to be.
    expect(eventFor(300).decayTauMs).toBeGreaterThan(0);
    expect(eventFor(900).decayTauMs!).toBeGreaterThan(
      eventFor(300).decayTauMs!
    );
  });

  it("abstains on decay when the movement is cut off by the window", () => {
    // A tail that never relaxes cannot yield a time constant. Fitting one to a
    // truncated decay would produce a number with no relaxation behind it.
    const frames: AmbientFacialFrame[] = [];
    for (let tMs = 0; tMs < 6_000; tMs += 40) {
      frames.push(frameAt(tMs, { liftLeft: 0, liftRight: 0 }));
    }
    for (let tMs = 6_000; tMs < 7_000; tMs += 40) {
      frames.push(frameAt(tMs, { liftLeft: 0.12, liftRight: 0.12 }));
    }
    const baseline = restingBaseline(frames)!;
    const [event] = detectExpressionEvents(frames, baseline);
    expect(event).toBeDefined();
    expect(event.decayTauMs).toBeNull();
  });
});
