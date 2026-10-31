/**
 * Noise reduction from a learned profile.
 *
 * The two-step workflow every editor since the late nineties has used, for
 * good reason: select a stretch where only the noise is playing, learn what
 * it looks like across frequency, then pull every bin that is not clearly
 * louder than that down by a fixed amount, everywhere in the track.
 *
 * The obvious version of this sounds worse than the noise it removes. Bins
 * flicker across the threshold from frame to frame and each flicker is a
 * short tone, which is the bubbling "musical noise" people associate with
 * cheap denoisers. The cure is to smooth the decision rather than the
 * audio: each bin's gain is averaged with its neighbours in frequency and
 * in time before it is applied, so an isolated bin crossing the line on
 * its own is outvoted.
 *
 * Spectra are streamed, three frames at a time. Keeping the whole track's
 * spectrum in memory, as spectral repair does for a short selection, would
 * cost several hundred megabytes on a five-minute song.
 */

import { fft, plan } from "./spectrogram";
import { inverse } from "./spectral";

export const DENOISE_FFT = 2048;

export type NoiseProfile = {
  /** Mean magnitude per bin, one array per channel. */
  mags: Float32Array[];
  sampleRate: number;
  /** How many frames went into the average. */
  frames: number;
};

export type DenoiseOptions = {
  /** How far a bin judged to be noise is pulled down, in dB. */
  reductionDb?: number;
  /**
   * How far above the learned noise a bin must sit to be left alone, in
   * dB. Higher removes more, and starts to eat quiet detail.
   */
  sensitivityDb?: number;
};

/** Frames that fit wholly inside a range, at a quarter-window hop. */
function framesIn(start: number, end: number, n: number) {
  const hop = n >> 2;
  const out: number[] = [];
  for (let at = start; at + n <= end; at += hop) out.push(at);
  return out;
}

/**
 * Average the spectrum of a noise-only selection.
 *
 * Throws when the selection is shorter than a few windows: a profile
 * learned from one frame is a snapshot of one random moment, not of the
 * noise, and applying it does visible damage.
 */
export function learnNoise(
  channels: Float32Array[],
  start: number,
  end: number,
  sampleRate: number,
): NoiseProfile {
  const n = DENOISE_FFT;
  const p = plan(n);
  const bins = (n >> 1) + 1;
  const starts = framesIn(Math.max(0, start), end, n);
  if (starts.length < 4) {
    const ms = Math.ceil(((n + 3 * (n >> 2)) / sampleRate) * 1000);
    throw new Error(`Select at least ${ms} ms of noise on its own to learn from.`);
  }

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const mags = channels.map((ch) => {
    const sum = new Float64Array(bins);
    for (const at of starts) {
      for (let i = 0; i < n; i++) {
        re[p.rev[i]] = (ch[at + i] ?? 0) * p.window[i];
        im[i] = 0;
      }
      fft(re, im, p);
      for (let k = 0; k < bins; k++) sum[k] += Math.hypot(re[k], im[k]);
    }
    const m = new Float32Array(bins);
    for (let k = 0; k < bins; k++) m[k] = sum[k] / starts.length;
    return m;
  });

  return { mags, sampleRate, frames: starts.length };
}

/**
 * Reduce noise across a whole channel.
 *
 * With `reductionDb` at zero every gain is one and the channel comes back
 * as it went in, to rounding; the check suite holds it to that, because a
 * denoiser that changes clean audio when told to do nothing cannot be
 * trusted when told to do something.
 */
export function reduceNoise(
  channel: Float32Array,
  noise: Float32Array,
  opts: DenoiseOptions = {},
): Float32Array<ArrayBuffer> {
  const n = DENOISE_FFT;
  const hop = n >> 2;
  const half = n >> 1;
  const bins = half + 1;
  const p = plan(n);

  const floor = Math.pow(10, -(opts.reductionDb ?? 12) / 20);
  const logFloor = Math.log(floor);
  const over = Math.pow(10, (opts.sensitivityDb ?? 6) / 20);
  const threshold = new Float32Array(bins);
  for (let k = 0; k < bins; k++) threshold[k] = noise[k] * over;

  // Frames start a window before the audio so the first samples are
  // covered by a full set of overlaps, and end a window after it.
  const from = -n;
  const frames = Math.ceil((channel.length + 2 * n) / hop);
  const span = (frames - 1) * hop + n;
  const acc = new Float64Array(span);
  const norm = new Float64Array(span);

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const sr = new Float32Array(n);
  const si = new Float32Array(n);

  // A ring of three analysed frames: the one being written out sits in
  // the middle, so its gain can be averaged with the frames either side.
  const specRe = [0, 1, 2].map(() => new Float32Array(bins));
  const specIm = [0, 1, 2].map(() => new Float32Array(bins));
  const raw = [0, 1, 2].map(() => new Float32Array(bins));
  const gain = new Float32Array(bins);
  const t = new Float32Array(bins);

  const analyse = (f: number, slot: number) => {
    const at = from + f * hop;
    for (let i = 0; i < n; i++) {
      const s = at + i;
      re[p.rev[i]] = s >= 0 && s < channel.length ? channel[s] * p.window[i] : 0;
      im[i] = 0;
    }
    fft(re, im, p);
    const R = specRe[slot];
    const I = specIm[slot];
    const g = raw[slot];
    for (let k = 0; k < bins; k++) {
      R[k] = re[k];
      I[k] = im[k];
      // Stored as a log gain, so the smoothing below averages decibels.
      // Averaged linearly, the few noise bins that cross the threshold by
      // chance each frame count as gain 1 and outvote the rest: asked for
      // 18 dB, the linear version delivered 14.
      g[k] = Math.hypot(re[k], im[k]) >= threshold[k] ? 0 : logFloor;
    }
  };

  const emit = (f: number, slot: number, prev: number | null, next: number | null) => {
    const R = specRe[slot];
    const I = specIm[slot];
    // Time first, then frequency: three frames, then five bins.
    for (let k = 0; k < bins; k++) {
      let s = raw[slot][k];
      let c = 1;
      if (prev !== null) {
        s += raw[prev][k];
        c++;
      }
      if (next !== null) {
        s += raw[next][k];
        c++;
      }
      t[k] = s / c;
    }
    for (let k = 0; k < bins; k++) {
      let s = 0;
      let c = 0;
      for (let d = -2; d <= 2; d++) {
        const j = k + d;
        if (j < 0 || j >= bins) continue;
        s += t[j];
        c++;
      }
      // Never below the floor and never above unity, whatever the
      // averaging did at the edges.
      gain[k] = Math.min(1, Math.max(floor, Math.exp(s / c)));
    }

    for (let k = 0; k < bins; k++) {
      re[k] = R[k] * gain[k];
      im[k] = I[k] * gain[k];
      if (k > 0 && k < half) {
        re[n - k] = re[k];
        im[n - k] = -im[k];
      }
    }
    inverse(re, im, p, sr, si);
    const at = f * hop;
    for (let i = 0; i < n; i++) {
      const w = p.window[i];
      acc[at + i] += sr[i] * w;
      norm[at + i] += w * w;
    }
  };

  // Prime the ring with the first two frames, then slide.
  analyse(0, 0);
  if (frames > 1) analyse(1, 1);
  for (let f = 0; f < frames; f++) {
    const slot = f % 3;
    const prev = f > 0 ? (f - 1) % 3 : null;
    const next = f + 1 < frames ? (f + 1) % 3 : null;
    emit(f, slot, prev, next);
    if (f + 2 < frames) analyse(f + 2, (f + 2) % 3);
  }

  const out = new Float32Array(channel.length);
  for (let s = 0; s < channel.length; s++) {
    const i = s - from;
    out[s] = norm[i] > 1e-6 ? acc[i] / norm[i] : channel[s];
  }
  return out;
}
