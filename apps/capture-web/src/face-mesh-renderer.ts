import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { VisualTaskContext } from "@phenometrix/contracts";

export const FACE_MESH_LANDMARK_COUNT = 478;

export interface FaceMeshRenderInput {
  landmarks: readonly NormalizedLandmark[];
  taskContext: VisualTaskContext;
  width: number;
  height: number;
  acquiredAtMs: number;
}

export interface FaceMeshRenderResult {
  rendered: boolean;
  landmarkDots: number;
  tessellationEdges: number;
  accentAnchors: number;
}

/**
 * Per-frame presentation hints. `reducedMotion` forces a static frame (no hue
 * drift, no twinkle, intro treated as complete). `effectLevel` (0..1) is the
 * adaptive performance governor's budget: as it drops the renderer sheds bloom
 * first, then finally freezes hue drift. Both are optional; an undefined
 * `effectLevel` means full effects (1).
 */
export interface MeshDrawOptions {
  reducedMotion?: boolean;
  effectLevel?: number;
}

/** Presentation-only renderer contract shared by the 2D and WebGL2 backends. */
export interface FaceMeshRenderer {
  attach(canvas: OffscreenCanvas, maxRenderHz: number): boolean;
  isAttached(): boolean;
  /** Cache the latest landmark frame; does not draw. */
  updateLandmarks(input: FaceMeshRenderInput): void;
  /** Draw the cached frame at nowMs with optional intro progress (0..1). */
  drawFrame(
    nowMs: number,
    introProgress?: number,
    options?: MeshDrawOptions
  ): FaceMeshRenderResult;
  clear(): void;
  detach(): void;
}

export const EMPTY_RESULT: FaceMeshRenderResult = {
  rendered: false,
  landmarkDots: 0,
  tessellationEdges: 0,
  accentAnchors: 0
};
