import { describe, expect, it } from "vitest";
import {
  applyWindow,
  cepstralPeakProminence,
  decimate,
  designLowPass,
  fftInPlace,
  hannWindow,
  hannWindowSymmetric,
  nextPowerOfTwo,
  powerSpectrum,
  preEmphasis
} from "./dsp-primitives.js";

function tone(
  frequencyHz: number,
  sampleRate: number,
  length: number,
  amplitude = 1
): Float32Array {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] =
      amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate);
  }
  return samples;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Direct evaluation, used only to check the fast transform against it. */
function naiveDft(samples: Float32Array): { real: number[]; imaginary: number[] } {
  const size = samples.length;
  const real: number[] = [];
  const imaginary: number[] = [];
  for (let bin = 0; bin < size; bin += 1) {
    let sumReal = 0;
    let sumImaginary = 0;
    for (let index = 0; index < size; index += 1) {
      const angle = (-2 * Math.PI * bin * index) / size;
      sumReal += samples[index] * Math.cos(angle);
      sumImaginary += samples[index] * Math.sin(angle);
    }
    real.push(sumReal);
    imaginary.push(sumImaginary);
  }
  return { real, imaginary };
}

describe("hann window", () => {
  it("is periodic, not symmetric", () => {
    // The periodic form starts at zero and does NOT return to zero at the last
    // sample; that is what makes it sum to a constant under overlap-add.
    const window = hannWindow(8);
    expect(window[0]).toBeCloseTo(0, 12);
    expect(window[4]).toBeCloseTo(1, 12);
    expect(window[7]).toBeGreaterThan(0);
  });

  it("sums to half its length", () => {
    const window = hannWindow(1_024);
    const total = [...window].reduce((sum, value) => sum + value, 0);
    // Loose to 4 places: the window is stored as Float32, so summing 1024 of
    // them accumulates about 1e-6 of representation error before any of this
    // reaches the assertion.
    expect(total).toBeCloseTo(512, 4);
  });

  it("differs from the symmetric form used for filter design", () => {
    // Both are Hann; only the symmetric one is an exact mirror with zero at
    // both ends, which is what a linear-phase kernel requires.
    const periodic = hannWindow(9);
    const symmetric = hannWindowSymmetric(9);
    expect(symmetric[0]).toBeCloseTo(0, 12);
    expect(symmetric[8]).toBeCloseTo(0, 12);
    expect(periodic[8]).toBeGreaterThan(0);
  });

  it("handles the degenerate single-sample case", () => {
    expect([...hannWindow(1)]).toEqual([1]);
  });
});

describe("pre-emphasis", () => {
  it("is a first-order difference that passes the first sample through", () => {
    const result = preEmphasis(Float32Array.from([1, 2, 3, 4]), 0.5);
    expect([...result]).toEqual([1, 1.5, 2, 2.5]);
  });

  it("attenuates a low tone more than a high one", () => {
    // The point of pre-emphasis: lift the upper spectrum relative to the
    // glottal rolloff so higher formants are not buried under the first.
    const low = preEmphasis(tone(100, 16_000, 1_024));
    const high = preEmphasis(tone(4_000, 16_000, 1_024));
    expect(rms(high)).toBeGreaterThan(rms(low) * 5);
  });

  it("returns an empty result for empty input", () => {
    expect(preEmphasis(new Float32Array(0)).length).toBe(0);
  });
});

describe("fft", () => {
  it("matches direct evaluation", () => {
    const samples = tone(440, 8_000, 64, 0.7);
    const expected = naiveDft(samples);
    const real = Float64Array.from(samples);
    const imaginary = new Float64Array(64);
    fftInPlace(real, imaginary);
    for (let bin = 0; bin < 64; bin += 1) {
      expect(real[bin]).toBeCloseTo(expected.real[bin], 6);
      expect(imaginary[bin]).toBeCloseTo(expected.imaginary[bin], 6);
    }
  });

  it("rejects a non-power-of-two size", () => {
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6))).toThrow(
      /power of two/
    );
  });

  it("conserves energy (Parseval)", () => {
    const samples = tone(1_000, 8_000, 256, 0.4);
    let timeEnergy = 0;
    for (const sample of samples) timeEnergy += sample * sample;
    const real = Float64Array.from(samples);
    const imaginary = new Float64Array(256);
    fftInPlace(real, imaginary);
    let spectralEnergy = 0;
    for (let bin = 0; bin < 256; bin += 1) {
      spectralEnergy += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
    }
    expect(spectralEnergy / 256).toBeCloseTo(timeEnergy, 6);
  });
});

describe("power spectrum", () => {
  it("puts a pure tone in the bin its frequency belongs to", () => {
    const sampleRate = 8_000;
    const size = 512;
    // Exactly bin 64: 64 * 8000 / 512 = 1000 Hz, so no leakage to resolve.
    const spectrum = powerSpectrum(tone(1_000, sampleRate, size));
    let peak = 0;
    for (let bin = 1; bin < spectrum.length; bin += 1) {
      if (spectrum[bin] > spectrum[peak]) peak = bin;
    }
    expect((peak * sampleRate) / size).toBeCloseTo(1_000, 0);
  });

  it("returns bins up to and including Nyquist", () => {
    expect(powerSpectrum(new Float32Array(512)).length).toBe(257);
  });

  it("zero-pads a non-power-of-two window", () => {
    // A 40 ms window at 8 kHz is 320 samples, which is the real case.
    expect(nextPowerOfTwo(320)).toBe(512);
    expect(powerSpectrum(new Float32Array(320)).length).toBe(257);
  });
});

describe("low-pass design", () => {
  it("has unit gain at DC", () => {
    const kernel = designLowPass(0.1);
    const sum = [...kernel].reduce((total, tap) => total + tap, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("is linear phase, so its group delay is an exact sample count", () => {
    const kernel = designLowPass(0.2, 65);
    expect(kernel.length % 2).toBe(1);
    for (let index = 0; index < kernel.length; index += 1) {
      expect(kernel[index]).toBeCloseTo(kernel[kernel.length - 1 - index], 12);
    }
  });

  it("forces an even tap count odd", () => {
    expect(designLowPass(0.2, 64).length).toBe(65);
  });
});

describe("decimation", () => {
  const SOURCE = 48_000;
  const TARGET = 8_000;

  /** The boxcar average the pitch path used before, for comparison. */
  function boxDecimate(samples: Float32Array): Float32Array {
    const ratio = SOURCE / TARGET;
    const result = new Float32Array(Math.floor(samples.length / ratio));
    for (let index = 0; index < result.length; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
      let sum = 0;
      for (let source = start; source < end; source += 1) sum += samples[source];
      result[index] = sum / Math.max(1, end - start);
    }
    return result;
  }

  it("passes a tone well inside the retained band", () => {
    const decimated = decimate(tone(500, SOURCE, 9_600), SOURCE, TARGET);
    expect(decimated.length).toBe(1_600);
    // A 0.707 RMS sine should survive decimation essentially intact.
    expect(rms(decimated)).toBeGreaterThan(0.6);
  });

  it("removes a tone above the new Nyquist that the boxcar folds back", () => {
    // 6 kHz decimating to 8 kHz aliases to |6000 - 8000| = 2000 Hz, landing
    // squarely inside the retained band where nothing downstream can tell it
    // from real signal.
    const aliasing = tone(6_000, SOURCE, 9_600);
    const filtered = rms(decimate(aliasing, SOURCE, TARGET));
    const boxed = rms(boxDecimate(aliasing));
    expect(filtered).toBeLessThan(0.02);
    // The boxcar leaves an order of magnitude more of it behind. This is the
    // whole reason the pitch path could not be reused for spectral work.
    expect(boxed).toBeGreaterThan(filtered * 10);
  });

  it("preserves timing, so a decimated impulse stays where it was", () => {
    // Group-delay compensation matters: an uncorrected FIR would shift every
    // event later by half the kernel, silently biasing onset measurements.
    const samples = new Float32Array(9_600);
    samples[4_800] = 1; // exactly 0.1 s in
    const decimated = decimate(samples, SOURCE, TARGET);
    let peak = 0;
    for (let index = 1; index < decimated.length; index += 1) {
      if (Math.abs(decimated[index]) > Math.abs(decimated[peak])) peak = index;
    }
    expect(peak).toBeCloseTo(800, -1); // 0.1 s at 8 kHz, within a sample or two
  });

  it("returns the input unchanged when no decimation is needed", () => {
    const samples = tone(200, 8_000, 128);
    expect(decimate(samples, 8_000, 8_000)).toBe(samples);
    expect(decimate(samples, 8_000, 16_000)).toBe(samples);
  });
});

describe("window application", () => {
  it("multiplies element-wise and truncates to the shorter input", () => {
    const result = applyWindow(
      Float32Array.from([1, 2, 3, 4]),
      Float32Array.from([1, 0.5, 0])
    );
    expect([...result]).toEqual([1, 1, 0]);
  });
});

describe("cepstral peak prominence", () => {
  const RATE = 48_000;
  const WINDOW = 1_920; // 40 ms, the analysis window the worker uses

  /**
   * Pulse train filling the band, as a crude glottal source.
   *
   * The comb has to span the analysed spectrum. A signal whose harmonics stop
   * partway leaves most of the log spectrum at the floor, and the cepstrum then
   * locks onto that spectral edge instead of the comb -- an artifact of the
   * stimulus, but one that produces a confident, wrong frequency.
   */
  function harmonic(f0: number, length: number): Float32Array {
    const samples = new Float32Array(length);
    const harmonics = Math.floor(RATE / 2 / f0) - 1;
    for (let index = 0; index < length; index += 1) {
      let value = 0;
      for (let h = 1; h <= harmonics; h += 1) {
        // 1/h rolloff approximates a glottal spectrum.
        value += Math.sin((2 * Math.PI * h * f0 * index) / RATE) / h;
      }
      samples[index] = value * 0.2;
    }
    return samples;
  }

  /** Deterministic pseudo-noise; no Math.random, so the test cannot flake. */
  function noise(length: number): Float32Array {
    const samples = new Float32Array(length);
    let seed = 12_345;
    for (let index = 0; index < length; index += 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      samples[index] = (seed / 0x3fffffff - 1) * 0.2;
    }
    return samples;
  }

  it("stands well above the background for a harmonic signal", () => {
    const result = cepstralPeakProminence(harmonic(120, WINDOW), RATE);
    expect(result).not.toBeNull();
    expect(result!.prominenceDb).toBeGreaterThan(0);
  });

  it("separates a harmonic signal from noise", () => {
    // The whole point of the measure: how harmonically organised the signal is.
    // Noise has no comb, so its cepstral peak barely clears its own trend.
    const voiced = cepstralPeakProminence(harmonic(120, WINDOW), RATE)!;
    const unvoiced = cepstralPeakProminence(noise(WINDOW), RATE)!;
    expect(voiced.prominenceDb).toBeGreaterThan(unvoiced.prominenceDb);
  });

  it("locates the peak at the fundamental that produced it", () => {
    // Guards the index-to-frequency derivation. Reading quefrency as a lag in
    // signal samples misplaces this by the ratio of the two transform sizes,
    // and the error is silent -- the number still looks like a frequency.
    for (const f0 of [100, 150, 220]) {
      const result = cepstralPeakProminence(harmonic(f0, WINDOW), RATE)!;
      expect(result.peakQuefrencyHz).toBeGreaterThan(f0 * 0.8);
      expect(result.peakQuefrencyHz).toBeLessThan(f0 * 1.25);
    }
  });

  it("abstains on silence rather than reporting zero", () => {
    // Zero prominence is a real value meaning "no harmonic structure".
    // Silence has not measured that, so it must not claim it.
    expect(cepstralPeakProminence(new Float32Array(WINDOW), RATE)).toBeNull();
  });

  it("abstains on a window too short to hold a low period", () => {
    expect(cepstralPeakProminence(new Float32Array(32), RATE)).toBeNull();
  });
});
