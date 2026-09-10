/**
 * Short-time Fourier transform, and the colour ramp that turns it into
 * something you can actually read.
 *
 * This exists for the problems a waveform cannot show you. Mains hum sits
 * at 50 or 60 Hz and is invisible in an envelope; a click is one bright
 * vertical line across every band; tape hiss is a flat wash along the top.
 * All three are obvious here and guesswork in the amplitude view.
 *
 * Columns are computed for the visible window only, at draw time, rather
 * than analysing the whole file up front. A four minute stereo track at a
 * 256 sample hop would be forty thousand columns of which maybe fourteen
 * hundred are on screen, so the cache would cost more than the work it
 * saves, and it would have to be thrown away on every edit anyway.
 */

export type Plan = {
  n: number;
  cos: Float32Array;
  sin: Float32Array;
  rev: Uint32Array;
  window: Float32Array;
};

/** Cached twiddle factors and bit-reversal tables, keyed by transform size. */
const plans = new Map<number, Plan>();

/**
 * Shared with the repair code, which needs the same tables to run the
 * transform backwards. Building a second set would double the memory for
 * no reason, and the two would be free to drift apart.
 */
export function plan(n: number): Plan {
  const hit = plans.get(n);
  if (hit) return hit;

  const half = n >> 1;
  const cos = new Float32Array(half);
  const sin = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }

  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }

  // Hann, periodic rather than symmetric. That is the correct choice for
  // analysis: it makes overlapping frames sum flat.
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }

  const p = { n, cos, sin, rev, window };
  plans.set(n, p);
  return p;
}

/**
 * In-place iterative radix-2 FFT. Both arrays are overwritten.
 *
 * Decimation in time, so the input has to be in bit-reversed order first,
 * which the caller arranges while it is copying and windowing the frame.
 * That saves a whole pass over the data.
 */
export function fft(re: Float32Array, im: Float32Array, p: Plan) {
  const n = p.n;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const c = p.cos[k];
        const s = p.sin[k];
        const tr = re[j + half] * c - im[j + half] * s;
        const ti = re[j + half] * s + im[j + half] * c;
        re[j + half] = re[j] - tr;
        im[j + half] = im[j] - ti;
        re[j] += tr;
        im[j] += ti;
      }
    }
  }
}

export type SpectrogramOptions = {
  /** Transform size. Larger sees pitch more precisely and time less so. */
  fftSize?: number;
  /** Quietest level drawn, in dB relative to full scale. */
  floorDb?: number;
  /** Loudest level drawn. Above this everything is one colour. */
  ceilDb?: number;
};

export type SpectrogramFrame = {
  /** columns by bands, row-major, every value already clamped to 0..1. */
  data: Float32Array;
  columns: number;
  bands: number;
};

const LOW_HZ = 40;

function topHz(sampleRate: number) {
  return Math.min(sampleRate / 2, 20000);
}

/**
 * Analyse one channel across a sample range and return a normalised
 * magnitude grid, one column per output pixel.
 *
 * Frequency is mapped logarithmically on the way out. Linear bins spend
 * three quarters of the display on the top two octaves, where almost
 * nothing musical is happening.
 */
export function analyse(
  channel: Float32Array,
  startSample: number,
  endSample: number,
  columns: number,
  bands: number,
  sampleRate: number,
  opts: SpectrogramOptions = {},
): SpectrogramFrame {
  // 4096 is not arbitrary. At 48 kHz it puts bins 11.7 Hz apart, and
  // measured against synthesised 50 and 60 Hz tones the brightest band
  // does move between the two, so you can tell which mains frequency you
  // are looking at. At 1024 they land in the same bin and the bottom of
  // the picture is one flat smear.
  //
  // Be honest about the limit though: a Hann main lobe is four bins wide,
  // so at this size a 50 Hz tone still lights everything from roughly 40
  // to 75 Hz. Hum reads as a thick band, not a hairline. Getting it down
  // to a hairline needs 16384, which is four times the work again for a
  // view that has to redraw on every scroll, and that is not a trade worth
  // making by default.
  const fftSize = opts.fftSize ?? 4096;
  const floorDb = opts.floorDb ?? -96;
  const ceilDb = opts.ceilDb ?? -12;
  const range = ceilDb - floorDb;

  const p = plan(fftSize);
  const half = fftSize >> 1;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const mag = new Float32Array(half);
  const data = new Float32Array(columns * bands);

  const hop = (endSample - startSample) / columns;

  // Work out once which FFT bins land in each log-spaced display band.
  const high = topHz(sampleRate);
  const binHz = sampleRate / fftSize;
  const bandLo = new Uint32Array(bands);
  const bandHi = new Uint32Array(bands);
  for (let b = 0; b < bands; b++) {
    const f0 = LOW_HZ * Math.pow(high / LOW_HZ, b / bands);
    const f1 = LOW_HZ * Math.pow(high / LOW_HZ, (b + 1) / bands);
    bandLo[b] = Math.max(1, Math.floor(f0 / binHz));
    bandHi[b] = Math.max(bandLo[b] + 1, Math.min(half, Math.ceil(f1 / binHz)));
  }

  for (let x = 0; x < columns; x++) {
    // Centre the frame on its column, otherwise the picture sits half a
    // window late against the waveform drawn above it.
    const from = Math.round(startSample + (x + 0.5) * hop) - (fftSize >> 1);

    for (let i = 0; i < fftSize; i++) {
      const s = from + i;
      const v = s >= 0 && s < channel.length ? channel[s] * p.window[i] : 0;
      re[p.rev[i]] = v;
      im[i] = 0;
    }

    fft(re, im, p);

    for (let k = 0; k < half; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }

    for (let b = 0; b < bands; b++) {
      // Peak across the band rather than mean. A mean smears a narrow tone
      // into its neighbours, and a hum line stops looking like a line.
      let peak = 0;
      for (let k = bandLo[b]; k < bandHi[b]; k++) {
        if (mag[k] > peak) peak = mag[k];
      }
      // Two over N puts a full-scale sine at roughly unity, given the
      // window has a coherent gain of one half.
      const db = 20 * Math.log10((peak * 2) / fftSize + 1e-12);
      const t = (db - floorDb) / range;
      data[x * bands + b] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
  }

  return { data, columns, bands };
}

/**
 * Warm ramp, sampled into a lookup table once.
 *
 * A rainbow would suggest more detail than the data holds, and it would be
 * a lie besides: hue is not perceptually ordered, so equal steps in level
 * do not look like equal steps in colour. This ramp climbs monotonically
 * in lightness, which means it survives being printed, screenshotted, or
 * read by someone who does not see red.
 */
const STOPS: [number, number, number][] = [
  [8, 9, 10],
  [26, 20, 32],
  [66, 30, 42],
  [124, 52, 34],
  [186, 92, 26],
  [232, 148, 38],
  [245, 200, 120],
  [255, 244, 226],
];

const LUT_SIZE = 256;

const LUT = (() => {
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = (i / (LUT_SIZE - 1)) * (STOPS.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(STOPS.length - 1, lo + 1);
    const f = t - lo;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = STOPS[lo][c] + (STOPS[hi][c] - STOPS[lo][c]) * f;
    }
  }
  return lut;
})();

/** Write a frame into RGBA image data. */
export function paint(frame: SpectrogramFrame, out: Uint8ClampedArray) {
  const { data, columns, bands } = frame;
  for (let x = 0; x < columns; x++) {
    for (let b = 0; b < bands; b++) {
      // Row zero is the top of the image and band zero is the lowest
      // frequency, so the vertical axis flips on the way out.
      const i = ((bands - 1 - b) * columns + x) * 4;
      const v = Math.round(data[x * bands + b] * (LUT_SIZE - 1)) * 3;
      out[i] = LUT[v];
      out[i + 1] = LUT[v + 1];
      out[i + 2] = LUT[v + 2];
      out[i + 3] = 255;
    }
  }
}

/** Centre frequency of a display row, for axis labelling. */
export function bandFrequency(band: number, bands: number, sampleRate: number) {
  return LOW_HZ * Math.pow(topHz(sampleRate) / LOW_HZ, band / bands);
}

/**
 * Where a frequency sits on the lane, as a fraction from bottom to top.
 *
 * The inverse of `bandFrequency`, and it exists so that drawing a band
 * selection cannot disagree with the picture underneath it. Values outside
 * the displayed span come back outside zero to one rather than clamped, so
 * a selection dragged past the edge still lands somewhere sensible.
 */
export function bandPosition(hz: number, sampleRate: number) {
  return Math.log(Math.max(1e-6, hz) / LOW_HZ) / Math.log(topHz(sampleRate) / LOW_HZ);
}
