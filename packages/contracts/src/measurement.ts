export type AudioQualityReasonCode =
  | "microphone-unavailable"
  | "audio-worklet-unavailable"
  | "audio-frame-gap"
  | "sample-rate-below-minimum"
  | "audio-processing-enabled"
  | "snr-below-minimum"
  | "signal-too-quiet"
  | "audio-clipping"
  | "dc-offset"
  | "task-not-observed"
  | "voice-worker-unavailable";

export interface BrowserAudioProcessingState {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}
