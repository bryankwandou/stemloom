/**
 * Time stretching and pitch shifting that do not drag each other along.
 *
 * The naive way to change pitch in a browser is to alter playbackRate,
 * which is what tape does: speed and pitch move together. Separating them
 * needs an actual algorithm, so this is WSOLA — waveform similarity
 * overlap-add.
 *
 * The idea is straightforward. Chop the source into overlapping grains,
 * lay them back down at a different spacing, and crossfade the joins. Done
 * blindly that produces a metallic warble, because consecutive grains land
 * out of phase with each other. WSOLA fixes it by searching a small window
 * around each ideal grain position for the offset whose waveform best
 * matches what was already written, then taking the grain from there. The
 * search is what costs the time and buys the quality.
 *
 * Pitch shifting is then just stretching by a ratio and resampling by its
 * inverse, which lands back at the original length with a different pitch.
 */

const FRAME = 2048;
const OVERLAP = 0.5;
/** How far either side of the ideal position we look for a better match. */
const SEEK = 512;

/**
 * Buffers handed to `copyToChannel` must be backed by a plain ArrayBuffer,
 * never a shared one, so the concrete type is pinned throughout.
 */
type Samples = Float32Array<ArrayBuffer>;

/** Raised cosine, so two overlapped grains sum back to unity gain. */
function hann(n: number): Samples {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

/**
 * Cross-correlation between the tail already written and a candidate
 * grain. Higher is a better phase match.
 *
 * Normalising by the candidate's own energy stops loud grains from always
 * winning regardless of how well they actually line up.
 */
function similarity(
  a: Float32Array,
  aOff: number,
  b: Float32Array,
  bOff: number,
  len: number,
): number {
  let dot = 0;
  let energy = 0;
  // Stepping by two halves the cost and changes the chosen offset almost
  // never — the correlation surface is smooth at this scale.
  for (let i = 0; i < len; i += 2) {
    const x = a[aOff + i] ?? 0;
    const y = b[bOff + i] ?? 0;
    dot += x * y;
    energy += y * y;
  }
  return dot / (Math.sqrt(energy) + 1e-9);
}

/**
 * Stretch one channel by `ratio`. Above 1 makes it longer and slower,
 * below 1 shorter and faster. Pitch is unchanged either way.
 */
function stretchChannel(
  input: Float32Array,
  ratio: number,
  window: Samples,
): Samples {
  const hop = Math.round(FRAME * (1 - OVERLAP));
  const outHop = Math.round(hop * ratio);
  const outLen = Math.ceil(input.length * ratio) + FRAME;

  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);

  let outPos = 0;
  let readPos = 0;

  while (readPos + FRAME + SEEK < input.length && outPos + FRAME < outLen) {
    let best = readPos;

    // Only search once there is something written to match against.
    if (outPos > FRAME) {
      const overlapLen = FRAME - hop;
      let bestScore = -Infinity;

      const from = Math.max(0, readPos - SEEK);
      const to = Math.min(input.length - FRAME, readPos + SEEK);

      // Coarse pass on a stride, then refine. A full sample-by-sample
      // sweep over 1024 candidates per grain is far too slow for a
      // multi-minute file and finds the same peak.
      for (let cand = from; cand <= to; cand += 8) {
        const score = similarity(out, outPos, input, cand, overlapLen);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      for (
        let cand = Math.max(from, best - 8);
        cand <= Math.min(to, best + 8);
        cand++
      ) {
        const score = similarity(out, outPos, input, cand, overlapLen);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }

    for (let i = 0; i < FRAME; i++) {
      const w = window[i];
      out[outPos + i] += input[best + i] * w;
      norm[outPos + i] += w;
    }

    // Advance the read head by the nominal hop from the *ideal* position,
    // not from where the search landed. Otherwise the drift accumulates
    // and the output ends up the wrong length.
    readPos += hop;
    outPos += outHop;
  }

  // Undo the window weighting. Where coverage is thin, leave it alone
  // rather than amplify a near-zero denominator into noise.
  for (let i = 0; i < outLen; i++) {
    if (norm[i] > 0.35) out[i] /= norm[i];
  }

  return out.subarray(0, Math.min(outLen, Math.ceil(input.length * ratio)));
}

/** Linear resampling. Adequate here because the material is already band-limited. */
function resample(input: Float32Array, ratio: number): Samples {
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = input[i0] ?? 0;
    const b = input[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function makeBuffer(channels: number, length: number, rate: number) {
  return new OfflineAudioContext(1, 1, 44100).createBuffer(
    channels,
    Math.max(1, length),
    rate,
  );
}

/**
 * Change duration without touching pitch.
 * `ratio` 2 is twice as long; 0.5 is half.
 */
export function timeStretch(buffer: AudioBuffer, ratio: number): AudioBuffer {
  if (Math.abs(ratio - 1) < 0.001) return buffer;

  const window = hann(FRAME);
  const chans: Samples[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    chans.push(stretchChannel(buffer.getChannelData(c), ratio, window));
  }

  const out = makeBuffer(chans.length, chans[0].length, buffer.sampleRate);
  chans.forEach((d, c) => out.copyToChannel(d, c));
  return out;
}

/**
 * Change pitch without touching duration.
 *
 * Stretch by the pitch ratio, then resample by the same ratio. The two
 * operations cancel in length and compound in pitch.
 */
export function pitchShift(
  buffer: AudioBuffer,
  semitones: number,
): AudioBuffer {
  if (Math.abs(semitones) < 0.01) return buffer;

  const ratio = Math.pow(2, semitones / 12);
  const window = hann(FRAME);

  const chans: Samples[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const stretched = stretchChannel(buffer.getChannelData(c), ratio, window);
    chans.push(resample(stretched, ratio));
  }

  const out = makeBuffer(chans.length, chans[0].length, buffer.sampleRate);
  chans.forEach((d, c) => out.copyToChannel(d, c));
  return out;
}

/**
 * Resample to a different sample rate, preserving both pitch and duration.
 * Uses an OfflineAudioContext so the browser's own interpolator does the
 * work, which is better than the linear one above.
 */
export async function resampleTo(
  buffer: AudioBuffer,
  targetRate: number,
): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetRate) return buffer;

  const length = Math.ceil(buffer.duration * targetRate);
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    length,
    targetRate,
  );
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}
