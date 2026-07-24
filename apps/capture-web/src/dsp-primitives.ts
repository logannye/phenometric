/**
 * Signal-processing primitives shared by the voice analysis path.
 *
 * These exist because the measurements that come next -- cepstral peak
 * prominence, formant estimates, intensity dynamics -- need three things the
 * pipeline had no way to produce: a windowed spectrum, a transform that is not
 * quadratic in window length, and a decimation path that actually removes the
 * band it is about to fold.
 *
 * Everything here is a pure function of its inputs. No state, no sample-rate
 * assumptions beyond what is passed in.
 */

/**
 * Periodic Hann window.
 *
 * Periodic rather than symmetric (`length` in the denominator, not
 * `length - 1`): the symmetric form is for filter design, the periodic form for
 * spectral analysis, where it is the one that sums to a constant under
 * overlap-add and leaves no DC bias in the averaged spectrum.
 *
 * Every spectrum this module produces is windowed. A rectangular window -- what
 * the existing band-energy DFT uses -- leaks roughly -13 dB into neighbouring
 * bins, which is louder than the cepstral structure CPPS has to measure.
 */
export function hannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  if (length === 1) {
    window[0] = 1;
    return window;
  }
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / length));
  }
  return window;
}

/**
 * Symmetric Hann window, for filter design rather than spectral analysis.
 *
 * `length - 1` in the denominator, so the window is an exact mirror about its
 * centre and both endpoints are zero. {@link designLowPass} depends on that
 * symmetry: an asymmetric taper makes the kernel asymmetric, which costs the
 * filter its linear phase and leaves the group delay a non-integer that
 * {@link decimate} cannot then remove cleanly.
 */
export function hannWindowSymmetric(length: number): Float32Array {
  const window = new Float32Array(length);
  if (length === 1) {
    window[0] = 1;
    return window;
  }
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
  }
  return window;
}

/** Element-wise product. Returns a new array; neither input is modified. */
export function applyWindow(
  samples: Float32Array,
  window: Float32Array
): Float32Array {
  const length = Math.min(samples.length, window.length);
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    result[index] = samples[index] * window[index];
  }
  return result;
}

/**
 * First-order pre-emphasis: `y[n] = x[n] - a * x[n-1]`.
 *
 * Compensates the roughly -6 dB/octave rolloff of the glottal source so the
 * upper formants are not buried under the first. Standard for formant and
 * cepstral work; deliberately NOT applied on the pitch path, where boosting
 * high frequencies only adds noise to a low-frequency estimate.
 */
export function preEmphasis(
  samples: Float32Array,
  coefficient = 0.97
): Float32Array {
  const result = new Float32Array(samples.length);
  if (samples.length === 0) return result;
  result[0] = samples[0];
  for (let index = 1; index < samples.length; index += 1) {
    result[index] = samples[index] - coefficient * samples[index - 1];
  }
  return result;
}

export function nextPowerOfTwo(value: number): number {
  if (value <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(value));
}

/**
 * Twiddle factors, cached per transform size.
 *
 * The naive band-energy DFT evaluates sin and cos inside its inner loop --
 * about a million calls per second of audio at the current window and hop.
 * Precomputing removes them from the hot path entirely.
 */
const twiddleCache = new Map<
  number,
  { cos: Float64Array; sin: Float64Array }
>();

function twiddles(size: number): { cos: Float64Array; sin: Float64Array } {
  const cached = twiddleCache.get(size);
  if (cached) return cached;
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let index = 0; index < size / 2; index += 1) {
    const angle = (-2 * Math.PI * index) / size;
    cos[index] = Math.cos(angle);
    sin[index] = Math.sin(angle);
  }
  const entry = { cos, sin };
  twiddleCache.set(size, entry);
  return entry;
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 *
 * `real` and `imaginary` must be the same power-of-two length. O(n log n),
 * against the O(n * bands) of the direct evaluation it replaces.
 */
export function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  if (size <= 1) return;
  if ((size & (size - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two, received ${size}.`);
  }

  // Bit-reversal permutation.
  for (let index = 1, target = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; target & bit; bit >>= 1) target ^= bit;
    target ^= bit;
    if (index < target) {
      [real[index], real[target]] = [real[target], real[index]];
      [imaginary[index], imaginary[target]] = [
        imaginary[target],
        imaginary[index]
      ];
    }
  }

  const { cos, sin } = twiddles(size);
  for (let length = 2; length <= size; length <<= 1) {
    const step = size / length;
    for (let start = 0; start < size; start += length) {
      for (let offset = 0; offset < length / 2; offset += 1) {
        const twiddle = offset * step;
        const upper = start + offset;
        const lower = upper + length / 2;
        const realPart =
          real[lower] * cos[twiddle] - imaginary[lower] * sin[twiddle];
        const imaginaryPart =
          real[lower] * sin[twiddle] + imaginary[lower] * cos[twiddle];
        real[lower] = real[upper] - realPart;
        imaginary[lower] = imaginary[upper] - imaginaryPart;
        real[upper] += realPart;
        imaginary[upper] += imaginaryPart;
      }
    }
  }
}

/**
 * Power spectrum of a real signal, zero-padded to the next power of two.
 *
 * Returns bins `0 .. size/2` inclusive, so index `k` is frequency
 * `k * sampleRate / size`. The caller supplies an already-windowed signal;
 * windowing is not applied here because the pitch and cepstral paths want
 * different treatments of the same buffer.
 */
export function powerSpectrum(samples: Float32Array): Float64Array {
  const size = nextPowerOfTwo(Math.max(2, samples.length));
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  real.set(samples);
  fftInPlace(real, imaginary);
  const bins = size / 2 + 1;
  const spectrum = new Float64Array(bins);
  for (let index = 0; index < bins; index += 1) {
    spectrum[index] =
      real[index] * real[index] + imaginary[index] * imaginary[index];
  }
  return spectrum;
}

/**
 * Windowed-sinc low-pass FIR, normalised to unit gain at DC.
 *
 * `cutoffRatio` is the -6 dB point as a fraction of the sample rate, so 0.25 is
 * half of Nyquist. `taps` is forced odd to keep the filter linear-phase with an
 * integer group delay of `(taps - 1) / 2`, which {@link decimate} then removes
 * exactly rather than approximately.
 */
export function designLowPass(cutoffRatio: number, taps = 65): Float64Array {
  const length = taps % 2 === 0 ? taps + 1 : taps;
  const kernel = new Float64Array(length);
  const centre = (length - 1) / 2;
  const window = hannWindowSymmetric(length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const position = index - centre;
    // sinc(2 * fc * n), with the removable singularity at n = 0 filled in.
    const sinc =
      position === 0
        ? 2 * cutoffRatio
        : Math.sin(2 * Math.PI * cutoffRatio * position) /
          (Math.PI * position);
    kernel[index] = sinc * window[index];
    sum += kernel[index];
  }
  // Unit DC gain, so decimation neither amplifies nor attenuates the passband.
  for (let index = 0; index < length; index += 1) kernel[index] /= sum;
  return kernel;
}

/**
 * Anti-aliased decimation.
 *
 * The previous path averaged each output sample over a block of inputs. A
 * boxcar is a low-pass filter, but a poor one: its first sidelobe is only
 * -13 dB, so content above the new Nyquist folded back into the retained band
 * rather than being removed. That is tolerable for a 50-700 Hz pitch estimate
 * and not tolerable for anything spectral, which is why this exists now.
 *
 * The cutoff sits at 45% of the target rate, leaving a transition band below
 * the new Nyquist. Group delay is compensated so output sample `i` corresponds
 * to the same instant as input sample `i * ratio`.
 */
export function decimate(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
  taps = 65
): Float32Array {
  if (sourceRate <= targetRate || samples.length === 0) return samples;
  const ratio = sourceRate / targetRate;
  const kernel = designLowPass((0.45 * targetRate) / sourceRate, taps);
  const delay = (kernel.length - 1) / 2;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const result = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const centre = Math.round(index * ratio) + delay;
    let accumulator = 0;
    for (let tap = 0; tap < kernel.length; tap += 1) {
      const source = centre - delay + (tap - delay);
      // Zero outside the buffer; the alternative, edge clamping, would inject a
      // DC step at the boundaries of every analysis window.
      if (source >= 0 && source < samples.length) {
        accumulator += samples[source] * kernel[tap];
      }
    }
    result[index] = accumulator;
  }
  return result;
}
