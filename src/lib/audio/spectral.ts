/**
 * Spectral repair.
 *
 * A waveform editor can only cut in time. If a chair creaks under a vocal
 * take, cutting removes the creak and the syllable with it. Working on the
 * transform instead lets you take out a rectangle — this stretch of time,
 * these frequencies — and leave everything above and below it standing.
 *
 * The transform is the one in spectrogram.ts run in both directions.
 * Analysis and synthesis both use a Hann window at a quarter-length hop,
 * which is the arrangement where the squared windows sum to a constant, so
 * a frame that nothing touched comes back out unchanged. That property is
 * the whole basis of the thing: it means any audible change has to have
 * come from the edit rather than from the machinery around it.
 */

import { plan, fft, type Plan } from "./spectrogram";

export type RepairMode =
  /** Pull the band down by a fixed amount and leave its shape alone. */
  | "attenuate"
  /**
   * Rebuild the band from the sound on either side of the selection, so
   * the gap fills with whatever was already there rather than silence.
   */
  | "heal";

export type RepairOptions = {
  fftSize?: number;
  /** Only read for "attenuate". Negative decibels. */
  gainDb?: number;
};

export type Band = { loHz: number; hiHz: number };

/**
 * Inverse transform of a conjugate-symmetric spectrum.
 *
 * Runs forwards over the conjugate and divides by the length, which is the
 * same arithmetic as running backwards and saves carrying a second set of
 * twiddle factors with the signs flipped. The imaginary part comes back as
 * rounding noise and is dropped.
 */
function inverse(
  re: Float32Array,
  im: Float32Array,
  p: Plan,
  sr: Float32Array,
  si: Float32Array,
) {
  const n = p.n;
  for (let i = 0; i < n; i++) {
    sr[p.rev[i]] = re[i];
    si[p.rev[i]] = -im[i];
  }
  fft(sr, si, p);
  for (let i = 0; i < n; i++) sr[i] /= n;
}

/**
 * Repair one channel across a sample range and a frequency band.
 *
 * Returns a whole new channel. The caller gets a copy rather than an
 * in-place edit because undo here is a stack of buffers, and a function
 * that quietly rewrote its input would corrupt every snapshot pointing at
 * the same samples.
 */
export function repairChannel(
  channel: Float32Array,
  startSample: number,
  endSample: number,
  band: Band,
  sampleRate: number,
  mode: RepairMode = "heal",
  opts: RepairOptions = {},
): Float32Array<ArrayBuffer> {
  // Allocated and filled rather than built with Float32Array.from, which
  // infers a looser buffer type than copyToChannel will accept.
  const out = new Float32Array(channel.length);
  out.set(channel);

  // 2048 rather than the 4096 the display uses. Repair is judged by ear on
  // material that moves, and a longer window buys frequency precision by
  // spending time precision — at 4096 a click smears across forty
  // milliseconds and the fix is audible as a swell either side of it.
  const n = opts.fftSize ?? 2048;
  const hop = n >> 2;
  const p = plan(n);
  const half = n >> 1;

  const start = Math.max(0, Math.min(channel.length, Math.floor(startSample)));
  const end = Math.max(start, Math.min(channel.length, Math.ceil(endSample)));
  if (end - start < 1) return out;

  // Frames run two whole windows either side of the selection. One window
  // of that is the run-up every sample needs to be covered by a complete
  // set of overlaps; the second is so that healing has clean frames to
  // copy from. A frame whose centre sits just outside the selection still
  // overlaps it by half a window, so it holds a good part of whatever is
  // being removed — read from there and the repair fills the gap with a
  // quieter copy of the problem.
  const guard = n / hop;
  const from = start - 2 * n;
  const frames = Math.ceil((end - start + 4 * n) / hop) + 1;

  const binHz = sampleRate / n;
  const loBin = Math.max(1, Math.floor(band.loHz / binHz));
  const hiBin = Math.max(loBin + 1, Math.min(half, Math.ceil(band.hiHz / binHz)));

  // Magnitude and phase for every frame, kept whole rather than streamed,
  // because healing a frame needs the frames on the far side of the
  // selection and those have not been read yet when it is reached.
  // Nyquist is kept alongside the rest rather than dropped. It carries
  // almost nothing on real material, but throwing it away would mean an
  // untouched frame no longer reconstructs exactly, and exact
  // reconstruction is the property the whole approach rests on.
  const bins = half + 1;
  const mag = new Float32Array(frames * bins);
  const phase = new Float32Array(frames * bins);
  const inside = new Uint8Array(frames);

  const re = new Float32Array(n);
  const im = new Float32Array(n);

  for (let f = 0; f < frames; f++) {
    const at = from + f * hop;
    for (let i = 0; i < n; i++) {
      const s = at + i;
      const v = s >= 0 && s < channel.length ? channel[s] * p.window[i] : 0;
      re[p.rev[i]] = v;
      im[i] = 0;
    }
    fft(re, im, p);
    for (let k = 0; k < bins; k++) {
      const j = f * bins + k;
      mag[j] = Math.hypot(re[k], im[k]);
      phase[j] = Math.atan2(im[k], re[k]);
    }
    // A frame counts as affected when its centre falls in the selection.
    // Judging by any overlap instead would drag in frames that are three
    // quarters outside it and widen the edit by a window on each side.
    const centre = at + half;
    inside[f] = centre >= start && centre < end ? 1 : 0;
  }

  if (mode === "attenuate") {
    const g = Math.pow(10, (opts.gainDb ?? -60) / 20);
    for (let f = 0; f < frames; f++) {
      if (!inside[f]) continue;
      for (let k = loBin; k < hiBin; k++) mag[f * bins + k] *= g;
    }
  } else {
    // Walk each bin along time and interpolate across the run of affected
    // frames, from the last clean frame to the next one. Working per bin
    // rather than per frame is what lets a held note carry through the
    // repair: its level either side of the gap is what fills it.
    for (let k = loBin; k < hiBin; k++) {
      let f = 0;
      while (f < frames) {
        if (!inside[f]) {
          f++;
          continue;
        }
        let e = f;
        while (e < frames && inside[e]) e++;
        const bi = f - 1 - guard;
        const ai = e + guard;
        const before = bi >= 0 ? mag[bi * bins + k] : -1;
        const after = ai < frames ? mag[ai * bins + k] : -1;
        for (let i = f; i < e; i++) {
          let v: number;
          if (before < 0 && after < 0) v = 0;
          else if (before < 0) v = after;
          else if (after < 0) v = before;
          else v = before + ((after - before) * (i - f + 1)) / (e - f + 1);
          mag[i * bins + k] = v;
        }
        f = e;
      }
    }
  }

  // Phase is left as it was found. It is the phase of the sound being
  // removed, which sounds wrong on paper, but a narrow band carries very
  // little phase information to the ear, and both alternatives are worse:
  // random phase turns a held note into a hiss, and zero phase lines every
  // bin up into a tick once per frame.

  const span = (frames - 1) * hop + n;
  const acc = new Float64Array(span);
  const norm = new Float64Array(span);
  const sr = new Float32Array(n);
  const si = new Float32Array(n);

  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bins; k++) {
      const j = f * bins + k;
      const m = mag[j];
      const a = phase[j];
      const rr = m * Math.cos(a);
      const ii = m * Math.sin(a);
      re[k] = rr;
      im[k] = ii;
      // Rebuild the mirrored half so the result comes back real. Bin zero
      // and Nyquist are their own mirrors and must not be written twice.
      if (k > 0 && k < half) {
        re[n - k] = rr;
        im[n - k] = -ii;
      }
    }

    inverse(re, im, p, sr, si);

    const at = f * hop;
    for (let i = 0; i < n; i++) {
      const w = p.window[i];
      acc[at + i] += sr[i] * w;
      norm[at + i] += w * w;
    }
  }

  // A short ramp at each end hands back to the untouched audio. Even with
  // the windows summing flat the two sides differ by rounding, and a hard
  // join between them is a click.
  const blend = Math.max(1, Math.min(hop, Math.floor((end - start) / 2)));
  for (let s = start; s < end; s++) {
    const i = s - from;
    if (i < 0 || i >= span || norm[i] < 1e-6) continue;
    const v = acc[i] / norm[i];
    let t = 1;
    if (s - start < blend) t = (s - start + 1) / (blend + 1);
    else if (end - 1 - s < blend) t = (end - s) / (blend + 1);
    out[s] = out[s] * (1 - t) + v * t;
  }

  return out;
}
