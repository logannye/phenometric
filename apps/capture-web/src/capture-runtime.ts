import type {
  FacialKinematicsFrameV1,
  VoiceSignalFrameV1
} from "@phenometrix/ambient-core";

export interface CaptureResourceHandles {
  stopFacePump?(): void;
  stopVoicePipeline?(): Promise<void>;
  disposeFaceWorker?(): Promise<void>;
  streams?: readonly MediaStream[];
  video?: HTMLVideoElement;
  disconnectAudio?(): void;
  audioContext?: AudioContext;
  cancelTimers?(): void;
}

export interface DerivedCaptureSnapshot {
  readonly voice: readonly VoiceSignalFrameV1[];
  readonly face: readonly FacialKinematicsFrameV1[];
}

function freezeSnapshot(
  voice: readonly VoiceSignalFrameV1[],
  face: readonly FacialKinematicsFrameV1[]
): DerivedCaptureSnapshot {
  return Object.freeze({
    voice: Object.freeze(voice.map((frame) => Object.freeze({ ...frame }))),
    face: Object.freeze(face.map((frame) => Object.freeze({ ...frame })))
  });
}

async function ignoreFailure(action: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!action) return;
  try {
    await action();
  } catch {
    // Teardown is best-effort per resource and must continue to later resources.
  }
}

export class CaptureRuntime {
  private voiceFrames: VoiceSignalFrameV1[] = [];
  private faceFrames: FacialKinematicsFrameV1[] = [];
  private handles: CaptureResourceHandles = {};
  private disposing: Promise<DerivedCaptureSnapshot | null> | null = null;
  private disposed = false;

  attach(handles: CaptureResourceHandles): void {
    if (this.disposed || this.disposing) {
      handles.streams?.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop())
      );
      void handles.audioContext?.close();
      return;
    }
    this.handles = handles;
  }

  addVoiceFrame(frame: VoiceSignalFrameV1): void {
    if (!this.disposed && !this.disposing) this.voiceFrames.push(frame);
  }

  addFaceFrame(frame: FacialKinematicsFrameV1): void {
    if (!this.disposed && !this.disposing) this.faceFrames.push(frame);
  }

  dispose(preserveDerived: boolean): Promise<DerivedCaptureSnapshot | null> {
    if (this.disposing) return this.disposing;
    if (this.disposed) return Promise.resolve(null);
    this.disposing = this.disposeOnce(preserveDerived);
    return this.disposing;
  }

  private async disposeOnce(
    preserveDerived: boolean
  ): Promise<DerivedCaptureSnapshot | null> {
    const handles = this.handles;
    await ignoreFailure(handles.cancelTimers);
    await ignoreFailure(handles.stopFacePump);
    await ignoreFailure(handles.stopVoicePipeline);
    await ignoreFailure(handles.disposeFaceWorker);
    handles.streams?.forEach((stream) =>
      stream.getTracks().forEach((track) => track.stop())
    );
    if (handles.video) {
      handles.video.pause();
      handles.video.srcObject = null;
    }
    await ignoreFailure(handles.disconnectAudio);
    if (handles.audioContext && handles.audioContext.state !== "closed") {
      await ignoreFailure(() => handles.audioContext!.close());
    }

    const snapshot = preserveDerived
      ? freezeSnapshot(this.voiceFrames, this.faceFrames)
      : null;
    this.voiceFrames.length = 0;
    this.faceFrames.length = 0;
    this.handles = {};
    this.disposed = true;
    return snapshot;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(fallback()), timeoutMs);
  });
  const result = await Promise.race([promise, timeout]);
  if (handle !== undefined) clearTimeout(handle);
  return result;
}
