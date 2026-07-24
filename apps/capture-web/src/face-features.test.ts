import type {
  FaceLandmarkerResult,
  Matrix,
  NormalizedLandmark
} from "@mediapipe/tasks-vision";
import type { FacialKinematicsFrameV1 } from "@phenometric/ambient-core";
import { describe, expect, it } from "vitest";
import {
  coordinateSystem,
  deriveFaceFeature,
  FACE_LANDMARK_INDICES,
  irisGeometry,
  mouthMidlineOffset,
  palpebralFissure,
  poseFromTransformationMatrix,
  type FaceFeatureInput
} from "./face-features.js";

const WIDTH = 1280;
const HEIGHT = 720;

function point(x: number, y: number): NormalizedLandmark {
  return { x, y, z: 0, visibility: 1 };
}

function neutralLandmarks(): NormalizedLandmark[] {
  const values = Array.from({ length: 478 }, () => point(0.5, 0.5));
  values[10] = point(0.5, 0.2);
  values[152] = point(0.5, 0.8);
  values[234] = point(0.3, 0.5);
  values[454] = point(0.7, 0.5);

  values[33] = point(0.38, 0.4);
  values[133] = point(0.46, 0.4);
  values[160] = point(0.4, 0.39);
  values[144] = point(0.4, 0.41);
  values[158] = point(0.44, 0.39);
  values[153] = point(0.44, 0.41);

  values[362] = point(0.54, 0.4);
  values[263] = point(0.62, 0.4);
  values[385] = point(0.56, 0.385);
  values[380] = point(0.56, 0.415);
  values[387] = point(0.6, 0.385);
  values[373] = point(0.6, 0.415);

  values[61] = point(0.43, 0.65);
  values[291] = point(0.57, 0.65);
  values[13] = point(0.5, 0.64);
  values[14] = point(0.5, 0.66);
  // Brow arcs. Subject-right (33/133 side) and subject-left (362/263 side),
  // mirrored index pairs 70<->300, 63<->293, 105<->334.
  values[70] = point(0.42, 0.31);
  values[63] = point(0.40, 0.315);
  values[105] = point(0.44, 0.305);
  values[300] = point(0.58, 0.31);
  values[293] = point(0.60, 0.315);
  values[334] = point(0.56, 0.305);
  return values;
}

function columnMajorMatrix(
  pitchDegrees = 0,
  yawDegrees = 0,
  rollDegrees = 0
): Matrix {
  const pitch = (pitchDegrees * Math.PI) / 180;
  const yaw = (yawDegrees * Math.PI) / 180;
  const roll = (rollDegrees * Math.PI) / 180;
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cz = Math.cos(roll);
  const sz = Math.sin(roll);
  const rotation = [
    [
      cz * cy,
      cz * sy * sx - sz * cx,
      cz * sy * cx + sz * sx
    ],
    [
      sz * cy,
      sz * sy * sx + cz * cx,
      sz * sy * cx - cz * sx
    ],
    [-sy, cy * sx, cy * cx]
  ];
  const rowMajor = [
    [...rotation[0], 0],
    [...rotation[1], 0],
    [...rotation[2], 0],
    [0, 0, 0, 1]
  ];
  const data: number[] = [];
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      data.push(rowMajor[row][column]);
    }
  }
  return { rows: 4, columns: 4, data };
}

function nativeResult(
  landmarks: NormalizedLandmark[] | null,
  matrix: Matrix = columnMajorMatrix()
): FaceLandmarkerResult {
  return {
    faceLandmarks: landmarks ? [landmarks] : [],
    faceBlendshapes: [],
    facialTransformationMatrixes: landmarks ? [matrix] : []
  };
}

function input(
  overrides: Partial<FaceFeatureInput> = {}
): FaceFeatureInput {
  return {
    tMs: 0,
    acquiredAtMs: 1_000,
    sequence: 1,
    captureEpoch: 2,
    taskContext: "neutral-face",
    frameWidth: WIDTH,
    frameHeight: HEIGHT,
    imageQuality: {
      illuminationMean: 0.55,
      darkClippingFraction: 0,
      brightClippingFraction: 0,
      sharpness: 0.01
    },
    analyzedFrameRate: 30,
    interResultGapMs: 33,
    skippedFrameFraction: 0,
    processingLatencyMs: 8,
    processorRef: "mediapipe-face-landmarker@0.10.35:test",
    ...overrides
  };
}

function transformLandmarks(
  landmarks: NormalizedLandmark[],
  options: {
    translateX?: number;
    translateY?: number;
    scale?: number;
    rotateDegrees?: number;
  }
): NormalizedLandmark[] {
  const centerX = WIDTH * 0.5;
  const centerY = HEIGHT * 0.5;
  const angle = ((options.rotateDegrees ?? 0) * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const scale = options.scale ?? 1;
  return landmarks.map((landmark) => {
    const x = (landmark.x * WIDTH - centerX) * scale;
    const y = (landmark.y * HEIGHT - centerY) * scale;
    return point(
      (centerX +
        cosine * x -
        sine * y +
        (options.translateX ?? 0)) /
        WIDTH,
      (centerY +
        sine * x +
        cosine * y +
        (options.translateY ?? 0)) /
        HEIGHT
    );
  });
}

function frameFor(
  landmarks: NormalizedLandmark[],
  overrides: Partial<FaceFeatureInput> = {}
): FacialKinematicsFrameV1 {
  return deriveFaceFeature(nativeResult(landmarks), input(overrides)).frame;
}

describe("deriveFaceFeature", () => {
  it("returns a complete reason-coded frame when no face is visible", () => {
    const derived = deriveFaceFeature(nativeResult(null), input());

    expect(derived.frame).toMatchObject({
      schemaVersion: "phenometric.facial-kinematics-frame.v1",
      acquiredAtMs: 1_000,
      sequence: 1,
      captureEpoch: 2,
      faceVisible: false,
      boundingBox: null,
      anatomicalLaterality: "subject-anatomical"
    });
    expect(derived.frame.qualityReasons).toContain("face-not-visible");
    expect(derived.nextState).toEqual({
      normalizedMotionPoints: null,
      acquiredAtMs: null
    });
  });

  it("maps MediaPipe 362/263 and landmark 291 to subject left", () => {
    const frame = frameFor(neutralLandmarks());

    expect(frame.eyeAperture!.left).toBeGreaterThan(
      frame.eyeAperture!.right
    );
    expect(frame.mouthCorners!.left.x).toBeGreaterThan(0);
    expect(frame.mouthCorners!.right.x).toBeLessThan(0);

    const closedLeft = neutralLandmarks();
    for (const [upper, lower] of FACE_LANDMARK_INDICES.subjectLeftEye
      .lidPairs) {
      const middle = (closedLeft[upper].y + closedLeft[lower].y) / 2;
      closedLeft[upper] = point(closedLeft[upper].x, middle - 0.001);
      closedLeft[lower] = point(closedLeft[lower].x, middle + 0.001);
    }
    const closedFrame = frameFor(closedLeft);
    expect(closedFrame.eyeAperture!.left).toBeLessThan(
      frame.eyeAperture!.left * 0.2
    );
    expect(closedFrame.eyeAperture!.right).toBeCloseTo(
      frame.eyeAperture!.right
    );

    const closedRight = neutralLandmarks();
    for (const [upper, lower] of FACE_LANDMARK_INDICES.subjectRightEye
      .lidPairs) {
      const middle = (closedRight[upper].y + closedRight[lower].y) / 2;
      closedRight[upper] = point(closedRight[upper].x, middle - 0.001);
      closedRight[lower] = point(closedRight[lower].x, middle + 0.001);
    }
    const closedRightFrame = frameFor(closedRight);
    expect(closedRightFrame.eyeAperture!.right).toBeLessThan(
      frame.eyeAperture!.right * 0.2
    );
    expect(closedRightFrame.eyeAperture!.left).toBeCloseTo(
      frame.eyeAperture!.left
    );
  });

  it("is invariant to translation, uniform scale, and in-plane rotation", () => {
    const neutral = neutralLandmarks();
    const baseline = frameFor(neutral);
    for (const transformed of [
      transformLandmarks(neutral, { translateX: 70, translateY: -25 }),
      transformLandmarks(neutral, { scale: 0.8 }),
      transformLandmarks(neutral, { rotateDegrees: 12 })
    ]) {
      const frame = frameFor(transformed);
      expect(frame.eyeAperture!.left).toBeCloseTo(
        baseline.eyeAperture!.left,
        8
      );
      expect(frame.eyeAperture!.right).toBeCloseTo(
        baseline.eyeAperture!.right,
        8
      );
      expect(frame.mouthCorners!.left.x).toBeCloseTo(
        baseline.mouthCorners!.left.x,
        8
      );
      expect(frame.mouthCorners!.left.y).toBeCloseTo(
        baseline.mouthCorners!.left.y,
        8
      );
      expect(frame.mouthApertureRatio).toBeCloseTo(
        baseline.mouthApertureRatio!,
        8
      );
    }
  });

  it("derives pitch, yaw, and roll from the column-major face transform", () => {
    const pose = poseFromTransformationMatrix(
      columnMajorMatrix(-6, 11, 8)
    );

    expect(pose?.pitchDegrees).toBeCloseTo(-6, 6);
    expect(pose?.yawDegrees).toBeCloseTo(11, 6);
    expect(pose?.rollDegrees).toBeCloseTo(8, 6);
  });

  it("divides regional displacement by elapsed source time", () => {
    const neutral = neutralLandmarks();
    const first = deriveFaceFeature(nativeResult(neutral), input());
    const moved100ms = neutralLandmarks();
    moved100ms[291] = {
      ...moved100ms[291],
      x: moved100ms[291].x + 0.01
    };
    const after100ms = deriveFaceFeature(
      nativeResult(moved100ms),
      input({
        tMs: 100,
        acquiredAtMs: 1_100,
        sequence: 2,
        state: first.nextState
      })
    );
    const moved50ms = neutralLandmarks();
    moved50ms[291] = {
      ...moved50ms[291],
      x: moved50ms[291].x + 0.005
    };
    const after50ms = deriveFaceFeature(
      nativeResult(moved50ms),
      input({
        tMs: 50,
        acquiredAtMs: 1_050,
        sequence: 2,
        state: first.nextState
      })
    );

    expect(after100ms.frame.regionalMovementSpeed).toBeGreaterThan(0);
    expect(after50ms.frame.regionalMovementSpeed).toBeCloseTo(
      after100ms.frame.regionalMovementSpeed!,
      8
    );
  });

  it("does not treat rigid pose-only image motion as regional movement", () => {
    const neutral = neutralLandmarks();
    const first = deriveFaceFeature(nativeResult(neutral), input());
    const rigidlyMoved = transformLandmarks(neutral, {
      translateX: 24,
      translateY: -12,
      scale: 0.92,
      rotateDegrees: 6
    });
    const second = deriveFaceFeature(
      nativeResult(rigidlyMoved),
      input({
        tMs: 50,
        acquiredAtMs: 1_050,
        sequence: 2,
        state: first.nextState
      })
    );

    expect(second.frame.regionalMovementSpeed).toBeCloseTo(0, 8);
  });

  it("rejects non-finite and out-of-frame native coordinates", () => {
    for (const invalid of [Number.NaN, -0.01, 1.01]) {
      const landmarks = neutralLandmarks();
      landmarks[291] = { ...landmarks[291], x: invalid };
      const derived = deriveFaceFeature(nativeResult(landmarks), input());
      expect(derived.frame.faceVisible).toBe(false);
      expect(derived.frame.eyeAperture).toBeNull();
      expect(derived.frame.qualityReasons).toContain("face-not-visible");
    }
  });

  it("does not emit native landmarks, blendshapes, or matrices", () => {
    const serialized = JSON.stringify(frameFor(neutralLandmarks()));

    expect(serialized).not.toMatch(
      /faceLandmarks|landmarks|blendshapes|transformationMatrix|matrixes/i
    );
  });

  it("measures brow height above the inter-eye axis, per side", () => {
    const result = deriveFaceFeature(
      nativeResult(neutralLandmarks()),
      input({ tMs: 0, acquiredAtMs: 1_000, sequence: 1 })
    );
    const brow = result.frame.browHeight;
    expect(brow).not.toBeNull();
    // The eye centres define y = 0, and the brow sits above them, so height
    // is positive and the two sides match on a symmetric face.
    expect(brow!.left).toBeGreaterThan(0);
    expect(brow!.right).toBeGreaterThan(0);
    expect(brow!.left).toBeCloseTo(brow!.right, 6);
  });

  it("reports a lower brow on the side whose frontalis has dropped", () => {
    const landmarks = neutralLandmarks();
    // Drop the subject-left brow arc (300/293/334) toward the eye line.
    for (const index of [300, 293, 334]) {
      landmarks[index] = {
        ...landmarks[index],
        y: landmarks[index].y + 0.04
      };
    }
    const result = deriveFaceFeature(
      nativeResult(landmarks),
      input({ tMs: 0, acquiredAtMs: 1_000, sequence: 1 })
    );
    const brow = result.frame.browHeight!;
    expect(brow.left).toBeLessThan(brow.right);
  });

  it("is scale invariant, because brow height is normalized by inter-eye distance", () => {
    const base = deriveFaceFeature(
      nativeResult(neutralLandmarks()),
      input({ tMs: 0, acquiredAtMs: 1_000, sequence: 1 })
    );
    // Same face rendered into a frame of a different pixel size.
    const scaled = deriveFaceFeature(
      nativeResult(neutralLandmarks()),
      input({
        tMs: 0,
        acquiredAtMs: 1_000,
        sequence: 1,
        frameWidth: 1_280,
        frameHeight: 720
      })
    );
    expect(scaled.frame.browHeight!.left).toBeCloseTo(
      base.frame.browHeight!.left,
      6
    );
  });
});

describe("palpebral fissure", () => {
  const system = () => coordinateSystem(neutralLandmarks(), WIDTH, HEIGHT)!;

  it("measures both dimensions in shared inter-eye units", () => {
    const marks = neutralLandmarks();
    const left = palpebralFissure(
      marks,
      FACE_LANDMARK_INDICES.subjectLeftEye,
      system(),
      WIDTH,
      HEIGHT
    );
    // Canthi span 0.08 of frame width against a 0.16 inter-eye distance.
    expect(left?.width).toBeCloseTo(0.5, 6);
    expect(left?.height).toBeCloseTo(21.6 / 204.8, 6);
  });

  it("measures both eyes against the same facial scale", () => {
    // The fixture's canthal spans are equal but its lid gaps are not (0.03 vs
    // 0.02 of frame height, deliberately, so the asymmetry metrics have
    // something to find). Equal widths confirm the shared normaliser; unequal
    // heights are the fixture, not the measure.
    const marks = neutralLandmarks();
    const left = palpebralFissure(
      marks, FACE_LANDMARK_INDICES.subjectLeftEye, system(), WIDTH, HEIGHT
    );
    const right = palpebralFissure(
      marks, FACE_LANDMARK_INDICES.subjectRightEye, system(), WIDTH, HEIGHT
    );
    expect(left?.width).toBeCloseTo(right!.width, 9);
    expect(left!.height / right!.height).toBeCloseTo(1.5, 6);
  });

  it("sees a uniformly narrowed fissure that eye aperture cannot", () => {
    // Shrink the subject-left eye 20% about its own centre. The lid gap and the
    // canthal width scale together, so the aperture RATIO is unchanged -- which
    // is exactly the shape ptosis and orbicularis weakness produce, and exactly
    // what a self-normalised ratio is blind to.
    const marks = neutralLandmarks();
    const centreX = 0.58 * WIDTH;
    const centreY = 0.4 * HEIGHT;
    const shrink = (index: number) => {
      const p = marks[index];
      marks[index] = {
        ...p,
        x: (centreX + 0.8 * (p.x * WIDTH - centreX)) / WIDTH,
        y: (centreY + 0.8 * (p.y * HEIGHT - centreY)) / HEIGHT
      };
    };
    for (const index of [362, 263, 385, 380, 387, 373]) shrink(index);

    // Compare the same eye before and against after -- the two eyes differ in
    // the fixture by design, so left-vs-right would not isolate the change.
    const before = palpebralFissure(
      neutralLandmarks(),
      FACE_LANDMARK_INDICES.subjectLeftEye,
      system(),
      WIDTH,
      HEIGHT
    )!;
    const after = palpebralFissure(
      marks, FACE_LANDMARK_INDICES.subjectLeftEye, system(), WIDTH, HEIGHT
    )!;
    expect(after.width).toBeCloseTo(before.width * 0.8, 6);
    expect(after.height).toBeCloseTo(before.height * 0.8, 6);

    // The self-normalised aperture ratio is unmoved by the same change: it
    // divides the gap by the width, and both shrank together.
    const apertureBefore = frameFor(neutralLandmarks()).eyeAperture!.left;
    const apertureAfter = frameFor(marks).eyeAperture!.left;
    expect(apertureAfter).toBeCloseTo(apertureBefore, 9);
  });

  it("abstains when a lid point is missing", () => {
    const marks = neutralLandmarks();
    marks[385] = { x: Number.NaN, y: 0.5, z: 0, visibility: 1 };
    expect(
      palpebralFissure(
        marks, FACE_LANDMARK_INDICES.subjectLeftEye, system(), WIDTH, HEIGHT
      )
    ).toBeNull();
  });
});

describe("mouth midline offset", () => {
  it("is zero when the mouth is centred under the eyes", () => {
    const marks = neutralLandmarks();
    const offset = mouthMidlineOffset(
      marks, coordinateSystem(marks, WIDTH, HEIGHT)!, WIDTH, HEIGHT
    );
    expect(offset).toBeCloseTo(0, 9);
  });

  it("is positive when the mouth sits toward the subject's left", () => {
    // +x is subject left by the repo's convention, and the subject-left eye is
    // at the higher image x, so shifting both corners that way is a subject-left
    // deviation.
    const marks = neutralLandmarks();
    marks[61] = { x: 0.46, y: 0.65, z: 0, visibility: 1 };
    marks[291] = { x: 0.6, y: 0.65, z: 0, visibility: 1 };
    const offset = mouthMidlineOffset(
      marks, coordinateSystem(marks, WIDTH, HEIGHT)!, WIDTH, HEIGHT
    )!;
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeCloseTo((0.03 * WIDTH) / 204.8, 6);
  });

  it("is unchanged by a corner height difference alone", () => {
    // Distinct from corner asymmetry: dropping one corner vertically moves the
    // asymmetry measure but not the lateral position of the mouth centre.
    const marks = neutralLandmarks();
    marks[61] = { x: 0.43, y: 0.69, z: 0, visibility: 1 };
    expect(
      mouthMidlineOffset(
        marks, coordinateSystem(marks, WIDTH, HEIGHT)!, WIDTH, HEIGHT
      )
    ).toBeCloseTo(0, 9);
  });
});

describe("iris geometry", () => {
  function withIris(): NormalizedLandmark[] {
    const marks = neutralLandmarks();
    // Subject-right iris centred in its fissure (canthi 33/133 -> x 0.42).
    marks[468] = { x: 0.42, y: 0.4, z: 0, visibility: 1 };
    marks[469] = { x: 0.4, y: 0.4, z: 0, visibility: 1 };
    marks[470] = { x: 0.42, y: 0.385, z: 0, visibility: 1 };
    marks[471] = { x: 0.44, y: 0.4, z: 0, visibility: 1 };
    marks[472] = { x: 0.42, y: 0.415, z: 0, visibility: 1 };
    // Subject-left iris centred (canthi 362/263 -> x 0.58).
    marks[473] = { x: 0.58, y: 0.4, z: 0, visibility: 1 };
    marks[474] = { x: 0.56, y: 0.4, z: 0, visibility: 1 };
    marks[475] = { x: 0.58, y: 0.385, z: 0, visibility: 1 };
    marks[476] = { x: 0.6, y: 0.4, z: 0, visibility: 1 };
    marks[477] = { x: 0.58, y: 0.415, z: 0, visibility: 1 };
    return marks;
  }

  it("reports no gaze offset when the iris sits centred in the fissure", () => {
    const marks = withIris();
    const iris = irisGeometry(
      marks,
      FACE_LANDMARK_INDICES.subjectLeftIris,
      FACE_LANDMARK_INDICES.subjectLeftEye.canthi,
      coordinateSystem(marks, WIDTH, HEIGHT)!,
      WIDTH,
      HEIGHT
    );
    expect(iris?.gazeX).toBeCloseTo(0, 9);
    expect(iris?.gazeY).toBeCloseTo(0, 9);
    expect(iris?.diameter).toBeGreaterThan(0);
  });

  it("signs a gaze shift toward the subject's left as positive", () => {
    const marks = withIris();
    for (const index of [473, 474, 475, 476, 477]) {
      marks[index] = { ...marks[index], x: marks[index].x + 0.01 };
    }
    const iris = irisGeometry(
      marks,
      FACE_LANDMARK_INDICES.subjectLeftIris,
      FACE_LANDMARK_INDICES.subjectLeftEye.canthi,
      coordinateSystem(marks, WIDTH, HEIGHT)!,
      WIDTH,
      HEIGHT
    )!;
    expect(iris.gazeX).toBeGreaterThan(0);
    expect(iris.gazeX).toBeCloseTo((0.01 * WIDTH) / 204.8, 6);
  });

  it("abstains when the model returns only the 468-point base mesh", () => {
    // A build without the iris head produces no points past 467. Abstaining is
    // the required behaviour; a zeroed gaze would read as "looking straight
    // ahead", which is a measurement the session never made.
    const marks = neutralLandmarks().slice(0, 468);
    expect(
      irisGeometry(
        marks,
        FACE_LANDMARK_INDICES.subjectLeftIris,
        FACE_LANDMARK_INDICES.subjectLeftEye.canthi,
        coordinateSystem(marks, WIDTH, HEIGHT)!,
        WIDTH,
        HEIGHT
      )
    ).toBeNull();
  });
});

describe("frame carries the derived bilateral geometry", () => {
  function irisLandmarks(): NormalizedLandmark[] {
    const marks = neutralLandmarks();
    const ring = (cx: number, cy: number, r: number) => [
      { x: cx - r, y: cy },
      { x: cx, y: cy - r * (WIDTH / HEIGHT) },
      { x: cx + r, y: cy },
      { x: cx, y: cy + r * (WIDTH / HEIGHT) }
    ];
    marks[468] = point(0.42, 0.4);
    ring(0.42, 0.4, 0.012).forEach((p, i) => {
      marks[469 + i] = point(p.x, p.y);
    });
    marks[473] = point(0.58, 0.4);
    ring(0.58, 0.4, 0.012).forEach((p, i) => {
      marks[474 + i] = point(p.x, p.y);
    });
    return marks;
  }

  it("emits fissure dimensions and midline offset for a visible face", () => {
    const frame = frameFor(neutralLandmarks());
    expect(frame.fissureWidth).not.toBeNull();
    expect(frame.fissureHeight).not.toBeNull();
    expect(frame.fissureWidth!.left).toBeCloseTo(0.5, 6);
    expect(frame.mouthMidlineOffset).toBeCloseTo(0, 9);
  });

  it("emits gaze and limbus diameter when the iris head is present", () => {
    const frame = frameFor(irisLandmarks());
    expect(frame.gazeOffset).not.toBeNull();
    expect(frame.irisDiameter).not.toBeNull();
    expect(frame.irisDiameter!.left).toBeGreaterThan(0);
    expect(frame.gazeOffset!.left.x).toBeCloseTo(0, 6);
  });

  it("abstains on gaze when the iris points are degenerate", () => {
    // The default fill puts every unset landmark at the same coordinate, which
    // is what an absent iris head looks like when the array is padded rather
    // than truncated. A zero-radius iris must not yield a confident gaze.
    const frame = frameFor(neutralLandmarks());
    expect(frame.gazeOffset).toBeNull();
    expect(frame.irisDiameter).toBeNull();
  });

  it("nulls every derived field when no face is visible", () => {
    const frame = deriveFaceFeature(nativeResult(null), input()).frame;
    expect(frame.fissureWidth).toBeNull();
    expect(frame.fissureHeight).toBeNull();
    expect(frame.mouthMidlineOffset).toBeNull();
    expect(frame.gazeOffset).toBeNull();
    expect(frame.irisDiameter).toBeNull();
  });
});
