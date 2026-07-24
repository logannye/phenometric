import type {
  AudioCaptureSettings,
  AudioPipelineProvenance,
  AudioStreamDiagnostics,
  BrowserAudioProcessingState,
  VoiceTaskContext
} from "@phenometric/contracts";
import type { VoiceSignalFrameV1 } from "@phenometric/ambient-core";

export const VOICE_WORKER_MESSAGE_VERSION =
  "phenometric.voice-worker-message.v1" as const;
export const VOICE_SIGNAL_FRAME_VERSION =
  "phenometric.voice-signal-frame.v1" as const;
export const VOICE_WORKLET_MESSAGE_VERSION =
  "phenometric.voice-worklet-message.v1" as const;
/*
 * 1.1: the pitch path decimates through an anti-aliased filter instead of a
 * boxcar average, band energies come from one windowed FFT instead of a
 * rectangular-window direct evaluation, and cepstral peak prominence is
 * measured. Pitch values shift slightly as a result, so sessions analysed
 * under 1.0 and 1.1 are not interchangeable.
 *
 * The frame schema version stays v1: the new fields are optional additions, so
 * the shape is still compatible. What changed is the values, and that is what
 * the algorithm and processor versions exist to say. They are separate for
 * exactly this reason.
 */
export const VOICE_DSP_ALGORITHM_VERSION =
  "voice-analysis-1.1" as const;
export const VOICE_DSP_PROCESSOR_REF =
  "browser-voice-dsp@1.1" as const;
export type VoiceWorkerRequest =
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "initialize";
      captureEpoch: number;
      port: MessagePort;
      sessionOriginPerformanceMs: number;
      audioContextOriginSeconds: number;
      captureSettings: AudioCaptureSettings;
      taskContext: VoiceTaskContext;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "set-task";
      captureEpoch: number;
      taskContext: VoiceTaskContext;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "set-noise-floor";
      captureEpoch: number;
      noiseFloorRms: number;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "reset";
      captureEpoch: number;
      taskContext: VoiceTaskContext;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "dispose";
      captureEpoch: number;
    }
  ;

export type VoiceWorkerResponse =
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "ready";
      captureEpoch: number;
      provenance: AudioPipelineProvenance;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "signal-frame";
      captureEpoch: number;
      frame: VoiceSignalFrameV1;
      processingLatencyMs: number;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "diagnostics";
      captureEpoch: number;
      diagnostics: AudioStreamDiagnostics;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "disposed";
      captureEpoch: number;
      diagnostics: AudioStreamDiagnostics;
    }
  | {
      schemaVersion: typeof VOICE_WORKER_MESSAGE_VERSION;
      type: "error";
      captureEpoch: number;
      reason: string;
    }
  ;

export interface VoiceWorkletPcmBlock {
  schemaVersion: typeof VOICE_WORKLET_MESSAGE_VERSION;
  type: "pcm-block";
  captureEpoch: number;
  sequence: number;
  absoluteSampleIndex: number;
  acquisitionAudioTimeSeconds: number;
  sampleRateHz: number;
  channelCount: 1;
  buffer: ArrayBuffer;
}

export function isCurrentVoiceWorkerResponse(
  value: unknown,
  captureEpoch: number
): value is VoiceWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    schemaVersion?: unknown;
    captureEpoch?: unknown;
  };
  return (
    candidate.schemaVersion === VOICE_WORKER_MESSAGE_VERSION &&
    candidate.captureEpoch === captureEpoch
  );
}

export function audioPipelineProvenance(): AudioPipelineProvenance {
  return {
    processorRef: VOICE_DSP_PROCESSOR_REF,
    runtime: "audio-worklet-voice-worker",
    workletSchemaVersion: VOICE_WORKLET_MESSAGE_VERSION,
    workerSchemaVersion: VOICE_WORKER_MESSAGE_VERSION,
    signalFrameSchemaVersion: VOICE_SIGNAL_FRAME_VERSION,
    analysisWindowMs: 40,
    analysisHopMs: 10,
    ringBufferSeconds: 2,
    algorithmVersion: VOICE_DSP_ALGORITHM_VERSION
  };
}

export function requestedAudioCaptureSettings(
  sampleRate: number,
  channelCount: number,
  browserProcessing: BrowserAudioProcessingState
): AudioCaptureSettings {
  return {
    requested: {
      channelCount: 1,
      sampleRate: 48_000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    actual: {
      channelCount,
      sampleRate,
      browserProcessing: { ...browserProcessing }
    }
  };
}
