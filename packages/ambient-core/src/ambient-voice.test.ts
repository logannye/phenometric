import { describe, expect, it } from "vitest";
import { syntheticVoiceFrame } from "./test-helpers.js";
import type {
  AmbientVoiceExtractionOptions,
  AmbientVoiceFrame
} from "./ambient-types.js";
import { extractAmbientVoiceMetrics } from "./ambient-voice.js";

const OPTIONS: AmbientVoiceExtractionOptions = {
  sessionId: "ambient-session-voice",
  protocolVersion: "1.0.0",
  protocolContentSha256: "voice-protocol-digest",
  sessionStartedAtMs: 0,
  noiseCalibrationDurationMs: 2_000
};

function ambientVoiceFrames(
  durationMs = 30_000,
  stepMs = 10,
  override: (
    frame: AmbientVoiceFrame,
    index: number
  ) => Partial<AmbientVoiceFrame> = () => ({})
): AmbientVoiceFrame[] {
  return Array.from(
    { length: Math.floor(durationMs / stepMs) },
    (_, index) => {
      const tMs = index * stepMs;
      const speechActive = tMs % 2_500 < 2_000;
      const frame: AmbientVoiceFrame = {
        ...syntheticVoiceFrame(tMs, {
          taskContext: "ambient-speech-turn",
          snrDb: speechActive ? 26 : 0,
          rms: speechActive ? 0.08 : 0.0002,
          f0Hz: speechActive
            ? 150 + Math.sin(tMs / 175) * 8
            : null,
          f0Confidence: speechActive ? 0.9 : 0,
          estimatorAgreement: speechActive ? 0.9 : 0,
          syllabicNucleus: speechActive && tMs % 500 === 0,
          blockGapMs: stepMs,
          qualityReasons: speechActive ? [] : ["signal-too-quiet"]
        }),
        speechActive,
        periodic: speechActive,
        trackSegmentId: "local-microphone-1"
      };
      return { ...frame, ...override(frame, index) };
    }
  );
}

function byCode(
  frames: readonly AmbientVoiceFrame[],
  code: string,
  options = OPTIONS
) {
  return extractAmbientVoiceMetrics(frames, options).outcomes.find(
    (outcome) => outcome.code === code
  );
}

describe("extractAmbientVoiceMetrics", () => {
  it("emits exactly the bounded seven-metric catalog", () => {
    const result = extractAmbientVoiceMetrics(ambientVoiceFrames(), OPTIONS);

    expect(result.outcomes).toHaveLength(7);
    expect(result.outcomes.map((outcome) => outcome.code)).toEqual([
      "ambient.voice.f0.median",
      "ambient.voice.f0.variability",
      "ambient.voice.speech_activity_fraction",
      "ambient.voice.pause_rate",
      "ambient.voice.pause_duration.median",
      "ambient.voice.speech_run_duration.median",
      "ambient.voice.acoustic_nucleus_rate"
    ]);
    expect(result.outcomes.every((outcome) => outcome.status === "measured"))
      .toBe(true);
  });

  it("includes the final analysis hop in source-window bounds", () => {
    const result = extractAmbientVoiceMetrics(
      ambientVoiceFrames(2_000, 10, () => ({
        speechActive: true,
        periodic: true,
        qualityReasons: []
      })),
      OPTIONS
    );
    expect(result.outcomes[0].evidence.sourceWindowRefs[0]).toBe(
      "voice:1:local-microphone-1:0:2000"
    );
  });

  it("retains qualified quiet frames for pauses", () => {
    const frames = ambientVoiceFrames();
    const activity = byCode(
      frames,
      "ambient.voice.speech_activity_fraction"
    );
    const pauses = byCode(frames, "ambient.voice.pause_rate");
    const medianPause = byCode(
      frames,
      "ambient.voice.pause_duration.median"
    );

    expect(activity).toMatchObject({ status: "measured" });
    if (activity?.status === "measured") {
      expect(activity.value).toBeCloseTo(0.8, 2);
    }
    expect(pauses).toMatchObject({
      status: "measured",
      evidence: { pauseCount: 9 }
    });
    expect(medianPause).toMatchObject({ status: "measured" });
    if (medianPause?.status === "measured") {
      expect(medianPause.value).toBeCloseTo(0.5, 2);
    }
  });

  it("allows a valid zero pause rate only after the full timing denominator qualifies", () => {
    const frames = ambientVoiceFrames(30_000, 10, (frame) => ({
      speechActive: true,
      periodic: true,
      snrDb: 26,
      rms: 0.08,
      f0Hz: 160,
      f0Confidence: 0.9,
      estimatorAgreement: 0.9,
      qualityReasons: [],
      syllabicNucleus: frame.tMs % 500 === 0
    }));

    const pauseRate = byCode(frames, "ambient.voice.pause_rate");
    const pauseDuration = byCode(
      frames,
      "ambient.voice.pause_duration.median"
    );

    expect(pauseRate).toMatchObject({ status: "measured", value: 0 });
    expect(pauseDuration).toMatchObject({
      status: "withheld",
      reasonCode: "insufficient-events"
    });
  });

  it("withholds every metric rather than returning zero when no frame is usable", () => {
    const unusable = ambientVoiceFrames(30_000, 10, () => ({
      blockGapMs: 40.01
    }));
    const result = extractAmbientVoiceMetrics(unusable, OPTIONS);

    expect(result.outcomes).toHaveLength(7);
    expect(result.outcomes.every((outcome) => outcome.status === "withheld"))
      .toBe(true);
    expect(
      result.outcomes.every(
        (outcome) =>
          outcome.status === "withheld" &&
          outcome.reasonCode === "no-usable-signal"
      )
    ).toBe(true);
  });

  it("measures at inclusive engineering quality boundaries", () => {
    const boundary = ambientVoiceFrames(30_000, 40, (frame) => ({
      sampleRateHz: 44_100,
      blockGapMs: 40,
      lostBlockFraction: 0.05,
      clippedSampleFraction: 0.01,
      dcOffset: 0.02,
      snrDb: frame.speechActive ? 15 : 0
    }));
    const result = extractAmbientVoiceMetrics(boundary, OPTIONS);

    expect(
      result.outcomes.find(
        (outcome) =>
          outcome.code === "ambient.voice.speech_activity_fraction"
      )
    ).toMatchObject({ status: "measured" });
  });

  it("withholds pitch independently while preserving qualified timing", () => {
    const aperiodic = ambientVoiceFrames(30_000, 10, () => ({
      periodic: false,
      f0Hz: null,
      f0Confidence: 0,
      estimatorAgreement: 0
    }));
    const result = extractAmbientVoiceMetrics(aperiodic, OPTIONS);

    expect(result.outcomes.slice(0, 2)).toEqual([
      expect.objectContaining({
        status: "withheld",
        reasonCode: "insufficient-pitched-speech"
      }),
      expect.objectContaining({
        status: "withheld",
        reasonCode: "insufficient-pitched-speech"
      })
    ]);
    expect(result.outcomes.slice(2).every((outcome) => outcome.status === "measured"))
      .toBe(true);
  });

  it("requires two seconds of quiet calibration", () => {
    const result = extractAmbientVoiceMetrics(ambientVoiceFrames(), {
      ...OPTIONS,
      noiseCalibrationDurationMs: 1_999
    });

    expect(
      result.outcomes.every(
        (outcome) =>
          outcome.status === "withheld" &&
          outcome.reasonCode === "quality-threshold-failed"
      )
    ).toBe(true);
  });

  it("produces deterministic, context-and-provenance-bound identities", () => {
    const first = extractAmbientVoiceMetrics(ambientVoiceFrames(), OPTIONS);
    const second = extractAmbientVoiceMetrics(ambientVoiceFrames(), OPTIONS);

    expect(first.outcomes.map((outcome) => outcome.identity.outcomeId)).toEqual(
      second.outcomes.map((outcome) => outcome.identity.outcomeId)
    );
    expect(new Set(first.outcomes.map((outcome) => outcome.identity.outcomeId)).size)
      .toBe(7);
    expect(first.outcomes[0].identity).toMatchObject({
      context: "ambient-speech-turn",
      processorRefs: ["browser-voice-dsp@1.0"],
      trackSegmentIds: ["local-microphone-1"]
    });
  });

  it("fails closed when eligible audio crosses an input track", () => {
    const frames = ambientVoiceFrames(30_000, 10, (frame) => ({
      trackSegmentId:
        frame.tMs < 20_000 ? "local-microphone-1" : "local-microphone-2"
    }));
    const result = extractAmbientVoiceMetrics(frames, OPTIONS);

    expect(
      result.outcomes.every(
        (outcome) =>
          outcome.status === "withheld" &&
          outcome.reasonCode === "quality-threshold-failed"
      )
    ).toBe(true);
  });

  it("ignores samples beyond the five-minute capture bound", () => {
    const frames = [
      ...ambientVoiceFrames(),
      {
        ...ambientVoiceFrames(10)[0],
        tMs: 300_000,
        acquiredAtMs: 300_000
      }
    ];
    const result = extractAmbientVoiceMetrics(frames, OPTIONS);

    expect(result.ignoredFrameCount).toBe(1);
  });
});

describe("pause and speech-run events", () => {
  it("records every pause, including ones the published metrics filter out", () => {
    // The duration metrics keep only pauses in [200, 1999] ms and drop the
    // leading and trailing quiet. Those exclusions are correct for a median but
    // wrong for a record: a pause that was filtered away is indistinguishable
    // from one that never happened.
    const result = extractAmbientVoiceMetrics(ambientVoiceFrames(), OPTIONS);
    const pauses = result.events?.pauses ?? [];
    expect(pauses.length).toBeGreaterThan(0);
    for (const pause of pauses) {
      expect(pause.endMs).toBeGreaterThanOrEqual(pause.startMs);
      expect(["breath", "hesitation", "truncated"]).toContain(pause.kind);
    }
    // Window-bounded quiet is retained under its own kind rather than dropped.
    expect(pauses.some((pause) => pause.kind === "truncated")).toBe(true);
  });

  it("records speech runs with phonated time separated from duration", () => {
    // A run can be long while little of it is voiced; the ratio is a different
    // quantity from either, and neither is recoverable from a median duration.
    const result = extractAmbientVoiceMetrics(ambientVoiceFrames(), OPTIONS);
    const runs = result.events?.speechRuns ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.durationMs).toBeGreaterThan(0);
      expect(run.phonatedMs).toBeLessThanOrEqual(run.durationMs);
      expect(run.peakIntensity).toBeGreaterThanOrEqual(run.meanIntensity);
    }
  });

  it("leaves the published pause metrics untouched by the split", () => {
    // The rewrite must not move an existing number. The filtered durations are
    // computed exactly as before, alongside the unfiltered records.
    const outcome = extractAmbientVoiceMetrics(
      ambientVoiceFrames(),
      OPTIONS
    ).outcomes.find((candidate) => candidate.code === "ambient.voice.pause_rate");
    expect(outcome?.status).toBe("measured");
    expect(outcome?.evidence.pauseCount).toBeGreaterThan(0);
  });
});
