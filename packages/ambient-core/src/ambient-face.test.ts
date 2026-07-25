import { describe, expect, it } from "vitest";
import { syntheticFacialFrame } from "./test-helpers.js";
import { extractAmbientFaceMetrics } from "./ambient-face.js";
import type {
  AmbientFaceExtractionOptions,
  AmbientFacialFrame
} from "./ambient-types.js";

const OPTIONS: AmbientFaceExtractionOptions = {
  sessionId: "ambient-session-face",
  protocolVersion: "1.0.0",
  protocolContentSha256: "face-protocol-digest",
  sessionStartedAtMs: 0,
  calibration: {
    durationMs: 1_500,
    baselineBoxWidthPixels: 384,
    baselineBoxHeightPixels: 360
  }
};

function ambientFaceFrames(
  durationMs = 60_000,
  cadenceHz = 30,
  override: (
    frame: AmbientFacialFrame,
    index: number
  ) => Partial<AmbientFacialFrame> = () => ({})
): AmbientFacialFrame[] {
  const stepMs = 1_000 / cadenceHz;
  return Array.from(
    { length: Math.round(durationMs / stepMs) },
    (_, index) => {
      const tMs = index * stepMs;
      const blinkPhase = tMs % 10_000;
      const closed = blinkPhase >= 1_000 && blinkPhase < 1_100;
      const frame: AmbientFacialFrame = {
        ...syntheticFacialFrame(tMs, "ambient-frontal", {
          sequence: index + 1,
          eyeAperture: closed
            ? { left: 0.1, right: 0.1 }
            : { left: 0.3, right: 0.3 },
          mouthApertureRatio: 0.08 + 0.01 * Math.sin(tMs / 1_000),
          regionalMovementSpeed: 0.02,
          analyzedFrameRate: cadenceHz,
          interResultGapMs: index === 0 ? null : stepMs
        }),
        faceCount: 1,
        trackSegmentId: "visible-face-1"
      };
      return { ...frame, ...override(frame, index) };
    }
  );
}

function byCode(
  frames: readonly AmbientFacialFrame[],
  code: string,
  options = OPTIONS
) {
  return extractAmbientFaceMetrics(frames, options).outcomes.find(
    (outcome) => outcome.code === code
  );
}

describe("extractAmbientFaceMetrics", () => {
  it("emits the bounded twenty-metric catalog in stable order", () => {
    const result = extractAmbientFaceMetrics(ambientFaceFrames(), OPTIONS);

    expect(result.outcomes.map((outcome) => outcome.code)).toEqual([
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
    ]);
    // This fixture holds a static face, so the per-event statistics have
    // nothing to summarize and must abstain rather than report a zero.
    const eventStatistics = new Set([
      "ambient.face.spontaneous_excursion.p90",
      "ambient.face.spontaneous_excursion_asymmetry.median",
      "ambient.face.oculo_oral_synkinesis_index"
    ]);
    for (const outcome of result.outcomes) {
      if (eventStatistics.has(outcome.code)) {
        expect(outcome.status).toBe("withheld");
        if (outcome.status === "withheld") {
          expect(outcome.reasonCode).toBe("insufficient-events");
        }
      } else {
        expect(outcome.status).toBe("measured");
      }
    }
    // A rate of zero IS a measurement: the session was observed and contained
    // no spontaneous expressions.
    const rate = result.outcomes.find(
      (outcome) => outcome.code === "ambient.face.spontaneous_event_rate"
    );
    expect(rate?.status).toBe("measured");
    if (rate?.status === "measured") expect(rate.value).toBe(0);
    expect(result.outcomes[0].identity.context).toBe("ambient-frontal");
  });

  it("uses exact five-second bins and reports geometry after a 30-second span", () => {
    const result = extractAmbientFaceMetrics(
      ambientFaceFrames(30_000),
      OPTIONS
    );
    const geometry = result.outcomes.slice(0, 8);
    const blink = result.outcomes[8];

    expect(geometry.every((outcome) => outcome.status === "measured")).toBe(
      true
    );
    expect(geometry[0]).toMatchObject({
      evidence: {
        qualifyingBinCount: 6,
        processorRefs: [
          "mediapipe-face-landmarker@0.10.35+synthetic-model"
        ],
        trackSegmentIds: ["visible-face-1"]
      }
    });
    expect(blink).toMatchObject({
      status: "withheld",
      reasonCode: "insufficient-exposure"
    });
  });

  it("detects validation-gated bilateral blinks", () => {
    const blink = byCode(
      ambientFaceFrames(),
      "ambient.face.blink_rate.bilateral"
    );

    expect(blink).toMatchObject({
      status: "measured",
      evidence: { frontalExposureMs: 60_000, blinkCount: 6 }
    });
    if (blink?.status === "measured") expect(blink.value).toBeCloseTo(6, 4);
  });

  it("allows a valid zero blink rate only after 60 seconds of eligible exposure", () => {
    const frames = ambientFaceFrames(60_000, 30, () => ({
      eyeAperture: { left: 0.3, right: 0.3 }
    }));
    const blink = byCode(
      frames,
      "ambient.face.blink_rate.bilateral"
    );

    expect(blink).toMatchObject({
      status: "measured",
      value: 0,
      evidence: { frontalExposureMs: 60_000, blinkCount: 0 }
    });
  });

  it("does not relabel a prolonged eye closure as a blink", () => {
    const frames = ambientFaceFrames(60_000, 30, (frame) => ({
      eyeAperture:
        frame.tMs >= 1_000 && frame.tMs < 3_000
          ? { left: 0.1, right: 0.1 }
          : { left: 0.3, right: 0.3 }
    }));
    const blink = byCode(
      frames,
      "ambient.face.blink_rate.bilateral"
    );

    expect(blink).toMatchObject({
      status: "measured",
      value: 0,
      evidence: { blinkCount: 0 }
    });
  });

  it("withholds all face metrics when face count is multiple or unknown", () => {
    const frames = ambientFaceFrames(60_000, 30, () => ({ faceCount: 2 }));
    const result = extractAmbientFaceMetrics(frames, OPTIONS);

    expect(
      result.outcomes.every(
        (outcome) =>
          outcome.status === "withheld" &&
          outcome.reasonCode === "multiple-faces"
      )
    ).toBe(true);
  });

  it("accepts pose and calibrated-size boundaries inclusively", () => {
    const frames = ambientFaceFrames(30_000, 30, (frame) => ({
      pose: { yawDegrees: 7, pitchDegrees: -10, rollDegrees: 5 },
      boundingBox: {
        ...frame.boundingBox!,
        widthPixels: 384 * 1.2,
        heightPixels: 360 * 0.8
      }
    }));
    const result = extractAmbientFaceMetrics(frames, OPTIONS);

    expect(result.outcomes.slice(0, 8).every((outcome) => outcome.status === "measured"))
      .toBe(true);
  });

  it("rejects bins beyond strict ambient pose, gap, and sample thresholds", () => {
    const pose = extractAmbientFaceMetrics(
      ambientFaceFrames(30_000, 30, () => ({
        pose: { yawDegrees: 7.001, pitchDegrees: 0, rollDegrees: 0 }
      })),
      OPTIONS
    );
    const gaps = extractAmbientFaceMetrics(
      ambientFaceFrames(30_000, 30, () => ({
        interResultGapMs: 200.001
      })),
      OPTIONS
    );
    const sparse = extractAmbientFaceMetrics(
      ambientFaceFrames(30_000, 15),
      OPTIONS
    );

    for (const result of [pose, gaps, sparse]) {
      expect(result.outcomes[0]).toMatchObject({
        status: "withheld",
        reasonCode: "no-usable-signal"
      });
    }
  });

  it("resets movement at every bin boundary", () => {
    const frames = ambientFaceFrames(30_000, 30, (frame) => ({
      regionalMovementSpeed:
        Math.abs(frame.tMs % 5_000) < 0.001 ? 100 : 0.02
    }));
    const movement = byCode(
      frames,
      "ambient.face.landmark_speed.p90"
    );

    expect(movement).toMatchObject({ status: "measured" });
    if (movement?.status === "measured") {
      expect(movement.value).toBeCloseTo(0.02, 6);
    }
  });

  it("withholds movement rather than emitting a nonphysical negative speed", () => {
    const movement = byCode(
      ambientFaceFrames(30_000, 30, () => ({
        regionalMovementSpeed: -0.01
      })),
      "ambient.face.landmark_speed.p90"
    );

    expect(movement).toMatchObject({
      status: "withheld",
      reasonCode: "insufficient-bins"
    });
  });

  it("withholds blink rate independently below 24 Hz", () => {
    const result = extractAmbientFaceMetrics(
      ambientFaceFrames(60_000, 20),
      OPTIONS
    );

    expect(result.outcomes.slice(0, 8).every((outcome) => outcome.status === "measured"))
      .toBe(true);
    expect(result.outcomes[8]).toMatchObject({
      status: "withheld",
      reasonCode: "insufficient-frame-cadence"
    });
  });

  it("requires a technical calibration and never treats it as an expression baseline", () => {
    const result = extractAmbientFaceMetrics(ambientFaceFrames(), {
      ...OPTIONS,
      calibration: { ...OPTIONS.calibration!, durationMs: 1_499 }
    });

    expect(
      result.outcomes.every(
        (outcome) =>
          outcome.status === "withheld" &&
          outcome.reasonCode === "quality-threshold-failed"
      )
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/neutral|smile|emotion/i);
  });

  it("fails closed when qualifying bins cross a face track", () => {
    const frames = ambientFaceFrames(30_000, 30, (frame) => ({
      trackSegmentId: frame.tMs < 15_000 ? "face-a" : "face-b"
    }));
    const result = extractAmbientFaceMetrics(frames, OPTIONS);

    expect(result.outcomes[0]).toMatchObject({
      status: "withheld",
      reasonCode: "quality-threshold-failed"
    });
  });

  it("produces deterministic outcome identities", () => {
    const first = extractAmbientFaceMetrics(ambientFaceFrames(), OPTIONS);
    const second = extractAmbientFaceMetrics(ambientFaceFrames(), OPTIONS);

    expect(first.outcomes.map((outcome) => outcome.identity.outcomeId)).toEqual(
      second.outcomes.map((outcome) => outcome.identity.outcomeId)
    );
    expect(new Set(first.outcomes.map((outcome) => outcome.identity.outcomeId)).size)
      .toBe(20);
  });

  it("grades lid closure per eye against that eye's own open reference", () => {
    // The fixture blinks to 0.1 from an open reference of 0.3.
    const left = byCode(
      ambientFaceFrames(),
      "ambient.face.lid_closure_completeness.left"
    );
    expect(left?.status).toBe("measured");
    if (left?.status === "measured") {
      expect(left.value).toBeCloseTo(1 - 0.1 / 0.3, 2);
    }
  });

  it("reports incomplete closure on one side without disturbing the other", () => {
    // Unilateral lagophthalmos: the subject-left lid only reaches 0.24 of its
    // 0.3 open reference, while the right still closes fully to 0.1.
    const frames = ambientFaceFrames(60_000, 30, (frame) => {
      const aperture = frame.eyeAperture!;
      return aperture.left < 0.2
        ? { eyeAperture: { left: 0.24, right: aperture.right } }
        : {};
    });
    const left = byCode(frames, "ambient.face.lid_closure_completeness.left");
    const right = byCode(frames, "ambient.face.lid_closure_completeness.right");
    expect(left?.status).toBe("measured");
    expect(right?.status).toBe("measured");
    if (left?.status === "measured" && right?.status === "measured") {
      expect(left.value).toBeCloseTo(1 - 0.24 / 0.3, 2);
      expect(right.value).toBeCloseTo(1 - 0.1 / 0.3, 2);
      // The affected side closes materially less than the intact side.
      expect(left.value).toBeLessThan(right.value);
    }
  });

  it("signs brow asymmetry toward the side whose brow sits lower", () => {
    const frames = ambientFaceFrames(60_000, 30, (frame) => ({
      browHeight: { left: frame.browHeight!.left - 0.06, right: frame.browHeight!.right }
    }));
    const asymmetry = byCode(
      frames,
      "ambient.face.brow_height_asymmetry.signed"
    );
    expect(asymmetry?.status).toBe("measured");
    if (asymmetry?.status === "measured") {
      // Subject-left brow is lower, so left minus right is negative.
      expect(asymmetry.value).toBeCloseTo(-0.06, 3);
    }
  });
});

describe("blink events", () => {
  /** Blinks only the named side; the other lid stays open throughout. */
  function unilateralBlinkFrames(side: "left" | "right"): AmbientFacialFrame[] {
    return ambientFaceFrames(60_000, 30, (frame) => {
      const closed =
        frame.tMs % 10_000 >= 1_000 && frame.tMs % 10_000 < 1_100;
      return {
        eyeAperture: {
          left: side === "left" && closed ? 0.1 : 0.3,
          right: side === "right" && closed ? 0.1 : 0.3
        }
      };
    });
  }

  it("records a blink per eye with its kinematics", () => {
    const result = extractAmbientFaceMetrics(
      ambientFaceFrames(),
      OPTIONS
    );
    const blinks = result.events?.blinks ?? [];
    expect(blinks.length).toBeGreaterThan(0);
    for (const blink of blinks) {
      expect(["left", "right"]).toContain(blink.side);
      expect(blink.openReference).toBeCloseTo(0.3, 6);
      expect(blink.lidApertureMinimum).toBeCloseTo(0.1, 6);
      // Travel is 0.2 of a 0.3 reference.
      expect(blink.depth).toBeCloseTo(2 / 3, 3);
      expect(blink.closingVelocity).toBeGreaterThan(0);
      expect(blink.openingVelocity).toBeGreaterThan(0);
      expect(blink.onsetMs).toBeLessThanOrEqual(blink.peakMs);
      expect(blink.peakMs).toBeLessThanOrEqual(blink.offsetMs);
    }
    // Both eyes closed together, so each conjugate blink yields two records.
    expect(blinks.filter((b) => b.side === "left").length).toBe(
      blinks.filter((b) => b.side === "right").length
    );
  });

  it.each(["left", "right"] as const)(
    "sees a %s-only closure the bilateral rule could not",
    (side) => {
      // The former detector required BOTH eyes below threshold on one frame, so
      // a unilateral closure produced nothing at all -- the case a facial palsy
      // actually presents, and the one the instrument most needs to see.
      const result = extractAmbientFaceMetrics(
        unilateralBlinkFrames(side),
        OPTIONS
      );
      const blinks = result.events?.blinks ?? [];
      expect(blinks.length).toBeGreaterThan(0);
      expect(blinks.every((blink) => blink.side === side)).toBe(true);
    }
  );

  it("keeps the published bilateral rate counting only conjugate blinks", () => {
    // The rate metric is explicitly bilateral. A unilateral closure must become
    // an event without inflating it, or the per-eye rewrite would silently
    // change what an existing published number means.
    const unilateral = extractAmbientFaceMetrics(
      unilateralBlinkFrames("left"),
      OPTIONS
    );
    const rate = unilateral.outcomes.find(
      (outcome) => outcome.code === "ambient.face.blink_rate.bilateral"
    );
    expect(rate?.evidence.blinkCount).toBe(0);

    const bilateral = extractAmbientFaceMetrics(
      ambientFaceFrames(),
      OPTIONS
    );
    const bilateralRate = bilateral.outcomes.find(
      (outcome) => outcome.code === "ambient.face.blink_rate.bilateral"
    );
    expect(bilateralRate?.evidence.blinkCount).toBe(6);
  });

  it("reports a shallower depth for an incomplete closure", () => {
    // Lagophthalmos is incomplete lid closure. Depth is the parameter that
    // carries it; a count cannot.
    const incomplete = ambientFaceFrames(60_000, 30, (frame) => {
      const closed =
        frame.tMs % 10_000 >= 1_000 && frame.tMs % 10_000 < 1_100;
      return {
        eyeAperture: {
          left: closed ? 0.17 : 0.3,
          right: closed ? 0.1 : 0.3
        }
      };
    });
    const result = extractAmbientFaceMetrics(incomplete, OPTIONS);
    const blinks = result.events?.blinks ?? [];
    const left = blinks.filter((blink) => blink.side === "left");
    const right = blinks.filter((blink) => blink.side === "right");
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    expect(left[0].depth).toBeLessThan(right[0].depth);
  });
});

describe("tier-2 events survive a withheld metric", () => {
  it("extracts blinks from a session too short for the blink metric", () => {
    // Regression from a real 54-second session: the blink metric requires 60 s
    // of frontal exposure, and detection sat inside the branch that only ran
    // when that gate passed. Every blink actually observed was discarded
    // because a PUBLICATION threshold suppressed the EXTRACTION beneath it.
    // Tier 2 exists so an abstaining metric still leaves its observations.
    const frames = ambientFaceFrames(40_000);
    const result = extractAmbientFaceMetrics(frames, OPTIONS);

    const rate = result.outcomes.find(
      (outcome) => outcome.code === "ambient.face.blink_rate.bilateral"
    );
    expect(rate?.status).toBe("withheld");
    if (rate?.status === "withheld") {
      expect(rate.reasonCode).toBe("insufficient-exposure");
    }

    // The metric abstains; the events do not vanish with it.
    expect((result.events?.blinks ?? []).length).toBeGreaterThan(0);
  });

  it("reports no blinks rather than throwing when nothing qualified", () => {
    // No bins at all is a different statement from no blinks, and it must not
    // reach the detector's percentile of an empty set.
    const result = extractAmbientFaceMetrics([], OPTIONS);
    expect(result.events?.blinks).toEqual([]);
  });
});
