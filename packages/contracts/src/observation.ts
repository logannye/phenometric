import type { BrowserAudioProcessingState } from "./measurement.js";

export interface VisualPipelineProvenance {
  processorRef: string;
  runtime: "mediapipe-tasks-vision";
  mediaPipeVersion: string;
  modelAsset: string;
  modelSha256: string;
  delegate: "GPU" | "CPU";
  geometryVersion: string;
}

export interface VideoCaptureSettings {
  requested: {
    width: number;
    height: number;
    frameRate: number;
  };
  actual: {
    width: number;
    height: number;
    frameRate: number | null;
  };
  facingMode?: string;
  coordinateSpace: "normalized-unmirrored-image";
  displayMirrored: true;
  lateralityConvention: "subject-anatomical";
}

export interface AudioCaptureSettings {
  requested: {
    channelCount: 1;
    sampleRate: 48000;
    echoCancellation: false;
    noiseSuppression: false;
    autoGainControl: false;
  };
  actual: {
    channelCount: number;
    sampleRate: number;
    browserProcessing: BrowserAudioProcessingState;
  };
}

/**
 * The window/hop/ring literals describe the pitch and VAD analysis path and are
 * pinned so a mid-stream change cannot go unnoticed. A future analysis path with
 * different framing (formants, cepstrum) declares its own provenance rather than
 * widening these.
 */
export interface AudioPipelineProvenance {
  processorRef: string;
  runtime: "audio-worklet-voice-worker";
  workletSchemaVersion: "phenometric.voice-worklet-message.v1";
  workerSchemaVersion: "phenometric.voice-worker-message.v1";
  signalFrameSchemaVersion: "phenometric.voice-signal-frame.v1";
  analysisWindowMs: 40;
  analysisHopMs: 10;
  ringBufferSeconds: 2;
  algorithmVersion: string;
}

export interface AudioStreamDiagnostics {
  receivedBlockCount: number;
  processedFrameCount: number;
  lostBlockCount: number;
  lostBlockFraction: number;
  maximumBlockGapMs: number;
  p95FeatureLatencyMs: number;
  timestampRegressionCount: number;
  ringBufferCapacitySamples: number;
}
