/// <reference lib="webworker" />

import type {
  AudioStreamDiagnostics,
  VoiceTaskContext
} from "@phenometrix/contracts";
import {
  evaluateVoiceQuality,
  type AmbientVoiceFrame
} from "@phenometrix/ambient-core";
import {
  BoundedPcmRingBuffer,
  analyzeVoiceWindow
} from "./voice-dsp.js";
import {
  VOICE_DSP_PROCESSOR_REF,
  VOICE_SIGNAL_FRAME_VERSION,
  VOICE_WORKER_MESSAGE_VERSION,
  VOICE_WORKLET_MESSAGE_VERSION,
  audioPipelineProvenance,
  type VoiceWorkerRequest,
  type VoiceWorkerResponse,
  type VoiceWorkletPcmBlock
} from "./voice-worker-protocol.js";

const worker = self as DedicatedWorkerGlobalScope;

let captureEpoch = 0;
let port: MessagePort | null = null;
let ring: BoundedPcmRingBuffer | null = null;
let sampleRateHz = 48_000;
let taskContext: VoiceTaskContext = "quiet-calibration";
let sessionOriginPerformanceMs = 0;
let audioContextOriginSeconds = 0;
let browserProcessing = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
};
let noiseFloorRms = 0.002;
let lastBlockSequence = 0;
let lastAbsoluteSampleIndex = 0;
let lastBlockAcquiredAtMs: number | null = null;
let nextAnalysisSampleIndex = 0;
let processedFrameCount = 0;
let receivedBlockCount = 0;
let lostBlockCount = 0;
let maximumBlockGapMs = 0;
let currentBlockGapMs = 0;
let timestampRegressionCount = 0;
let priorBands: readonly number[] | null = null;
let lastNucleusAtMs = Number.NEGATIVE_INFINITY;
let priorNucleusScore = 0;
const latencyValues: number[] = [];
const recentBlockContinuity: Array<{
  atMs: number;
  received: number;
  lost: number;
}> = [];

function post(message: VoiceWorkerResponse): void {
  worker.postMessage(message);
}

function diagnostics(): AudioStreamDiagnostics {
  const sortedLatency = [...latencyValues].sort(
    (left, right) => left - right
  );
  return {
    receivedBlockCount,
    processedFrameCount,
    lostBlockCount,
    lostBlockFraction:
      lostBlockCount /
      Math.max(1, receivedBlockCount + lostBlockCount),
    maximumBlockGapMs,
    p95FeatureLatencyMs:
      sortedLatency.length === 0
        ? 0
        : sortedLatency[
            Math.min(
              sortedLatency.length - 1,
              Math.floor(sortedLatency.length * 0.95)
            )
          ],
    timestampRegressionCount,
    ringBufferCapacitySamples: ring?.capacity ?? 0
  };
}

function reset(epoch: number): void {
  captureEpoch = epoch;
  ring?.clear();
  lastBlockSequence = 0;
  lastAbsoluteSampleIndex = 0;
  lastBlockAcquiredAtMs = null;
  nextAnalysisSampleIndex = 0;
  processedFrameCount = 0;
  receivedBlockCount = 0;
  lostBlockCount = 0;
  maximumBlockGapMs = 0;
  currentBlockGapMs = 0;
  timestampRegressionCount = 0;
  priorBands = null;
  lastNucleusAtMs = Number.NEGATIVE_INFINITY;
  priorNucleusScore = 0;
  latencyValues.length = 0;
  recentBlockContinuity.length = 0;
}

function acquiredAtMs(block: VoiceWorkletPcmBlock): number {
  return (
    sessionOriginPerformanceMs +
    (block.acquisitionAudioTimeSeconds -
      audioContextOriginSeconds) *
      1000
  );
}

function analyzeAvailable(block: VoiceWorkletPcmBlock): void {
  if (!ring) return;
  const windowSamples = Math.round(sampleRateHz * 0.04);
  const hopSamples = Math.round(sampleRateHz * 0.01);
  const absoluteEnd =
    block.absoluteSampleIndex +
    new Float32Array(block.buffer).length;
  if (nextAnalysisSampleIndex === 0) {
    nextAnalysisSampleIndex =
      block.absoluteSampleIndex + windowSamples;
  }
  while (
    absoluteEnd >= nextAnalysisSampleIndex &&
    ring.availableSamples() >= windowSamples
  ) {
    const trailingSampleCount = Math.max(
      0,
      absoluteEnd - nextAnalysisSampleIndex
    );
    const samples = ring.endingBeforeLatest(
      windowSamples,
      trailingSampleCount
    );
    if (!samples) break;
    const startedAt = performance.now();
    const analysis = analyzeVoiceWindow(
      samples,
      sampleRateHz,
      priorBands
    );
    const tMs =
      ((nextAnalysisSampleIndex - windowSamples) / sampleRateHz) *
      1000;
    const snrDb =
      analysis.rms <= 0
        ? 0
        : Math.max(
            0,
            20 *
              Math.log10(
                analysis.rms / Math.max(0.0001, noiseFloorRms)
              )
          );
    const continuityFloorMs = acquiredAtMs(block) - 2_000;
    while (
      recentBlockContinuity.length > 0 &&
      recentBlockContinuity[0].atMs < continuityFloorMs
    ) {
      recentBlockContinuity.shift();
    }
    const recentReceived = recentBlockContinuity.reduce(
      (sum, item) => sum + item.received,
      0
    );
    const recentLost = recentBlockContinuity.reduce(
      (sum, item) => sum + item.lost,
      0
    );
    const lostBlockFraction =
      recentLost / Math.max(1, recentReceived + recentLost);
    const blockGapMs = currentBlockGapMs;
    const frameAcquiredAtMs =
      acquiredAtMs(block) -
      (trailingSampleCount / sampleRateHz) * 1_000;
    const periodic =
      analysis.f0Hz !== null &&
      analysis.f0Confidence >= 0.55 &&
      analysis.estimatorAgreement >= 0.7;
    const speechActive =
      analysis.rms >= Math.max(0.003, noiseFloorRms * 2.8) &&
      (periodic ||
        (analysis.spectralFlux > 0.02 &&
          analysis.rms >= noiseFloorRms * 4));
    const nucleusScore =
      analysis.rms * (1 + Math.min(2, analysis.spectralFlux * 20));
    const syllabicNucleus =
      speechActive &&
      tMs - lastNucleusAtMs >= 100 &&
      nucleusScore > Math.max(0.012, priorNucleusScore * 1.15);
    if (syllabicNucleus) lastNucleusAtMs = tMs;
    priorNucleusScore =
      0.7 * priorNucleusScore + 0.3 * nucleusScore;
    priorBands = analysis.bandEnergies;
    processedFrameCount += 1;
    const frame: AmbientVoiceFrame = {
      schemaVersion: VOICE_SIGNAL_FRAME_VERSION,
      tMs,
      acquiredAtMs: frameAcquiredAtMs,
      captureEpoch,
      sequence: processedFrameCount,
      absoluteSampleIndex:
        nextAnalysisSampleIndex - windowSamples,
      taskContext,
      speechActive,
      periodic,
      trackSegmentId: `audio-${captureEpoch}`,
      rms: analysis.rms,
      f0Hz: analysis.f0Hz,
      f0Confidence: analysis.f0Confidence,
      estimatorAgreement: analysis.estimatorAgreement,
      spectralFlux: analysis.spectralFlux,
      cepstralPeakProminenceDb: analysis.cepstralPeakProminenceDb,
      syllabicNucleus,
      clippedSampleFraction: analysis.clippedSampleFraction,
      dcOffset: analysis.dcOffset,
      snrDb,
      sampleRateHz,
      blockGapMs,
      lostBlockFraction,
      browserProcessing: { ...browserProcessing },
      qualityReasons: [],
      processorRef: VOICE_DSP_PROCESSOR_REF
    };
    frame.qualityReasons =
      evaluateVoiceQuality(frame).reasonCodes;
    const processingLatencyMs = Math.max(
      performance.now() - startedAt,
      performance.now() - frameAcquiredAtMs
    );
    latencyValues.push(processingLatencyMs);
    if (latencyValues.length > 500) latencyValues.shift();
    post({
      schemaVersion: VOICE_WORKER_MESSAGE_VERSION,
      type: "signal-frame",
      captureEpoch,
      frame,
      processingLatencyMs
    });
    if (processedFrameCount % 100 === 0) {
      post({
        schemaVersion: VOICE_WORKER_MESSAGE_VERSION,
        type: "diagnostics",
        captureEpoch,
        diagnostics: diagnostics()
      });
    }
    nextAnalysisSampleIndex += hopSamples;
  }
}

function handleBlock(event: MessageEvent<unknown>): void {
  const block = event.data as VoiceWorkletPcmBlock;
  if (
    block?.schemaVersion !== VOICE_WORKLET_MESSAGE_VERSION ||
    block.type !== "pcm-block" ||
    block.captureEpoch !== captureEpoch ||
    block.channelCount !== 1 ||
    !(block.buffer instanceof ArrayBuffer)
  ) {
    return;
  }
  const samples = new Float32Array(block.buffer);
  const atMs = acquiredAtMs(block);
  const recycle = (): void => {
    port?.postMessage(
      { type: "recycle", buffer: block.buffer },
      [block.buffer]
    );
  };
  if (
    (lastBlockSequence > 0 && block.sequence <= lastBlockSequence) ||
    (lastAbsoluteSampleIndex > 0 &&
      block.absoluteSampleIndex < lastAbsoluteSampleIndex)
  ) {
    timestampRegressionCount += 1;
    recycle();
    return;
  }
  if (
    lastBlockAcquiredAtMs !== null &&
    atMs < lastBlockAcquiredAtMs
  ) {
    timestampRegressionCount += 1;
  }
  const lostSincePrior =
    lastBlockSequence > 0
      ? Math.max(0, block.sequence - lastBlockSequence - 1)
      : 0;
  lostBlockCount += lostSincePrior;
  const expectedBlockMs =
    (samples.length / block.sampleRateHz) * 1000;
  const gapMs =
    lastBlockAcquiredAtMs === null
      ? 0
      : Math.max(
          0,
          atMs - lastBlockAcquiredAtMs - expectedBlockMs
        );
  maximumBlockGapMs = Math.max(maximumBlockGapMs, gapMs);
  currentBlockGapMs = gapMs;
  const sampleDiscontinuity =
    lastAbsoluteSampleIndex > 0 &&
    block.absoluteSampleIndex !== lastAbsoluteSampleIndex;
  if (lostSincePrior > 0 || sampleDiscontinuity || gapMs > 40) {
    ring?.clear();
    nextAnalysisSampleIndex = 0;
    priorBands = null;
  }
  recentBlockContinuity.push({
    atMs,
    received: 1,
    lost: lostSincePrior
  });
  lastBlockAcquiredAtMs = atMs;
  lastBlockSequence = block.sequence;
  lastAbsoluteSampleIndex =
    block.absoluteSampleIndex + samples.length;
  receivedBlockCount += 1;
  sampleRateHz = block.sampleRateHz;
  ring?.push(samples);
  analyzeAvailable(block);
  recycle();
}

worker.addEventListener("message", (event: MessageEvent<VoiceWorkerRequest>) => {
  const message = event.data;
  if (message?.schemaVersion !== VOICE_WORKER_MESSAGE_VERSION) return;
  if (message.type === "initialize") {
    port?.close();
    port = message.port;
    sessionOriginPerformanceMs = message.sessionOriginPerformanceMs;
    audioContextOriginSeconds = message.audioContextOriginSeconds;
    sampleRateHz = message.captureSettings.actual.sampleRate;
    browserProcessing = {
      ...message.captureSettings.actual.browserProcessing
    };
    taskContext = message.taskContext;
    ring = new BoundedPcmRingBuffer(
      Math.round(sampleRateHz * 2)
    );
    reset(message.captureEpoch);
    port.addEventListener("message", handleBlock);
    port.start();
    post({
      schemaVersion: VOICE_WORKER_MESSAGE_VERSION,
      type: "ready",
      captureEpoch,
      provenance: audioPipelineProvenance()
    });
    return;
  }
  if (message.type === "set-task" && message.captureEpoch === captureEpoch) {
    taskContext = message.taskContext;
    return;
  }
  if (
    message.type === "set-noise-floor" &&
    message.captureEpoch === captureEpoch &&
    Number.isFinite(message.noiseFloorRms)
  ) {
    noiseFloorRms = Math.max(0.0001, message.noiseFloorRms);
    return;
  }
  if (message.type === "reset") {
    taskContext = message.taskContext;
    reset(message.captureEpoch);
    return;
  }
  if (message.type === "dispose") {
    const finalDiagnostics = diagnostics();
    post({
      schemaVersion: VOICE_WORKER_MESSAGE_VERSION,
      type: "diagnostics",
      captureEpoch,
      diagnostics: finalDiagnostics
    });
    port?.close();
    port = null;
    ring?.clear();
    ring = null;
    post({
      schemaVersion: VOICE_WORKER_MESSAGE_VERSION,
      type: "disposed",
      captureEpoch,
      diagnostics: finalDiagnostics
    });
    worker.close();
  }
});
