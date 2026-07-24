import {
  FaceLandmarker,
  type NormalizedLandmark
} from "@mediapipe/tasks-vision";
import type { VisualTaskContext } from "@phenometrix/contracts";
import { FACE_LANDMARK_INDICES } from "./face-features.js";
import {
  EMPTY_RESULT,
  FACE_MESH_LANDMARK_COUNT,
  type FaceMeshRenderer,
  type FaceMeshRenderInput,
  type FaceMeshRenderResult
} from "./face-mesh-renderer.js";

export { FACE_MESH_LANDMARK_COUNT } from "./face-mesh-renderer.js";
export type {
  FaceMeshRenderInput,
  FaceMeshRenderResult
} from "./face-mesh-renderer.js";

export const MAX_FACE_MESH_RENDER_HZ = 24;

export function faceMeshPresentationEligible(
  faceCount: number,
  captureEpoch: number,
  overlayCaptureEpoch: number | null
): boolean {
  return faceCount === 1 && captureEpoch === overlayCaptureEpoch;
}

const LEFT_EYE_APERTURE_ANCHORS = [
  ...FACE_LANDMARK_INDICES.subjectLeftEye.canthi,
  ...FACE_LANDMARK_INDICES.subjectLeftEye.lidPairs[0],
  ...FACE_LANDMARK_INDICES.subjectLeftEye.lidPairs[1]
] as const;
const RIGHT_EYE_APERTURE_ANCHORS = [
  ...FACE_LANDMARK_INDICES.subjectRightEye.canthi,
  ...FACE_LANDMARK_INDICES.subjectRightEye.lidPairs[0],
  ...FACE_LANDMARK_INDICES.subjectRightEye.lidPairs[1]
] as const;
const MOUTH_CORNER_ANCHORS = [
  FACE_LANDMARK_INDICES.subjectLeftMouthCorner,
  FACE_LANDMARK_INDICES.subjectRightMouthCorner
] as const;

type MeshConnection = { start: number; end: number };

interface AccentGroup {
  connections: readonly MeshConnection[];
  color: string;
  lineWidth: number;
}

function finitePoint(
  landmarks: readonly NormalizedLandmark[],
  index: number
): NormalizedLandmark | null {
  const landmark = landmarks[index];
  return landmark &&
    Number.isFinite(landmark.x) &&
    Number.isFinite(landmark.y)
    ? landmark
    : null;
}

function taskAnchors(taskContext: VisualTaskContext): readonly number[] {
  switch (taskContext) {
    case "smile":
      return MOUTH_CORNER_ANCHORS;
    case "eye-closure":
      return [
        ...LEFT_EYE_APERTURE_ANCHORS,
        ...RIGHT_EYE_APERTURE_ANCHORS
      ];
    case "neutral-face":
    case "ambient-frontal":
      return [
        ...LEFT_EYE_APERTURE_ANCHORS,
        ...RIGHT_EYE_APERTURE_ANCHORS,
        ...MOUTH_CORNER_ANCHORS
      ];
    case "establishing":
      return [1, 152, 33, 263, 61, 291];
    case "turn-away":
      return [];
  }
}

function activeSemanticRegions(
  taskContext: VisualTaskContext
): ReadonlySet<"eyes" | "brows" | "lips" | "oval"> {
  switch (taskContext) {
    case "smile":
      return new Set(["lips"]);
    case "eye-closure":
      return new Set(["eyes"]);
    case "neutral-face":
    case "ambient-frontal":
      return new Set(["eyes", "brows", "lips", "oval"]);
    case "establishing":
    case "turn-away":
      return new Set(["oval"]);
  }
}

/**
 * Presentation-only worker renderer. It owns the transferred canvas but never
 * retains landmarks or reads pixels back from the overlay.
 */
export class FaceMeshOverlayRenderer implements FaceMeshRenderer {
  private canvas: OffscreenCanvas | null = null;
  private context: OffscreenCanvasRenderingContext2D | null = null;
  private maxRenderHz = MAX_FACE_MESH_RENDER_HZ;
  private lastRenderedAtMs: number | null = null;
  private latest: FaceMeshRenderInput | null = null;

  attach(canvas: OffscreenCanvas, requestedMaxRenderHz: number): boolean {
    this.detach();
    const context = canvas.getContext("2d");
    if (!context) {
      return false;
    }
    this.canvas = canvas;
    this.context = context;
    this.maxRenderHz = Math.max(
      1,
      Math.min(
        MAX_FACE_MESH_RENDER_HZ,
        Number.isFinite(requestedMaxRenderHz)
          ? requestedMaxRenderHz
          : MAX_FACE_MESH_RENDER_HZ
      )
    );
    this.clear();
    return true;
  }

  isAttached(): boolean {
    return this.canvas !== null && this.context !== null;
  }

  clear(): void {
    if (this.canvas && this.context) {
      this.context.clearRect(
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );
    }
    this.lastRenderedAtMs = null;
  }

  detach(): void {
    this.clear();
    this.canvas = null;
    this.context = null;
  }

  updateLandmarks(input: FaceMeshRenderInput): void {
    this.latest = input;
  }

  render(input: FaceMeshRenderInput): FaceMeshRenderResult {
    this.updateLandmarks(input);
    return this.drawFrame(input.acquiredAtMs, 1);
  }

  drawFrame(
    nowMs: number,
    _introProgress = 1
  ): FaceMeshRenderResult {
    const input = this.latest;
    const canvas = this.canvas;
    const context = this.context;
    if (
      !input ||
      !canvas ||
      !context ||
      !Number.isFinite(input.width) ||
      !Number.isFinite(input.height) ||
      input.width <= 0 ||
      input.height <= 0 ||
      !Number.isFinite(nowMs)
    ) {
      return EMPTY_RESULT;
    }

    const minimumIntervalMs = 1_000 / this.maxRenderHz;
    if (
      this.lastRenderedAtMs !== null &&
      nowMs - this.lastRenderedAtMs < minimumIntervalMs
    ) {
      return EMPTY_RESULT;
    }

    const width = Math.round(input.width);
    const height = Math.round(input.height);
    if (canvas.width !== width) {
      canvas.width = width;
    }
    if (canvas.height !== height) {
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);

    const point = (index: number) =>
      finitePoint(input.landmarks, index);
    const plot = (landmark: NormalizedLandmark) => ({
      x: landmark.x * width,
      y: landmark.y * height
    });

    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "rgba(70, 235, 211, 0.22)";
    context.lineWidth = Math.max(0.65, width / 1_600);
    context.beginPath();
    let tessellationEdges = 0;
    for (const connection of FaceLandmarker.FACE_LANDMARKS_TESSELATION) {
      const start = point(connection.start);
      const end = point(connection.end);
      if (!start || !end) {
        continue;
      }
      const startPixel = plot(start);
      const endPixel = plot(end);
      context.moveTo(startPixel.x, startPixel.y);
      context.lineTo(endPixel.x, endPixel.y);
      tessellationEdges += 1;
    }
    context.stroke();

    context.fillStyle = "rgba(172, 255, 240, 0.68)";
    context.beginPath();
    let landmarkDots = 0;
    const dotRadius = Math.max(0.8, width / 1_500);
    for (
      let index = 0;
      index <
      Math.min(FACE_MESH_LANDMARK_COUNT, input.landmarks.length);
      index += 1
    ) {
      const landmark = point(index);
      if (!landmark) {
        continue;
      }
      const pixel = plot(landmark);
      context.moveTo(pixel.x + dotRadius, pixel.y);
      context.arc(
        pixel.x,
        pixel.y,
        dotRadius,
        0,
        Math.PI * 2
      );
      landmarkDots += 1;
    }
    context.fill();

    const activeRegions = activeSemanticRegions(input.taskContext);
    const baseLineWidth = Math.max(1.1, width / 1_000);
    const groups: Array<
      AccentGroup & {
        region: "eyes" | "brows" | "lips" | "oval";
      }
    > = [
      {
        region: "eyes",
        connections: [
          ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
          ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
          ...FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
          ...FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS
        ],
        color: "rgba(88, 226, 255, 0.84)",
        lineWidth: baseLineWidth
      },
      {
        region: "brows",
        connections: [
          ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
          ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW
        ],
        color: "rgba(183, 146, 255, 0.8)",
        lineWidth: baseLineWidth
      },
      {
        region: "lips",
        connections: FaceLandmarker.FACE_LANDMARKS_LIPS,
        color: "rgba(255, 139, 172, 0.88)",
        lineWidth: baseLineWidth
      },
      {
        region: "oval",
        connections: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
        color: "rgba(125, 255, 218, 0.72)",
        lineWidth: baseLineWidth
      }
    ];

    for (const group of groups) {
      context.strokeStyle = group.color;
      context.lineWidth =
        group.lineWidth *
        (activeRegions.has(group.region) ? 2 : 1);
      context.beginPath();
      for (const connection of group.connections) {
        const start = point(connection.start);
        const end = point(connection.end);
        if (!start || !end) {
          continue;
        }
        const startPixel = plot(start);
        const endPixel = plot(end);
        context.moveTo(startPixel.x, startPixel.y);
        context.lineTo(endPixel.x, endPixel.y);
      }
      context.stroke();
    }

    context.fillStyle = "rgba(255, 244, 164, 0.96)";
    context.beginPath();
    let accentAnchors = 0;
    const anchorRadius = Math.max(2.3, width / 500);
    for (const index of taskAnchors(input.taskContext)) {
      const landmark = point(index);
      if (!landmark) {
        continue;
      }
      const pixel = plot(landmark);
      context.moveTo(pixel.x + anchorRadius, pixel.y);
      context.arc(
        pixel.x,
        pixel.y,
        anchorRadius,
        0,
        Math.PI * 2
      );
      accentAnchors += 1;
    }
    context.fill();

    this.lastRenderedAtMs = nowMs;
    return {
      rendered: true,
      landmarkDots,
      tessellationEdges,
      accentAnchors
    };
  }
}
