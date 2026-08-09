/**
 * Sample-level edit operations.
 *
 * Everything here is pure: an AudioBuffer goes in, a new AudioBuffer comes
 * out, and the input is never touched. That is what makes undo cheap and
 * correct — history is just an array of buffers, and stepping backwards
 * costs nothing but memory.
 *
 * Cuts are applied at zero crossings where possible, because splicing
 * mid-cycle is what produces the click that gives away an amateur edit.
 */

export type Range = { start: number; end: number };

function ctx(): OfflineAudioContext {
  // Only used as an AudioBuffer factory; never rendered.
  return new OfflineAudioContext(1, 1, 44100);
}

export function makeBuffer(
  channels: number,
  length: number,
  sampleRate: number,
): AudioBuffer {
  return ctx().createBuffer(channels, Math.max(1, length), sampleRate);
}

function cloneShape(src: AudioBuffer, length: number): AudioBuffer {
  return makeBuffer(src.numberOfChannels, length, src.sampleRate);
}

/**
 * Nudge an edit point to the nearest zero crossing within a short window.
 * If the material has no crossing nearby (dense bass, heavy limiting) we
 * leave the point alone rather than move it audibly.
 */
export function snapToZero(
  buffer: AudioBuffer,
  sample: number,
  windowSamples = 128,
): number {
  const d = buffer.getChannelData(0);
  const lo = Math.max(1, sample - windowSamples);
  const hi = Math.min(d.length - 1, sample + windowSamples);

  let best = -1;
  let bestDist = Infinity;
  for (let i = lo; i < hi; i++) {
    // Sign change between consecutive samples brackets a crossing.
    if ((d[i - 1] <= 0 && d[i] >= 0) || (d[i - 1] >= 0 && d[i] <= 0)) {
      const dist = Math.abs(i - sample);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }
  return best === -1 ? sample : best;
}

/** Extract a range into a new buffer. The source is unchanged. */
export function copyRange(buffer: AudioBuffer, r: Range): AudioBuffer {
  const len = Math.max(1, r.end - r.start);
  const out = cloneShape(buffer, len);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(
      buffer.getChannelData(c).subarray(r.start, r.start + len),
      c,
    );
  }
  return out;
}

/** Remove a range, closing the gap. */
export function deleteRange(buffer: AudioBuffer, r: Range): AudioBuffer {
  const removed = r.end - r.start;
  const out = cloneShape(buffer, Math.max(1, buffer.length - removed));

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, r.start), 0);
    dst.set(src.subarray(r.end), r.start);
  }
  return crossfadeSplice(out, r.start, 64);
}

/** Keep only the selected range. */
export function cropTo(buffer: AudioBuffer, r: Range): AudioBuffer {
  return copyRange(buffer, r);
}

/** Insert `clip` at a sample position, pushing later audio right. */
export function insertAt(
  buffer: AudioBuffer,
  clip: AudioBuffer,
  at: number,
): AudioBuffer {
  const out = cloneShape(buffer, buffer.length + clip.length);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const ins = clip.getChannelData(Math.min(c, clip.numberOfChannels - 1));
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, at), 0);
    dst.set(ins, at);
    dst.set(src.subarray(at), at + clip.length);
  }
  return out;
}

/** Replace a range with silence, leaving length untouched. */
export function silenceRange(buffer: AudioBuffer, r: Range): AudioBuffer {
  const out = copyAll(buffer);
  for (let c = 0; c < out.numberOfChannels; c++) {
    out.getChannelData(c).fill(0, r.start, r.end);
  }
  return out;
}

export function copyAll(buffer: AudioBuffer): AudioBuffer {
  const out = cloneShape(buffer, buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c), c);
  }
  return out;
}

/**
 * A very short equal-gain crossfade across a splice point. 64 samples is
 * about 1.3ms at 48k — inaudible as a fade, but enough to swallow the
 * discontinuity that would otherwise read as a click.
 */
function crossfadeSplice(
  buffer: AudioBuffer,
  at: number,
  len: number,
): AudioBuffer {
  const half = Math.floor(len / 2);
  const from = Math.max(0, at - half);
  const to = Math.min(buffer.length, at + half);
  if (to - from < 4) return buffer;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = from; i < to; i++) {
      const t = (i - from) / (to - from);
      // Raised cosine keeps the sum of gains constant through the join.
      const w = 0.5 - 0.5 * Math.cos(Math.PI * 2 * t);
      d[i] *= 1 - w * 0.5;
    }
  }
  return buffer;
}

export type FadeShape = "linear" | "exponential" | "logarithmic" | "scurve";

function fadeCurve(t: number, shape: FadeShape): number {
  switch (shape) {
    case "exponential":
      return t * t;
    case "logarithmic":
      return Math.sqrt(t);
    case "scurve":
      return t * t * (3 - 2 * t); // smoothstep
    default:
      return t;
  }
}

export function fade(
  buffer: AudioBuffer,
  r: Range,
  dir: "in" | "out",
  shape: FadeShape = "scurve",
): AudioBuffer {
  const out = copyAll(buffer);
  const len = Math.max(1, r.end - r.start);

  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const g = fadeCurve(dir === "in" ? t : 1 - t, shape);
      d[r.start + i] *= g;
    }
  }
  return out;
}

/** Apply a gain change in decibels across a range. */
export function gainDb(
  buffer: AudioBuffer,
  db: number,
  r?: Range,
): AudioBuffer {
  const out = copyAll(buffer);
  const g = Math.pow(10, db / 20);
  const start = r?.start ?? 0;
  const end = r?.end ?? out.length;

  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = start; i < end; i++) d[i] *= g;
  }
  return out;
}

/**
 * Normalise to a target peak in dBFS. Gain is computed across all
 * channels together so the stereo image does not shift.
 */
export function normalize(
  buffer: AudioBuffer,
  targetDb = -1,
  r?: Range,
): AudioBuffer {
  const start = r?.start ?? 0;
  const end = r?.end ?? buffer.length;

  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = start; i < end; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak === 0) return copyAll(buffer);

  const target = Math.pow(10, targetDb / 20);
  return gainDb(buffer, 20 * Math.log10(target / peak), r);
}

export function reverse(buffer: AudioBuffer, r?: Range): AudioBuffer {
  const out = copyAll(buffer);
  const start = r?.start ?? 0;
  const end = r?.end ?? out.length;

  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = start, j = end - 1; i < j; i++, j--) {
      const tmp = d[i];
      d[i] = d[j];
      d[j] = tmp;
    }
  }
  return out;
}

/** Flip polarity. Useful for null-testing and for fixing a miswired mic. */
export function invertPhase(buffer: AudioBuffer, r?: Range): AudioBuffer {
  return gainDbRaw(buffer, -1, r);
}

function gainDbRaw(buffer: AudioBuffer, mult: number, r?: Range): AudioBuffer {
  const out = copyAll(buffer);
  const start = r?.start ?? 0;
  const end = r?.end ?? out.length;
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = start; i < end; i++) d[i] *= mult;
  }
  return out;
}

/**
 * Remove DC offset by subtracting each channel's mean. Offset eats
 * headroom and makes normalisation lie about how loud a file really is.
 */
export function removeDcOffset(buffer: AudioBuffer): AudioBuffer {
  const out = copyAll(buffer);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i];
    const mean = sum / d.length;
    if (Math.abs(mean) < 1e-7) continue;
    for (let i = 0; i < d.length; i++) d[i] -= mean;
  }
  return out;
}

/**
 * Strip near-silence from the head and tail. Threshold is in dBFS and the
 * detected edge is padded slightly so breaths and note attacks survive.
 */
export function trimSilence(
  buffer: AudioBuffer,
  thresholdDb = -50,
  padMs = 30,
): AudioBuffer {
  const thr = Math.pow(10, thresholdDb / 20);
  const pad = Math.floor((padMs / 1000) * buffer.sampleRate);

  const loud = (i: number) => {
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      if (Math.abs(buffer.getChannelData(c)[i]) > thr) return true;
    }
    return false;
  };

  let start = 0;
  while (start < buffer.length && !loud(start)) start++;
  let end = buffer.length - 1;
  while (end > start && !loud(end)) end--;

  if (start >= end) return copyAll(buffer);

  return copyRange(buffer, {
    start: Math.max(0, start - pad),
    end: Math.min(buffer.length, end + pad),
  });
}

/** Repeat a range end to end. */
export function repeat(
  buffer: AudioBuffer,
  times: number,
  r?: Range,
): AudioBuffer {
  const clip = r ? copyRange(buffer, r) : buffer;
  const n = Math.max(1, Math.floor(times));
  const out = makeBuffer(
    clip.numberOfChannels,
    clip.length * n,
    clip.sampleRate,
  );
  for (let c = 0; c < out.numberOfChannels; c++) {
    const src = clip.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let k = 0; k < n; k++) dst.set(src, k * clip.length);
  }
  return out;
}

/** Prepend or append silence. */
export function pad(
  buffer: AudioBuffer,
  headSec: number,
  tailSec: number,
): AudioBuffer {
  const head = Math.floor(headSec * buffer.sampleRate);
  const tail = Math.floor(tailSec * buffer.sampleRate);
  const out = cloneShape(buffer, buffer.length + head + tail);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c), head);
  }
  return out;
}

/** Swap left and right. */
export function swapChannels(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels < 2) return copyAll(buffer);
  const out = cloneShape(buffer, buffer.length);
  out.copyToChannel(buffer.getChannelData(1), 0);
  out.copyToChannel(buffer.getChannelData(0), 1);
  for (let c = 2; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c), c);
  }
  return out;
}

/**
 * Mid/side width. 1 is unchanged, 0 collapses to mono, above 1 widens.
 * Pushing past about 1.8 starts to hollow out the centre, which is why
 * the UI caps it there.
 */
export function stereoWidth(buffer: AudioBuffer, width: number): AudioBuffer {
  if (buffer.numberOfChannels < 2) return copyAll(buffer);
  const out = copyAll(buffer);
  const L = out.getChannelData(0);
  const R = out.getChannelData(1);

  for (let i = 0; i < L.length; i++) {
    const mid = (L[i] + R[i]) * 0.5;
    const side = (L[i] - R[i]) * 0.5 * width;
    L[i] = mid + side;
    R[i] = mid - side;
  }
  return out;
}
