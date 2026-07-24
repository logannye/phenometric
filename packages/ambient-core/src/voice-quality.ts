import type {
  AudioQualityReasonCode,
  BrowserAudioProcessingState
} from "@phenometrix/contracts";
import type { VoiceSignalFrameV1 } from "./primitives.js";

export const VOICE_GENERAL_SNR_FLOOR_DB = 15;
export const VOICE_FINE_ACOUSTIC_SNR_FLOOR_DB = 20;
export const VOICE_MINIMUM_SAMPLE_RATE_HZ = 44_100;
export const VOICE_MAXIMUM_BLOCK_GAP_MS = 40;
export const VOICE_MAXIMUM_LOST_BLOCK_FRACTION = 0.05;
export const VOICE_MAXIMUM_CLIPPED_SAMPLE_FRACTION = 0.01;
export const VOICE_MAXIMUM_ABSOLUTE_DC_OFFSET = 0.02;
export const VOICE_MINIMUM_SIGNAL_RMS = 0.003;

export interface VoiceQualityAssessment {
  timingUsable: boolean;
  generalMeasurementUsable: boolean;
  fineAcousticUsable: boolean;
  reasonCodes: AudioQualityReasonCode[];
}

export function browserAudioProcessingEnabled(
  state: BrowserAudioProcessingState
): boolean {
  return (
    state.echoCancellation ||
    state.noiseSuppression ||
    state.autoGainControl
  );
}

export function evaluateVoiceQuality(
  frame: VoiceSignalFrameV1
): VoiceQualityAssessment {
  const reasons = new Set<AudioQualityReasonCode>(
    frame.qualityReasons
  );
  if (frame.blockGapMs > VOICE_MAXIMUM_BLOCK_GAP_MS) {
    reasons.add("audio-frame-gap");
  }
  if (
    frame.lostBlockFraction >
    VOICE_MAXIMUM_LOST_BLOCK_FRACTION
  ) {
    reasons.add("audio-frame-gap");
  }
  if (frame.sampleRateHz < VOICE_MINIMUM_SAMPLE_RATE_HZ) {
    reasons.add("sample-rate-below-minimum");
  }
  if (
    browserAudioProcessingEnabled(frame.browserProcessing)
  ) {
    reasons.add("audio-processing-enabled");
  }
  if (frame.snrDb < VOICE_GENERAL_SNR_FLOOR_DB) {
    reasons.add("snr-below-minimum");
  }
  if (frame.rms < VOICE_MINIMUM_SIGNAL_RMS) {
    reasons.add("signal-too-quiet");
  }
  if (
    frame.clippedSampleFraction >
    VOICE_MAXIMUM_CLIPPED_SAMPLE_FRACTION
  ) {
    reasons.add("audio-clipping");
  }
  if (
    Math.abs(frame.dcOffset) >
    VOICE_MAXIMUM_ABSOLUTE_DC_OFFSET
  ) {
    reasons.add("dc-offset");
  }

  const reasonCodes = [...reasons];
  const timingBlockers = new Set<AudioQualityReasonCode>([
    "microphone-unavailable",
    "audio-worklet-unavailable",
    "audio-frame-gap",
    "signal-too-quiet",
    "audio-clipping",
    "voice-worker-unavailable"
  ]);
  const generalBlockers = new Set<AudioQualityReasonCode>([
    ...timingBlockers,
    "snr-below-minimum",
    "dc-offset"
  ]);
  const fineBlockers = new Set<AudioQualityReasonCode>([
    ...generalBlockers,
    "sample-rate-below-minimum",
    "audio-processing-enabled"
  ]);
  if (frame.snrDb < VOICE_FINE_ACOUSTIC_SNR_FLOOR_DB) {
    fineBlockers.add("snr-below-minimum");
  }

  return {
    timingUsable: !reasonCodes.some((reason) =>
      timingBlockers.has(reason)
    ),
    generalMeasurementUsable: !reasonCodes.some((reason) =>
      generalBlockers.has(reason)
    ),
    fineAcousticUsable:
      frame.snrDb >= VOICE_FINE_ACOUSTIC_SNR_FLOOR_DB &&
      !reasonCodes.some((reason) => fineBlockers.has(reason)),
    reasonCodes
  };
}
