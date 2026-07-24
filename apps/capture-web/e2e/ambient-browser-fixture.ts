import type { Page } from "@playwright/test";

export type AmbientBrowserFixtureMode =
  | "deny-all"
  | "audio-only"
  | "dual-lane"
  | "late-audio";

export interface AmbientBrowserProbe {
  trackStops: number;
  audioContextsClosed: number;
  workersTerminated: number;
  resolveLateAudio(): void;
}

export async function installAmbientBrowserFixture(
  page: Page,
  mode: AmbientBrowserFixtureMode
): Promise<void> {
  await page.addInitScript((fixtureMode) => {
    interface MutableProbe extends AmbientBrowserProbe {
      lateAudioResolver: (() => void) | null;
    }

    const probe: MutableProbe = {
      trackStops: 0,
      audioContextsClosed: 0,
      workersTerminated: 0,
      lateAudioResolver: null,
      resolveLateAudio() {
        this.lateAudioResolver?.();
        this.lateAudioResolver = null;
      }
    };
    Object.defineProperty(window, "__ambientTestProbe", {
      value: probe,
      configurable: true
    });

    function fakeTrack(kind: "audio" | "video"): MediaStreamTrack {
      let readyState: MediaStreamTrackState = "live";
      return {
        kind,
        get readyState() {
          return readyState;
        },
        stop() {
          if (readyState === "live") {
            readyState = "ended";
            probe.trackStops += 1;
          }
        },
        getSettings() {
          return kind === "audio"
            ? {
                sampleRate: 48_000,
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
              }
            : { width: 1280, height: 720, frameRate: 30, facingMode: "user" };
        }
      } as MediaStreamTrack;
    }

    function fakeStream(kind: "audio" | "video"): MediaStream {
      const track = fakeTrack(kind);
      return {
        getTracks: () => [track],
        getAudioTracks: () => kind === "audio" ? [track] : [],
        getVideoTracks: () => kind === "video" ? [track] : []
      } as MediaStream;
    }

    const getUserMedia = async (
      constraints: MediaStreamConstraints
    ): Promise<MediaStream> => {
      const audioRequested = Boolean(constraints.audio);
      const videoRequested = Boolean(constraints.video);
      if (fixtureMode === "deny-all") {
        throw new DOMException("Permission denied by browser fixture.", "NotAllowedError");
      }
      if (fixtureMode === "dual-lane" && videoRequested) {
        return fakeStream("video");
      }
      if (!audioRequested) {
        throw new DOMException("Permission denied by browser fixture.", "NotAllowedError");
      }
      if (fixtureMode === "late-audio") {
        return await new Promise<MediaStream>((resolve) => {
          probe.lateAudioResolver = () => resolve(fakeStream("audio"));
        });
      }
      return fakeStream("audio");
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });

    if (fixtureMode === "dual-lane") {
      let callbackId = 0;
      const callbackTimers = new Map<number, number>();
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        configurable: true,
        get() {
          return (this as HTMLMediaElement & { __fixtureStream?: MediaStream })
            .__fixtureStream ?? null;
        },
        set(stream: MediaStream | null) {
          (this as HTMLMediaElement & { __fixtureStream?: MediaStream })
            .__fixtureStream = stream ?? undefined;
        }
      });
      Object.defineProperty(HTMLMediaElement.prototype, "play", {
        configurable: true,
        value: async () => undefined
      });
      Object.defineProperty(HTMLMediaElement.prototype, "pause", {
        configurable: true,
        value: () => undefined
      });
      Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
        configurable: true,
        get: () => 1_280
      });
      Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
        configurable: true,
        get: () => 720
      });
      Object.defineProperty(
        HTMLVideoElement.prototype,
        "requestVideoFrameCallback",
        {
          configurable: true,
          value(callback: VideoFrameRequestCallback) {
            callbackId += 1;
            const id = callbackId;
            const timer = window.setTimeout(() => {
              callbackTimers.delete(id);
              const now = performance.now();
              callback(now, {
                expectedDisplayTime: now,
                presentationTime: now,
                width: 1_280,
                height: 720,
                mediaTime: now / 1_000,
                presentedFrames: id,
                processingDuration: 0
              });
            }, 40);
            callbackTimers.set(id, timer);
            return id;
          }
        }
      );
      Object.defineProperty(
        HTMLVideoElement.prototype,
        "cancelVideoFrameCallback",
        {
          configurable: true,
          value(id: number) {
            const timer = callbackTimers.get(id);
            if (timer !== undefined) window.clearTimeout(timer);
            callbackTimers.delete(id);
          }
        }
      );
      Object.defineProperty(window, "createImageBitmap", {
        configurable: true,
        value: async () => ({ close() {} })
      });
    }

    function audioNode(): AudioNode {
      return {
        connect() {
          return this;
        },
        disconnect() {}
      } as unknown as AudioNode;
    }

    class AudioContextMock {
      readonly sampleRate = 48_000;
      readonly currentTime = 0;
      readonly destination = audioNode();
      readonly audioWorklet = { addModule: async () => undefined };
      state: AudioContextState = "running";

      createMediaStreamSource(): MediaStreamAudioSourceNode {
        return audioNode() as MediaStreamAudioSourceNode;
      }

      createGain(): GainNode {
        return Object.assign(audioNode(), { gain: { value: 1 } }) as GainNode;
      }

      async close(): Promise<void> {
        if (this.state !== "closed") {
          this.state = "closed";
          probe.audioContextsClosed += 1;
        }
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: AudioContextMock
    });

    class AudioWorkletNodeMock {
      readonly port = { postMessage() {} };
      connect(): AudioNode {
        return audioNode();
      }
      disconnect(): void {}
    }
    Object.defineProperty(window, "AudioWorkletNode", {
      configurable: true,
      value: AudioWorkletNodeMock
    });

    const workerVersion = "phenometric.voice-worker-message.v1";
    const diagnostics = {
      receivedBlockCount: 0,
      droppedBlockCount: 0,
      processedWindowCount: 0,
      emittedFrameCount: 0,
      maximumRingBufferSamples: 96_000
    };

    class WorkerMock extends EventTarget {
      readonly scriptUrl: string;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      private timers: number[] = [];

      constructor(scriptUrl: URL | string) {
        super();
        this.scriptUrl = String(scriptUrl);
      }

      private emit(data: unknown): void {
        const event = new MessageEvent("message", { data });
        this.dispatchEvent(event);
        this.onmessage?.(event);
      }

      private schedule(callback: () => void, delayMs: number): void {
        this.timers.push(window.setTimeout(callback, delayMs));
      }

      postMessage(message: {
        type?: string;
        captureEpoch?: number;
        taskContext?: string;
        sequence?: number;
        tMs?: number;
        acquiredAtMs?: number;
        width?: number;
        height?: number;
        stream?: unknown;
        bitmap?: { close(): void };
        videoCaptureSettings?: unknown;
      }): void {
        const captureEpoch = message.captureEpoch ?? 0;
        if (this.scriptUrl.includes("face-worker")) {
          if (message.type === "attach-overlay") {
            this.schedule(() => this.emit({
              schemaVersion: "phenometric.visual-worker-message.v2",
              type: "overlay-status",
              captureEpoch,
              attached: true
            }), 0);
          } else if (message.type === "initialize") {
            this.emit({
              schemaVersion: "phenometric.visual-worker-message.v2",
              type: "ready",
              captureEpoch,
              provenance: {
                processorRef: "mediapipe-face-landmarker:0.10.35:fixture:bilateral-geometry-v2:cpu",
                runtime: "mediapipe-tasks-vision",
                mediaPipeVersion: "0.10.35",
                modelAsset: "models/face_landmarker.task",
                modelSha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
                delegate: "CPU",
                geometryVersion: "bilateral-geometry-v2"
              },
              videoCaptureSettings: message.videoCaptureSettings
            });
          } else if (message.type === "frame") {
            const acquiredAtMs = message.acquiredAtMs ?? performance.now();
            const tMs = message.tMs ?? 0;
            message.bitmap?.close();
            this.schedule(() => this.emit({
              schemaVersion: "phenometric.visual-worker-message.v2",
              type: "frame",
              captureEpoch,
              sequence: message.sequence ?? 1,
              acquiredAtMs,
              faceCount: 1,
              boundingBox: {
                x: 0.35,
                y: 0.2,
                width: 0.3,
                height: 0.5,
                widthPixels: 384,
                heightPixels: 360,
                edgeMarginFraction: 0.1
              },
              stream: message.stream,
              frame: {
                schemaVersion: "phenometric.facial-kinematics-frame.v1",
                tMs,
                acquiredAtMs,
                sequence: message.sequence ?? 1,
                captureEpoch,
                taskContext: message.taskContext ?? "ambient-frontal",
                faceCount: 1,
                trackSegmentId: `face-${captureEpoch}`,
                faceVisible: true,
                boundingBox: {
                  x: 0.35,
                  y: 0.2,
                  width: 0.3,
                  height: 0.5,
                  widthPixels: 384,
                  heightPixels: 360,
                  edgeMarginFraction: 0.1
                },
                anatomicalLaterality: "subject-anatomical",
                pose: { yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 },
                eyeAperture: { left: 0.3, right: 0.3 },
                mouthCorners: {
                  left: { x: 0.3, y: 0.1 },
                  right: { x: -0.3, y: 0.1 }
                },
                mouthApertureRatio: 0.08,
                regionalMovementSpeed: 0.02,
                imageQuality: {
                  illuminationMean: 0.55,
                  darkClippingFraction: 0.02,
                  brightClippingFraction: 0.02,
                  sharpness: 0.002
                },
                analyzedFrameRate: 25,
                interResultGapMs: 40,
                skippedFrameFraction: 0,
                processingLatencyMs: 4,
                qualityReasons: [],
                processorRef: "mediapipe-face-landmarker@fixture"
              }
            }), 0);
          } else if (message.type === "dispose") {
            this.emit({
              schemaVersion: "phenometric.visual-worker-message.v2",
              type: "disposed",
              captureEpoch
            });
          }
          return;
        }
        if (!this.scriptUrl.includes("voice-worker")) return;
        if (message.type === "initialize") {
          setTimeout(() => {
            this.emit({
              schemaVersion: workerVersion,
              type: "ready",
              captureEpoch,
              provenance: {
                processorRef: "browser-voice-dsp@1.0",
                runtime: "audio-worklet-voice-worker",
                workletSchemaVersion: "phenometric.voice-worklet-message.v1",
                workerSchemaVersion: workerVersion,
                signalFrameSchemaVersion: "phenometric.voice-signal-frame.v1",
                analysisWindowMs: 40,
                analysisHopMs: 10,
                ringBufferSeconds: 2,
                algorithmVersion: "voice-analysis-1.0"
              }
            });
            for (let index = 0; index <= 200; index += 1) {
              const tMs = index * 10;
              this.emit({
                schemaVersion: workerVersion,
                type: "signal-frame",
                captureEpoch,
                processingLatencyMs: 1,
                frame: {
                  schemaVersion: "phenometric.voice-signal-frame.v1",
                  tMs,
                  acquiredAtMs: tMs,
                  captureEpoch,
                  sequence: index + 1,
                  absoluteSampleIndex: tMs * 48,
                  taskContext: "quiet-calibration",
                  speechActive: false,
                  periodic: false,
                  trackSegmentId: `audio-${captureEpoch}`,
                  rms: 0.0002,
                  f0Hz: null,
                  f0Confidence: 0,
                  estimatorAgreement: 0,
                  syllabicNucleus: false,
                  clippedSampleFraction: 0,
                  dcOffset: 0,
                  snrDb: 0,
                  sampleRateHz: 48_000,
                  blockGapMs: 10,
                  lostBlockFraction: 0,
                  browserProcessing: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                  },
                  qualityReasons: [],
                  processorRef: "browser-voice-dsp@1.0"
                }
              });
            }
          }, 0);
        } else if (message.type === "set-task") {
          const emitAmbientFrame = (
            index: number,
            values: {
              speechActive: boolean;
              periodic: boolean;
              rms: number;
              f0Hz: number | null;
            }
          ) => {
            const tMs = 2_010 + index * 10;
            this.emit({
              schemaVersion: workerVersion,
              type: "signal-frame",
              captureEpoch,
              processingLatencyMs: 1,
              frame: {
                schemaVersion: "phenometric.voice-signal-frame.v1",
                tMs,
                acquiredAtMs: tMs,
                captureEpoch,
                sequence: 202 + index,
                absoluteSampleIndex: tMs * 48,
                taskContext: "ambient-speech-turn",
                speechActive: values.speechActive,
                periodic: values.periodic,
                trackSegmentId: `audio-${captureEpoch}`,
                rms: values.rms,
                f0Hz: values.f0Hz,
                f0Confidence: values.periodic ? 0.91 : 0,
                estimatorAgreement: values.periodic ? 0.88 : 0,
                syllabicNucleus: false,
                clippedSampleFraction: 0,
                dcOffset: 0,
                snrDb: values.speechActive ? 24 : 4,
                sampleRateHz: 48_000,
                blockGapMs: 10,
                lostBlockFraction: 0,
                browserProcessing: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false
                },
                qualityReasons: [],
                processorRef: "browser-voice-dsp@1.0"
              }
            });
          };
          this.schedule(() => emitAmbientFrame(0, {
            speechActive: false,
            periodic: false,
            rms: 0.002,
            f0Hz: null
          }), 0);
          this.schedule(() => emitAmbientFrame(1, {
            speechActive: true,
            periodic: false,
            rms: 0.04,
            f0Hz: null
          }), 400);
          this.schedule(() => emitAmbientFrame(2, {
            speechActive: true,
            periodic: true,
            rms: 0.08,
            f0Hz: 182
          }), 800);
          this.schedule(() => {
            for (let index = 3; index < 853; index += 1) {
              emitAmbientFrame(index, {
                speechActive: true,
                periodic: true,
                rms: 0.08,
                f0Hz: 182 + Math.sin(index / 10) * 3
              });
            }
          }, 1_000);
        } else if (message.type === "dispose") {
          this.timers.forEach((timer) => window.clearTimeout(timer));
          this.timers = [];
          this.emit({
            schemaVersion: workerVersion,
            type: "disposed",
            captureEpoch,
            diagnostics
          });
        }
      }

      terminate(): void {
        this.timers.forEach((timer) => window.clearTimeout(timer));
        this.timers = [];
        probe.workersTerminated += 1;
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: WorkerMock
    });
  }, mode);
}

export async function ambientProbe(page: Page): Promise<AmbientBrowserProbe> {
  return page.evaluate(() => {
    const browserWindow = window as Window & {
      __ambientTestProbe?: AmbientBrowserProbe;
    };
    if (!browserWindow.__ambientTestProbe) {
      throw new Error("Ambient browser probe is unavailable.");
    }
    const probe = browserWindow.__ambientTestProbe;
    return {
      trackStops: probe.trackStops,
      audioContextsClosed: probe.audioContextsClosed,
      workersTerminated: probe.workersTerminated,
      resolveLateAudio() {}
    };
  });
}

export async function resolveLateAudio(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as Window & {
      __ambientTestProbe?: AmbientBrowserProbe;
    };
    browserWindow.__ambientTestProbe?.resolveLateAudio();
  });
}
