import {
  applyWindow,
  cepstralPeakProminence,
  decimate,
  hannWindow,
  powerSpectrum
} from "./dsp-primitives.js";
export interface VoiceWindowAnalysis {
  /**
   * Cepstral peak prominence in dB, or null when the window holds no measurable
   * harmonic structure. The best-validated acoustic correlate of dysphonia.
   */
  cepstralPeakProminenceDb: number | null;
  rms: number;
  dcOffset: number;
  clippedSampleFraction: number;
  f0Hz: number | null;
  f0Confidence: number;
  estimatorAgreement: number;
  spectralFlux: number;
  bandEnergies: number[];
}

export class BoundedPcmRingBuffer {
  readonly capacity: number;
  private readonly samples: Float32Array;
  private writeIndex = 0;
  private size = 0;

  constructor(capacitySamples: number) {
    if (!Number.isInteger(capacitySamples) || capacitySamples <= 0) {
      throw new Error("Ring-buffer capacity must be a positive integer.");
    }
    this.capacity = capacitySamples;
    this.samples = new Float32Array(capacitySamples);
  }

  clear(): void {
    this.samples.fill(0);
    this.writeIndex = 0;
    this.size = 0;
  }

  push(block: Float32Array): void {
    for (const sample of block) {
      this.samples[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.size = Math.min(this.capacity, this.size + 1);
    }
  }

  availableSamples(): number {
    return this.size;
  }

  latest(count: number): Float32Array | null {
    return this.endingBeforeLatest(count, 0);
  }

  endingBeforeLatest(
    count: number,
    trailingSampleCount: number
  ): Float32Array | null {
    if (
      count <= 0 ||
      trailingSampleCount < 0 ||
      count + trailingSampleCount > this.size
    ) {
      return null;
    }
    const result = new Float32Array(count);
    let index =
      (
        this.writeIndex -
        trailingSampleCount -
        count +
        this.capacity * 2
      ) % this.capacity;
    for (let offset = 0; offset < count; offset += 1) {
      result[offset] = this.samples[index];
      index = (index + 1) % this.capacity;
    }
    return result;
  }
}

export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

interface PitchCandidate {
  hz: number | null;
  confidence: number;
}

function autocorrelationPitch(
  samples: Float32Array,
  sampleRate: number
): PitchCandidate {
  const minLag = Math.max(1, Math.floor(sampleRate / 700));
  const maxLag = Math.min(
    samples.length - 2,
    Math.ceil(sampleRate / 50)
  );
  let bestLag = 0;
  let best = Number.NEGATIVE_INFINITY;
  const correlations: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let cross = 0;
    let energyA = 0;
    let energyB = 0;
    for (let index = 0; index < samples.length - lag; index += 1) {
      const a = samples[index];
      const b = samples[index + lag];
      cross += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const correlation =
      cross / Math.max(1e-12, Math.sqrt(energyA * energyB));
    correlations[lag] = correlation;
    if (correlation > best) {
      best = correlation;
      bestLag = lag;
    }
  }
  if (
    correlations[minLag] >= best * 0.92 &&
    correlations[minLag] >= correlations[minLag + 1]
  ) {
    bestLag = minLag;
    best = correlations[minLag];
  }
  for (let lag = minLag + 1; lag < maxLag && bestLag !== minLag; lag += 1) {
    if (
      correlations[lag] >= best * 0.92 &&
      correlations[lag] >= correlations[lag - 1] &&
      correlations[lag] >= correlations[lag + 1]
    ) {
      bestLag = lag;
      best = correlations[lag];
      break;
    }
  }
  if (bestLag === 0 || best < 0.35) {
    return { hz: null, confidence: Math.max(0, best) };
  }
  return {
    hz: sampleRate / bestLag,
    confidence: Math.min(1, Math.max(0, best))
  };
}

function amdfPitch(
  samples: Float32Array,
  sampleRate: number
): PitchCandidate {
  const minLag = Math.max(1, Math.floor(sampleRate / 700));
  const maxLag = Math.min(
    samples.length - 2,
    Math.ceil(sampleRate / 50)
  );
  let bestLag = 0;
  let best = Number.POSITIVE_INFINITY;
  let meanDifference = 0;
  let count = 0;
  const differences: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let difference = 0;
    for (let index = 0; index < samples.length - lag; index += 1) {
      difference += Math.abs(samples[index] - samples[index + lag]);
    }
    difference /= Math.max(1, samples.length - lag);
    differences[lag] = difference;
    meanDifference += difference;
    count += 1;
    if (difference < best) {
      best = difference;
      bestLag = lag;
    }
  }
  const baseline = meanDifference / Math.max(1, count);
  if (
    differences[minLag] <= best + baseline * 0.08 &&
    differences[minLag] <= differences[minLag + 1]
  ) {
    bestLag = minLag;
    best = differences[minLag];
  }
  for (let lag = minLag + 1; lag < maxLag && bestLag !== minLag; lag += 1) {
    if (
      differences[lag] <= best + baseline * 0.08 &&
      differences[lag] <= differences[lag - 1] &&
      differences[lag] <= differences[lag + 1]
    ) {
      bestLag = lag;
      best = differences[lag];
      break;
    }
  }
  const confidence =
    baseline <= 1e-9 ? 0 : Math.max(0, 1 - best / baseline);
  if (bestLag === 0 || confidence < 0.2) {
    return { hz: null, confidence };
  }
  return { hz: sampleRate / bestLag, confidence };
}

function zeroCrossingPitch(
  samples: Float32Array,
  sampleRate: number
): PitchCandidate {
  const crossings: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1] <= 0 && samples[index] > 0) {
      const span = samples[index] - samples[index - 1];
      crossings.push(
        index - 1 + (span === 0 ? 0 : -samples[index - 1] / span)
      );
    }
  }
  if (crossings.length < 2) return { hz: null, confidence: 0 };
  const periods = crossings
    .slice(1)
    .map((crossing, index) => crossing - crossings[index])
    .filter((period) => period > 0);
  const sorted = [...periods].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const hz = sampleRate / median;
  const mean =
    periods.reduce((sum, period) => sum + period, 0) /
    Math.max(1, periods.length);
  const deviation = Math.sqrt(
    periods.reduce(
      (sum, period) => sum + (period - mean) ** 2,
      0
    ) / Math.max(1, periods.length)
  );
  const confidence = Math.max(0, 1 - deviation / Math.max(1, mean));
  // Keep a narrow numerical margin around the configured search bounds; the
  // final estimator pair still constrains the reported value.
  if (hz < 48 || hz > 720 || confidence < 0.6) {
    return { hz: null, confidence };
  }
  return { hz, confidence };
}

function resolvePitch(
  autocorrelation: PitchCandidate,
  amdf: PitchCandidate,
  zeroCrossing: PitchCandidate
): {
  hz: number | null;
  confidence: number;
  agreement: number;
} {
  if (autocorrelation.hz === null || amdf.hz === null) {
    return {
      hz: null,
      confidence: Math.min(
        autocorrelation.confidence,
        amdf.confidence
      ),
      agreement: 0
    };
  }
  const ratio = Math.max(
    autocorrelation.hz,
    amdf.hz
  ) / Math.min(autocorrelation.hz, amdf.hz);
  const octaveRelated =
    Math.abs(ratio - 2) <= 0.12 ||
    Math.abs(ratio - 0.5) <= 0.06;
  const relativeDifference =
    Math.abs(autocorrelation.hz - amdf.hz) /
    Math.max(autocorrelation.hz, amdf.hz);
  // At the upper end of the supported range, one downsampled lag is a
  // meaningful fraction of a pitch period (700 Hz is roughly 11.4 samples at
  // 8 kHz). Permit the two independent estimators to land on adjacent lags,
  // while continuing to reject octave-related and materially divergent
  // candidates.
  if (octaveRelated && zeroCrossing.hz !== null) {
    const candidates = [autocorrelation, amdf].filter(
      (candidate) =>
        candidate.hz !== null &&
        Math.abs(candidate.hz - zeroCrossing.hz!) /
          Math.max(candidate.hz, zeroCrossing.hz!) <=
          0.12
    );
    if (candidates.length === 1) {
      const selected = candidates[0];
      return {
        hz: (selected.hz! + zeroCrossing.hz) / 2,
        confidence: Math.min(
          selected.confidence,
          zeroCrossing.confidence
        ),
        agreement: 0.8
      };
    }
  }
  if (relativeDifference > 0.12 || octaveRelated) {
    return {
      hz: null,
      confidence: Math.min(
        autocorrelation.confidence,
        amdf.confidence
      ),
      agreement: Math.max(0, 1 - relativeDifference)
    };
  }
  return {
    hz: (autocorrelation.hz + amdf.hz) / 2,
    confidence: Math.min(
      autocorrelation.confidence,
      amdf.confidence
    ),
    agreement: Math.max(0, 1 - relativeDifference / 0.3)
  };
}

/**
 * Energy in 16 logarithmically spaced bands, for the spectral-flux estimate.
 *
 * Previously evaluated a direct DFT at 16 frequencies, calling sin and cos
 * inside the inner loop -- roughly a million trigonometric evaluations per
 * second of audio at the current window and hop. One windowed FFT costs less
 * and resolves the whole spectrum, so the bands are now summed from it.
 *
 * The signal is windowed first. The direct evaluation used a rectangular
 * window, which leaks about -13 dB into neighbouring bands and so blurred the
 * very band boundaries it was measuring across.
 */
function bandEnergies(samples: Float32Array, bands = 16): number[] {
  const result = new Array<number>(bands).fill(0);
  if (samples.length === 0) return result;
  const spectrum = powerSpectrum(
    applyWindow(samples, hannWindow(samples.length))
  );
  const usable = spectrum.length - 1;
  if (usable < bands) return result;
  for (let band = 0; band < bands; band += 1) {
    // Logarithmic edges: pitch and the formant structure above it are both
    // roughly log-spaced, so linear bands spend most of their resolution where
    // speech has least of its structure.
    const low = Math.floor(usable ** (band / bands));
    const high = Math.max(low + 1, Math.floor(usable ** ((band + 1) / bands)));
    let total = 0;
    for (let bin = low; bin < high && bin <= usable; bin += 1) {
      total += spectrum[bin];
    }
    result[band] = total / Math.max(1, high - low);
  }
  return result;
}

export function analyzeVoiceWindow(
  samples: Float32Array,
  sampleRate: number,
  priorBandEnergies: readonly number[] | null = null
): VoiceWindowAnalysis {
  let mean = 0;
  let clipped = 0;
  for (const sample of samples) {
    mean += sample;
    if (Math.abs(sample) >= 0.98) clipped += 1;
  }
  mean /= Math.max(1, samples.length);
  const centered = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    centered[index] = samples[index] - mean;
  }
  const rms = calculateRms(centered);
  // Anti-aliased now. The previous boxcar average let content above 4 kHz fold
  // back into the retained band, where the pitch estimators could not tell it
  // from signal.
  const pitchInput = decimate(centered, sampleRate, 8_000);
  const autocorrelation = autocorrelationPitch(pitchInput, 8_000);
  const amdf = amdfPitch(pitchInput, 8_000);
  const zeroCrossing = zeroCrossingPitch(pitchInput, 8_000);
  const pitch = resolvePitch(autocorrelation, amdf, zeroCrossing);
  const currentBands = bandEnergies(pitchInput);
  const spectralFlux =
    priorBandEnergies === null
      ? 0
      : Math.sqrt(
          currentBands.reduce((sum, energy, index) => {
            const prior = priorBandEnergies[index] ?? 0;
            const delta = Math.log1p(energy) - Math.log1p(prior);
            return sum + Math.max(0, delta) ** 2;
          }, 0) / currentBands.length
        );
  // Computed on the full-rate, undecimated signal: the upper harmonics that
  // set the cepstral background are above the 4 kHz the pitch path keeps.
  const cepstral = cepstralPeakProminence(centered, sampleRate);
  return {
    rms,
    dcOffset: mean,
    clippedSampleFraction: clipped / Math.max(1, samples.length),
    f0Hz: pitch.hz,
    f0Confidence: pitch.confidence,
    estimatorAgreement: pitch.agreement,
    spectralFlux,
    // Null on silence and on windows too short to hold a low period. Zero is a
    // real value here -- it means no harmonic structure -- so it must not stand
    // in for "not measured".
    cepstralPeakProminenceDb: cepstral?.prominenceDb ?? null,
    bandEnergies: currentBands
  };
}
