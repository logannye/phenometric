import { describe, expect, it } from "vitest";
import type { FaceCalibration } from "@phenometrix/contracts";
import { syntheticFacialFrame } from "./test-helpers.js";
import { evaluateVisualQuality } from "./visual-quality.js";

describe("evaluateVisualQuality", () => {
  it("accepts every engineering boundary inclusively", () => {
    const frame = syntheticFacialFrame(0, "neutral-face", {
      boundingBox: {
        x: 0.02,
        y: 0.02,
        width: 0.7,
        height: 0.9,
        widthPixels: 180,
        heightPixels: 220,
        edgeMarginFraction: 0.02
      },
      pose: { yawDegrees: 15, pitchDegrees: -15, rollDegrees: 10 },
      analyzedFrameRate: 20,
      interResultGapMs: 200,
      skippedFrameFraction: 0.25,
      imageQuality: {
        illuminationMean: 0.12,
        darkClippingFraction: 0.2,
        brightClippingFraction: 0.2,
        sharpness: 0.0008
      }
    });

    expect(evaluateVisualQuality(frame)).toEqual({
      usable: true,
      reasonCodes: [],
      sharpnessFloor: 0.0008
    });
  });

  it.each([
    ["face-too-small", { boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.5, widthPixels: 179, heightPixels: 220, edgeMarginFraction: 0.1 } }],
    ["face-too-large", { boundingBox: { x: 0.1, y: 0.1, width: 0.701, height: 0.5, widthPixels: 384, heightPixels: 360, edgeMarginFraction: 0.1 } }],
    ["face-edge-margin", { boundingBox: { x: 0.01, y: 0.1, width: 0.3, height: 0.5, widthPixels: 384, heightPixels: 360, edgeMarginFraction: 0.019 } }],
    ["pose-out-of-range", { pose: { yawDegrees: 15.1, pitchDegrees: 0, rollDegrees: 0 } }],
    ["illumination-out-of-range", { imageQuality: { illuminationMean: 0.119, darkClippingFraction: 0, brightClippingFraction: 0, sharpness: 0.002 } }],
    ["blur", { imageQuality: { illuminationMean: 0.5, darkClippingFraction: 0, brightClippingFraction: 0, sharpness: 0.00079 } }],
    ["frame-rate-below-minimum", { analyzedFrameRate: 19.99 }],
    ["visual-frame-gap", { interResultGapMs: 200.01 }],
    ["too-many-skipped-frames", { skippedFrameFraction: 0.251 }]
  ] as const)(
    "returns %s at the failing side of its boundary",
    (reasonCode, override) => {
      const result = evaluateVisualQuality(
        syntheticFacialFrame(0, "neutral-face", override)
      );
      expect(result.reasonCodes).toContain(reasonCode);
      expect(result.usable).toBe(false);
    }
  );

  it("requires a visible face and complete derived geometry", () => {
    const result = evaluateVisualQuality(
      syntheticFacialFrame(0, "neutral-face", {
        faceVisible: false,
        boundingBox: null,
        pose: null,
        eyeAperture: null,
        mouthCorners: null
      })
    );
    expect(result.reasonCodes).toContain("face-not-visible");
  });

  it("raises the sharpness floor to half of calibration baseline", () => {
    const calibration: FaceCalibration = {
      durationMs: 1_600,
      totalFrameCount: 49,
      usableFrameCount: 48,
      usableFraction: 48 / 49,
      analyzedFrameRate: 30,
      baselineBoxWidthPixels: 384,
      baselineBoxHeightPixels: 360,
      baselineIlluminationMean: 0.55,
      baselineSharpness: 0.004
    };
    const result = evaluateVisualQuality(
      syntheticFacialFrame(0, "neutral-face", {
        imageQuality: {
          illuminationMean: 0.55,
          darkClippingFraction: 0,
          brightClippingFraction: 0,
          sharpness: 0.0019
        }
      }),
      calibration
    );
    expect(result.sharpnessFloor).toBe(0.002);
    expect(result.reasonCodes).toContain("blur");
  });

  it("preserves infrastructure withholding reasons without event semantics", () => {
    const result = evaluateVisualQuality(
      syntheticFacialFrame(0, "neutral-face", {
        qualityReasons: ["document-hidden", "worker-unavailable"]
      })
    );
    expect(result.reasonCodes.slice(0, 2)).toEqual([
      "document-hidden",
      "worker-unavailable"
    ]);
  });
});
