import type {
  FaceLandmarkerResult,
  Matrix,
  NormalizedLandmark
} from "@mediapipe/tasks-vision";
import {
  evaluateVisualQuality,
  type FacialKinematicsFrameV1
} from "@phenometric/ambient-core";
import type {
  FaceCalibration,
  VisualTaskContext
} from "@phenometric/contracts";
import type { FaceImageQuality } from "./visual-image-quality.js";

export const FACIAL_KINEMATICS_SCHEMA_VERSION =
  "phenometric.facial-kinematics-frame.v1" as const;
export const FACE_GEOMETRY_VERSION = "bilateral-geometry-v1" as const;

export const FACE_LANDMARK_INDICES = {
  subjectLeftEye: {
    canthi: [362, 263],
    lidPairs: [
      [385, 380],
      [387, 373]
    ]
  },
  subjectRightEye: {
    canthi: [33, 133],
    lidPairs: [
      [160, 144],
      [158, 153]
    ]
  },
  subjectLeftBrow: [300, 293, 334],
  subjectRightBrow: [70, 63, 105],
  subjectLeftMouthCorner: 291,
  subjectRightMouthCorner: 61,
  upperInnerLip: 13,
  lowerInnerLip: 14,
  /*
   * Iris points, present only in the 478-landmark output. The base tesselation
   * ends at 467; these ten are appended by the iris head of
   * face_landmarker.task. Index values read from the library's own
   * FACE_LANDMARKS_LEFT_IRIS and FACE_LANDMARKS_RIGHT_IRIS connection sets
   * rather than assumed, and MediaPipe's LEFT/RIGHT there matches this repo's
   * subject-anatomical convention, the same way the eye and brow sets already
   * do.
   *
   * These trace the limbus -- the iris/sclera boundary -- NOT the pupil. Pupil
   * diameter is not recoverable from this model, so nothing here is an
   * autonomic measure. Iris diameter is near-constant within a person, which
   * makes it a scale reference rather than a signal.
   *
   * Every consumer abstains when the points are absent, so a 468-landmark
   * result degrades to "not measurable" instead of reading zeros as data.
   */
  subjectLeftIris: { centre: 473, ring: [474, 475, 476, 477] },
  subjectRightIris: { centre: 468, ring: [469, 470, 471, 472] }
} as const;

const REGIONAL_MOTION_LANDMARKS = [
  33, 133, 362, 263, 61, 291, 13, 14, 70, 300
] as const;

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface FaceFeatureState {
  normalizedMotionPoints: NormalizedPoint[] | null;
  acquiredAtMs: number | null;
}

export interface FaceFeatureInput {
  tMs: number;
  acquiredAtMs: number;
  sequence: number;
  captureEpoch: number;
  taskContext: VisualTaskContext;
  frameWidth: number;
  frameHeight: number;
  imageQuality: FaceImageQuality;
  analyzedFrameRate: number;
  interResultGapMs: number | null;
  skippedFrameFraction: number;
  processingLatencyMs: number;
  processorRef: string;
  calibration?: FaceCalibration | null;
  state?: FaceFeatureState;
}

export interface FaceFeatureResult {
  frame: FacialKinematicsFrameV1;
  nextState: FaceFeatureState;
  boundingBox: FacialKinematicsFrameV1["boundingBox"];
}

interface PixelPoint {
  x: number;
  y: number;
}

interface FaceCoordinateSystem {
  center: PixelPoint;
  scale: number;
  angleRadians: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function pointAt(
  landmarks: NormalizedLandmark[],
  index: number
): NormalizedLandmark | null {
  const point = landmarks[index];
  return point &&
    finite(point.x) &&
    finite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
    ? point
    : null;
}

function toPixelPoint(
  point: NormalizedLandmark,
  frameWidth: number,
  frameHeight: number
): PixelPoint {
  return {
    x: point.x * frameWidth,
    y: point.y * frameHeight
  };
}

function distance(left: PixelPoint, right: PixelPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

export function boundingBoxForLandmarks(
  landmarks: NormalizedLandmark[],
  frameWidth: number,
  frameHeight: number
): NonNullable<FacialKinematicsFrameV1["boundingBox"]> | null {
  const valid = landmarks.filter(
    (landmark) =>
      finite(landmark.x) &&
      finite(landmark.y) &&
      landmark.x >= 0 &&
      landmark.x <= 1 &&
      landmark.y >= 0 &&
      landmark.y <= 1
  );
  if (
    valid.length === 0 ||
    valid.length !== landmarks.length ||
    !finite(frameWidth) ||
    !finite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return null;
  }
  const xs = valid.map((landmark) => landmark.x);
  const ys = valid.map((landmark) => landmark.y);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const width = maximumX - minimumX;
  const height = maximumY - minimumY;
  return {
    x: minimumX,
    y: minimumY,
    width,
    height,
    widthPixels: width * frameWidth,
    heightPixels: height * frameHeight,
    edgeMarginFraction: Math.min(
      minimumX,
      minimumY,
      1 - maximumX,
      1 - maximumY
    )
  };
}

function midpoint(left: PixelPoint, right: PixelPoint): PixelPoint {
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2
  };
}

export function coordinateSystem(
  landmarks: NormalizedLandmark[],
  frameWidth: number,
  frameHeight: number
): FaceCoordinateSystem | null {
  const leftCanthusA = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectLeftEye.canthi[0]
  );
  const leftCanthusB = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectLeftEye.canthi[1]
  );
  const rightCanthusA = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectRightEye.canthi[0]
  );
  const rightCanthusB = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectRightEye.canthi[1]
  );
  if (
    !leftCanthusA ||
    !leftCanthusB ||
    !rightCanthusA ||
    !rightCanthusB
  ) {
    return null;
  }
  const leftEyeCenter = midpoint(
    toPixelPoint(leftCanthusA, frameWidth, frameHeight),
    toPixelPoint(leftCanthusB, frameWidth, frameHeight)
  );
  const rightEyeCenter = midpoint(
    toPixelPoint(rightCanthusA, frameWidth, frameHeight),
    toPixelPoint(rightCanthusB, frameWidth, frameHeight)
  );
  const scale = distance(rightEyeCenter, leftEyeCenter);
  if (!finite(scale) || scale <= 0) return null;
  return {
    center: midpoint(leftEyeCenter, rightEyeCenter),
    scale,
    angleRadians: Math.atan2(
      leftEyeCenter.y - rightEyeCenter.y,
      leftEyeCenter.x - rightEyeCenter.x
    )
  };
}

function normalizePoint(
  point: NormalizedLandmark,
  system: FaceCoordinateSystem,
  frameWidth: number,
  frameHeight: number
): NormalizedPoint {
  const pixels = toPixelPoint(point, frameWidth, frameHeight);
  const translatedX = pixels.x - system.center.x;
  const translatedY = pixels.y - system.center.y;
  const cosine = Math.cos(system.angleRadians);
  const sine = Math.sin(system.angleRadians);
  return {
    x:
      (cosine * translatedX + sine * translatedY) /
      system.scale,
    y:
      (-sine * translatedX + cosine * translatedY) /
      system.scale
  };
}

function eyeAperture(
  landmarks: NormalizedLandmark[],
  indices: {
    readonly canthi: readonly [number, number];
    readonly lidPairs: readonly [
      readonly [number, number],
      readonly [number, number]
    ];
  },
  frameWidth: number,
  frameHeight: number
): number | null {
  const canthusA = pointAt(landmarks, indices.canthi[0]);
  const canthusB = pointAt(landmarks, indices.canthi[1]);
  if (!canthusA || !canthusB) return null;
  const width = distance(
    toPixelPoint(canthusA, frameWidth, frameHeight),
    toPixelPoint(canthusB, frameWidth, frameHeight)
  );
  if (width <= 0) return null;
  let gapTotal = 0;
  for (const [upperIndex, lowerIndex] of indices.lidPairs) {
    const upper = pointAt(landmarks, upperIndex);
    const lower = pointAt(landmarks, lowerIndex);
    if (!upper || !lower) return null;
    gapTotal += distance(
      toPixelPoint(upper, frameWidth, frameHeight),
      toPixelPoint(lower, frameWidth, frameHeight)
    );
  }
  return gapTotal / 2 / width;
}

/**
 * Height of the brow arc above the inter-eye axis, in inter-eye units.
 *
 * The coordinate origin sits at the midpoint of the two eye centres with the
 * x-axis along the inter-eye line, so both eye centres lie at y = 0 by
 * construction and the brow sits at negative y. Negating gives a positive
 * height that is already scale-normalised and roll-corrected.
 *
 * Averaging three points along the arc rather than taking a single landmark
 * keeps the value stable against per-frame landmark jitter.
 */
/**
 * Palpebral fissure width and height, both in shared inter-eye units.
 *
 * {@link eyeAperture} divides each eye's lid gap by that same eye's canthal
 * width, so a fissure that is uniformly smaller on one side -- the shape ptosis
 * and orbicularis weakness produce -- can still yield a normal-looking ratio.
 * Measuring the two dimensions separately against the shared facial scale
 * keeps that difference visible.
 */
export function palpebralFissure(
  landmarks: NormalizedLandmark[],
  indices: {
    readonly canthi: readonly [number, number];
    readonly lidPairs: readonly [
      readonly [number, number],
      readonly [number, number]
    ];
  },
  system: FaceCoordinateSystem,
  frameWidth: number,
  frameHeight: number
): { width: number; height: number } | null {
  if (system.scale <= 0) return null;
  const canthusA = pointAt(landmarks, indices.canthi[0]);
  const canthusB = pointAt(landmarks, indices.canthi[1]);
  if (!canthusA || !canthusB) return null;
  const width =
    distance(
      toPixelPoint(canthusA, frameWidth, frameHeight),
      toPixelPoint(canthusB, frameWidth, frameHeight)
    ) / system.scale;

  let gapTotal = 0;
  for (const [upperIndex, lowerIndex] of indices.lidPairs) {
    const upper = pointAt(landmarks, upperIndex);
    const lower = pointAt(landmarks, lowerIndex);
    if (!upper || !lower) return null;
    gapTotal += distance(
      toPixelPoint(upper, frameWidth, frameHeight),
      toPixelPoint(lower, frameWidth, frameHeight)
    );
  }
  const height = gapTotal / indices.lidPairs.length / system.scale;
  return finite(width) && finite(height) ? { width, height } : null;
}

/**
 * Lateral offset of the mouth centre from the facial midline.
 *
 * The coordinate origin is the midpoint of the eye centres and +x is subject
 * left, so the x of the mouth-corner midpoint is already the deviation. Signed:
 * positive means the mouth centre sits toward the subject's left.
 *
 * Distinct from corner asymmetry, which compares the two corners to each other.
 * A mouth pulled bodily off-centre by unilateral weakness moves this without
 * necessarily changing the height difference between the corners.
 */
export function mouthMidlineOffset(
  landmarks: NormalizedLandmark[],
  system: FaceCoordinateSystem,
  frameWidth: number,
  frameHeight: number
): number | null {
  const left = pointAt(landmarks, FACE_LANDMARK_INDICES.subjectLeftMouthCorner);
  const right = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectRightMouthCorner
  );
  if (!left || !right) return null;
  const leftPoint = normalizePoint(left, system, frameWidth, frameHeight);
  const rightPoint = normalizePoint(right, system, frameWidth, frameHeight);
  const offset = (leftPoint.x + rightPoint.x) / 2;
  return finite(offset) ? offset : null;
}

/**
 * Iris centre offset within the fissure, plus limbus diameter.
 *
 * `gazeX`/`gazeY` are the iris centre relative to the midpoint of that eye's
 * canthi, in inter-eye units, so they describe where the eye is pointed
 * independently of where the head is. `diameter` is the mean centre-to-limbus
 * distance doubled.
 *
 * Returns null when the iris points are absent, which is what a 468-landmark
 * result gives. That is a real abstention, not a zero.
 */
export function irisGeometry(
  landmarks: NormalizedLandmark[],
  indices: {
    readonly centre: number;
    readonly ring: readonly number[];
  },
  canthi: readonly [number, number],
  system: FaceCoordinateSystem,
  frameWidth: number,
  frameHeight: number
): { gazeX: number; gazeY: number; diameter: number } | null {
  if (system.scale <= 0) return null;
  const centre = pointAt(landmarks, indices.centre);
  const canthusA = pointAt(landmarks, canthi[0]);
  const canthusB = pointAt(landmarks, canthi[1]);
  if (!centre || !canthusA || !canthusB) return null;

  const centrePoint = normalizePoint(centre, system, frameWidth, frameHeight);
  const a = normalizePoint(canthusA, system, frameWidth, frameHeight);
  const b = normalizePoint(canthusB, system, frameWidth, frameHeight);
  const gazeX = centrePoint.x - (a.x + b.x) / 2;
  const gazeY = centrePoint.y - (a.y + b.y) / 2;

  const centrePixels = toPixelPoint(centre, frameWidth, frameHeight);
  let radiusTotal = 0;
  for (const index of indices.ring) {
    const point = pointAt(landmarks, index);
    if (!point) return null;
    radiusTotal += distance(
      centrePixels,
      toPixelPoint(point, frameWidth, frameHeight)
    );
  }
  const diameter =
    (2 * (radiusTotal / indices.ring.length)) / system.scale;
  return finite(gazeX) && finite(gazeY) && finite(diameter)
    ? { gazeX, gazeY, diameter }
    : null;
}

function browHeight(
  landmarks: NormalizedLandmark[],
  indices: readonly number[],
  system: FaceCoordinateSystem,
  frameWidth: number,
  frameHeight: number
): number | null {
  const heights: number[] = [];
  for (const index of indices) {
    const point = pointAt(landmarks, index);
    if (!point) return null;
    heights.push(
      -normalizePoint(point, system, frameWidth, frameHeight).y
    );
  }
  if (heights.length === 0) return null;
  const mean = heights.reduce((total, value) => total + value, 0) / heights.length;
  return finite(mean) ? mean : null;
}

function mouthAperture(
  landmarks: NormalizedLandmark[],
  frameWidth: number,
  frameHeight: number
): number | null {
  const upper = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.upperInnerLip
  );
  const lower = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.lowerInnerLip
  );
  const left = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectLeftMouthCorner
  );
  const right = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectRightMouthCorner
  );
  if (!upper || !lower || !left || !right) return null;
  const width = distance(
    toPixelPoint(left, frameWidth, frameHeight),
    toPixelPoint(right, frameWidth, frameHeight)
  );
  if (width <= 0) return null;
  return (
    distance(
      toPixelPoint(upper, frameWidth, frameHeight),
      toPixelPoint(lower, frameWidth, frameHeight)
    ) / width
  );
}

function normalizedMotionPoints(
  landmarks: NormalizedLandmark[],
  system: FaceCoordinateSystem,
  frameWidth: number,
  frameHeight: number
): NormalizedPoint[] | null {
  const points: NormalizedPoint[] = [];
  for (const index of REGIONAL_MOTION_LANDMARKS) {
    const point = pointAt(landmarks, index);
    if (!point) return null;
    points.push(normalizePoint(point, system, frameWidth, frameHeight));
  }
  return points;
}

function movementSpeed(
  current: NormalizedPoint[] | null,
  acquiredAtMs: number,
  previous: FaceFeatureState | undefined
): number | null {
  if (
    !current ||
    !previous?.normalizedMotionPoints ||
    previous.normalizedMotionPoints.length !== current.length ||
    previous.acquiredAtMs === null
  ) {
    return null;
  }
  const elapsedSeconds =
    (acquiredAtMs - previous.acquiredAtMs) / 1_000;
  if (!finite(elapsedSeconds) || elapsedSeconds <= 0) return null;
  const meanDisplacement =
    current.reduce(
      (total, point, index) =>
        total +
        Math.hypot(
          point.x - previous.normalizedMotionPoints![index].x,
          point.y - previous.normalizedMotionPoints![index].y
        ),
      0
    ) / current.length;
  return meanDisplacement / elapsedSeconds;
}

function matrixValue(
  matrix: Matrix,
  row: number,
  column: number
): number {
  // MediaPipe MatrixData is column-major by default.
  return matrix.data[column * matrix.rows + row];
}

/**
 * Extracts intrinsic XYZ Euler angles from MediaPipe's column-major rigid
 * facial transform. Scale is removed from each basis vector first.
 */
export function poseFromTransformationMatrix(
  matrix: Matrix | undefined
): FacialKinematicsFrameV1["pose"] {
  if (
    !matrix ||
    matrix.rows < 3 ||
    matrix.columns < 3 ||
    matrix.data.length < matrix.rows * matrix.columns
  ) {
    return null;
  }
  const columns = [0, 1, 2].map((column) => {
    const values = [0, 1, 2].map((row) =>
      matrixValue(matrix, row, column)
    );
    const magnitude = Math.hypot(...values);
    return magnitude > 0
      ? values.map((value) => value / magnitude)
      : values;
  });
  const r00 = columns[0][0];
  const r10 = columns[0][1];
  const r20 = columns[0][2];
  const r21 = columns[1][2];
  const r22 = columns[2][2];
  if (![r00, r10, r20, r21, r22].every(finite)) return null;

  const yaw = Math.asin(Math.max(-1, Math.min(1, -r20)));
  const cosineYaw = Math.cos(yaw);
  const pitch =
    Math.abs(cosineYaw) > 1e-6
      ? Math.atan2(r21, r22)
      : 0;
  const roll =
    Math.abs(cosineYaw) > 1e-6
      ? Math.atan2(r10, r00)
      : Math.atan2(-columns[1][0], columns[1][1]);
  const degrees = 180 / Math.PI;
  return {
    yawDegrees: yaw * degrees,
    pitchDegrees: pitch * degrees,
    rollDegrees: roll * degrees
  };
}

function baseFrame(
  input: FaceFeatureInput
): Omit<FacialKinematicsFrameV1, "qualityReasons"> {
  return {
    schemaVersion: FACIAL_KINEMATICS_SCHEMA_VERSION,
    tMs: input.tMs,
    acquiredAtMs: input.acquiredAtMs,
    sequence: input.sequence,
    captureEpoch: input.captureEpoch,
    taskContext: input.taskContext,
    faceVisible: false,
    boundingBox: null,
    anatomicalLaterality: "subject-anatomical",
    pose: null,
    eyeAperture: null,
    browHeight: null,
    mouthCorners: null,
    mouthApertureRatio: null,
    regionalMovementSpeed: null,
    imageQuality: input.imageQuality,
    analyzedFrameRate: input.analyzedFrameRate,
    interResultGapMs: input.interResultGapMs,
    skippedFrameFraction: input.skippedFrameFraction,
    processingLatencyMs: input.processingLatencyMs,
    processorRef: input.processorRef
  };
}

export function deriveFaceFeature(
  result: FaceLandmarkerResult,
  input: FaceFeatureInput
): FaceFeatureResult {
  const landmarks = result.faceLandmarks[0];
  const validBox = landmarks
    ? boundingBoxForLandmarks(
        landmarks,
        input.frameWidth,
        input.frameHeight
      )
    : null;
  if (!landmarks || validBox === null) {
    const withoutReasons = baseFrame(input);
    const provisional = {
      ...withoutReasons,
      qualityReasons: []
    } satisfies FacialKinematicsFrameV1;
    const quality = evaluateVisualQuality(
      provisional,
      input.calibration ?? null
    );
    const frame: FacialKinematicsFrameV1 = {
      ...withoutReasons,
      qualityReasons: quality.reasonCodes
    };
    return {
      frame,
      nextState: {
        normalizedMotionPoints: null,
        acquiredAtMs: null
      },
      boundingBox: null
    };
  }

  const system = coordinateSystem(
    landmarks,
    input.frameWidth,
    input.frameHeight
  );
  const box = validBox;
  const leftMouth = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectLeftMouthCorner
  );
  const rightMouth = pointAt(
    landmarks,
    FACE_LANDMARK_INDICES.subjectRightMouthCorner
  );
  const motionPoints = system
    ? normalizedMotionPoints(
        landmarks,
        system,
        input.frameWidth,
        input.frameHeight
      )
    : null;
  const nextState: FaceFeatureState = {
    normalizedMotionPoints: motionPoints,
    acquiredAtMs: motionPoints ? input.acquiredAtMs : null
  };

  const leftEyeAperture = eyeAperture(
    landmarks,
    FACE_LANDMARK_INDICES.subjectLeftEye,
    input.frameWidth,
    input.frameHeight
  );
  const rightEyeAperture = eyeAperture(
    landmarks,
    FACE_LANDMARK_INDICES.subjectRightEye,
    input.frameWidth,
    input.frameHeight
  );
  const withoutReasons: Omit<
    FacialKinematicsFrameV1,
    "qualityReasons"
  > = {
    ...baseFrame(input),
    faceVisible: true,
    boundingBox: box,
    pose: poseFromTransformationMatrix(
      result.facialTransformationMatrixes[0]
    ),
    eyeAperture:
      leftEyeAperture !== null && rightEyeAperture !== null
        ? {
            left: leftEyeAperture,
            right: rightEyeAperture
          }
        : null,
    mouthCorners:
      system && leftMouth && rightMouth
        ? {
            left: normalizePoint(
              leftMouth,
              system,
              input.frameWidth,
              input.frameHeight
            ),
            right: normalizePoint(
              rightMouth,
              system,
              input.frameWidth,
              input.frameHeight
            )
          }
        : null,
    browHeight:
      system
        ? (() => {
            const left = browHeight(
              landmarks,
              FACE_LANDMARK_INDICES.subjectLeftBrow,
              system,
              input.frameWidth,
              input.frameHeight
            );
            const right = browHeight(
              landmarks,
              FACE_LANDMARK_INDICES.subjectRightBrow,
              system,
              input.frameWidth,
              input.frameHeight
            );
            return left !== null && right !== null ? { left, right } : null;
          })()
        : null,
    mouthApertureRatio: mouthAperture(
      landmarks,
      input.frameWidth,
      input.frameHeight
    ),
    regionalMovementSpeed: movementSpeed(
      motionPoints,
      input.acquiredAtMs,
      input.state
    )
  };
  const provisional = {
    ...withoutReasons,
    qualityReasons: []
  } satisfies FacialKinematicsFrameV1;
  const quality = evaluateVisualQuality(
    provisional,
    input.calibration ?? null
  );
  const frame: FacialKinematicsFrameV1 = {
    ...withoutReasons,
    qualityReasons: quality.reasonCodes
  };
  return {
    frame,
    nextState: quality.usable
      ? nextState
      : {
          normalizedMotionPoints: null,
          acquiredAtMs: null
        },
    boundingBox: box
  };
}
