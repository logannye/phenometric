import { extractAmbientFaceMetrics } from "./ambient-face.js";
import { AMBIENT_METRIC_REGISTRY } from "./ambient-registry.js";
import { extractAmbientVoiceMetrics } from "./ambient-voice.js";
import type {
  AmbientExtractionResult,
  AmbientMetricOutcome,
  AmbientSessionExtractionInput
} from "./ambient-types.js";

/**
 * App-facing terminalizer for one ambient encounter. The output always has one
 * measured or withheld outcome for every registered metric, in registry order.
 */
export function finalizeAmbientMetrics(
  input: AmbientSessionExtractionInput
): AmbientExtractionResult {
  const voice = extractAmbientVoiceMetrics(input.voice.frames, {
    ...input.identity,
    noiseCalibrationDurationMs: input.voice.noiseCalibrationDurationMs
  });
  const face = extractAmbientFaceMetrics(input.face.frames, {
    ...input.identity,
    calibration: input.face.calibration
  });
  const candidates: AmbientMetricOutcome[] = [
    ...voice.outcomes,
    ...face.outcomes
  ];
  const outcomes = AMBIENT_METRIC_REGISTRY.map((definition) => {
    const matches = candidates.filter(
      (outcome) => outcome.code === definition.code
    );
    if (matches.length !== 1) {
      throw new Error(
        `Ambient finalization requires exactly one outcome for ${definition.code}; received ${matches.length}.`
      );
    }
    return matches[0];
  });
  return {
    outcomes,
    ignoredFrameCount:
      voice.ignoredFrameCount + face.ignoredFrameCount,
    events: {
      blinks: face.events?.blinks ?? [],
      expressions: face.events?.expressions ?? [],
      pauses: voice.events?.pauses ?? [],
      speechRuns: voice.events?.speechRuns ?? []
    },
    diagnostics: { face: face.diagnostics, voice: voice.diagnostics }
  };
}
