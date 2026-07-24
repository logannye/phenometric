import type { FacialKinematicsFrameV1 } from "@phenometrix/ambient-core";
import { describe, expect, it } from "vitest";
import {
  calibrateFaceFrame,
  classifyAudioCalibration,
  classifyFaceCalibration,
  createCaptureCalibration,
  createFaceCalibration,
  facePreflightPassed,
  preflightFaceGuidance
} from "./capture-calibration.js";

function face(
  overrides: Partial<FacialKinematicsFrameV1> = {}
): FacialKinematicsFrameV1 {
  return {
    schemaVersion: "phenometric.facial-kinematics-frame.v1",
    tMs: 0,
    acquiredAtMs: 0,
    sequence: 1,
    captureEpoch: 1,
    taskContext: "establishing",
    faceVisible: true,
    boundingBox: {
      x: 0.3,
      y: 0.2,
      width: 0.4,
      height: 0.6,
      widthPixels: 512,
      heightPixels: 432,
      edgeMarginFraction: 0.2
    },
    anatomicalLaterality: "subject-anatomical",
    pose: {
      yawDegrees: 4,
      pitchDegrees: 2,
      rollDegrees: 1
    },
    eyeAperture: { left: 0.28, right: 0.27 },
    browHeight: { left: 0.55, right: 0.55 },
    mouthCorners: {
      left: { x: 0.4, y: 0.8 },
      right: { x: -0.4, y: 0.8 }
    },
    mouthApertureRatio: 0.12,
    regionalMovementSpeed: 0.03,
    imageQuality: {
      illuminationMean: 0.58,
      darkClippingFraction: 0.01,
      brightClippingFraction: 0.01,
      sharpness: 0.01
    },
    analyzedFrameRate: 30,
    interResultGapMs: 33.333,
    skippedFrameFraction: 0,
    processingLatencyMs: 8,
    qualityReasons: [],
    processorRef: "visual:test",
    ...overrides
  };
}

function stableFrames(
  count = 46,
  intervalMs = 1_500 / 45
): FacialKinematicsFrameV1[] {
  return Array.from({ length: count }, (_, index) =>
    face({
      tMs: index * intervalMs,
      acquiredAtMs: 1_000 + index * intervalMs,
      sequence: index + 1
    })
  );
}

describe("guided face calibration", () => {
  it("classifies eight reliable pitch frames as strong", () => {
    expect(classifyAudioCalibration(8, 8)).toBe("strong");
    expect(classifyAudioCalibration(7, 9)).toBe("limited");
    expect(classifyAudioCalibration(0, 0)).toBe("unavailable");
  });

  it("requires 1.5 seconds, 80% usable coverage, and 20 Hz cadence", () => {
    const stable = stableFrames();
    expect(facePreflightPassed(stable)).toBe(true);
    expect(createFaceCalibration(stable)).toMatchObject({
      durationMs: 1_500,
      totalFrameCount: 46,
      usableFrameCount: 46,
      usableFraction: 1,
      analyzedFrameRate: 30,
      baselineBoxWidthPixels: 512,
      baselineBoxHeightPixels: 432,
      baselineIlluminationMean: 0.58,
      baselineSharpness: 0.01
    });

    expect(
      classifyFaceCalibration(stableFrames(30, 1_000 / 30)).quality
    ).toBe("limited");
    expect(classifyFaceCalibration(stableFrames(46, 1_000 / 30))).toMatchObject({
      quality: "strong",
      calibration: { analyzedFrameRate: 30 }
    });
    expect(classifyFaceCalibration(stableFrames(31, 1_000 / 20))).toMatchObject({
      quality: "strong",
      calibration: { analyzedFrameRate: 20 }
    });
    expect(classifyFaceCalibration(stableFrames(16, 1_000 / 10))).toMatchObject({
      quality: "limited",
      calibration: { analyzedFrameRate: 10 }
    });
  });

  it("counts individual failed observations instead of overwriting them", () => {
    const frames = stableFrames();
    for (let index = 0; index < 9; index += 1) {
      frames[index] = face({
        ...frames[index],
        pose: { yawDegrees: 20, pitchDegrees: 0, rollDegrees: 0 }
      });
    }
    const passing = classifyFaceCalibration(frames);
    expect(passing.quality).toBe("strong");
    expect(passing.calibration?.usableFraction).toBeCloseTo(37 / 46);

    frames[9] = face({
      ...frames[9],
      imageQuality: {
        ...frames[9].imageQuality,
        sharpness: 0
      }
    });
    expect(classifyFaceCalibration(frames).quality).toBe("limited");
  });

  it("requires a fresh continuous baseline after a capture-epoch boundary", () => {
    const priorEpoch = stableFrames().map((frame) => ({
      ...frame,
      captureEpoch: 1
    }));
    const currentEpoch = stableFrames(10).map((frame) => ({
      ...frame,
      captureEpoch: 2
    }));

    const result = classifyFaceCalibration([
      ...priorEpoch,
      ...currentEpoch
    ]);
    expect(result.quality).toBe("limited");
    expect(result.calibration).toMatchObject({
      totalFrameCount: 10,
      usableFrameCount: 10
    });
  });

  it("returns specific correction guidance from canonical reason codes", () => {
    expect(preflightFaceGuidance(face({ faceVisible: false }))).toBe(
      "Move into view"
    );
    expect(
      preflightFaceGuidance(
        face({
          boundingBox: {
            ...face().boundingBox!,
            widthPixels: 150
          }
        })
      )
    ).toBe("Move closer");
    expect(
      preflightFaceGuidance(
        face({
          boundingBox: {
            ...face().boundingBox!,
            edgeMarginFraction: 0.005
          }
        })
      )
    ).toBe("Center your face");
    expect(
      preflightFaceGuidance(
        face({
          pose: { yawDegrees: 16, pitchDegrees: 0, rollDegrees: 0 }
        })
      )
    ).toBe("Face the camera");
    expect(
      preflightFaceGuidance(
        face({
          imageQuality: {
            ...face().imageQuality,
            illuminationMean: 0.05
          }
        })
      )
    ).toBe("Please turn on a light");
  });

  it("applies the calibration-relative sharpness floor and accepts recovery", () => {
    const calibration = createFaceCalibration(stableFrames());
    const blurred = calibrateFaceFrame(
      face({
        imageQuality: { ...face().imageQuality, sharpness: 0.004 }
      }),
      calibration
    );
    expect(blurred.usable).toBe(false);
    expect(blurred.assessment.sharpnessFloor).toBe(0.005);
    expect(blurred.frame.qualityReasons).toContain("blur");

    const recovered = calibrateFaceFrame(face(), calibration);
    expect(recovered.usable).toBe(true);
    expect(recovered.frame.qualityReasons).toEqual([]);
  });

  it("classifies missing facial checks as unavailable without blocking audio", () => {
    expect(classifyFaceCalibration([])).toEqual({
      quality: "unavailable",
      calibration: null,
      usableFrameCount: 0
    });
    const capture = createCaptureCalibration(
      {
        medianNoiseRms: 0.002,
        noiseP90Rms: 0.003,
        entryThresholdRms: 0.01,
        exitThresholdRms: 0.008
      },
      "strong",
      classifyFaceCalibration([])
    );
    expect(capture).toMatchObject({
      schemaVersion: "phenometric.capture-calibration.v2",
      profileId: "visual-foundation-v1",
      audioQuality: "strong",
      faceQuality: "unavailable",
      face: null
    });
  });
});
