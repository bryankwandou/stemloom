/**
 * Waveform peak extraction.
 *
 * Drawing a waveform by reading every sample is wasteful: a four-minute
 * stereo file at 48kHz is 23 million samples and the timeline is maybe
 * 1400 pixels wide. Instead we precompute min/max pairs at a set of zoom
 * levels and pick the closest one when drawing.
 *
 * Storing min and max separately (rather than a single absolute peak) is
 * what makes asymmetric material — most vocals, most brass — look correct
 * rather than mirrored.
 */

export type PeakLevel = {
  /** Samples collapsed into one min/max pair. */
  binSize: number;
  /** Interleaved [min, max, min, max, ...] per channel. */
  data: Float32Array[];
  length: number;
};

export type PeakSet = {
  levels: PeakLevel[];
  channels: number;
  sampleRate: number;
  duration: number;
};

// Powers of two spanning "zoomed in enough to see a click" through
// "whole podcast episode on screen".
const BIN_SIZES = [128, 512, 2048, 8192, 32768];

function buildLevel(buffer: AudioBuffer, binSize: number): PeakLevel {
  const bins = Math.ceil(buffer.length / binSize);
  const data: Float32Array[] = [];

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const out = new Float32Array(bins * 2);

    for (let b = 0; b < bins; b++) {
      const start = b * binSize;
      const end = Math.min(start + binSize, src.length);
      let min = 0;
      let max = 0;
      // Seeding from the first sample rather than 0 avoids drawing a
      // phantom centre line through fully-offset material.
      if (start < end) {
        min = max = src[start];
        for (let i = start + 1; i < end; i++) {
          const v = src[i];
          if (v < min) min = v;
          else if (v > max) max = v;
        }
      }
      out[b * 2] = min;
      out[b * 2 + 1] = max;
    }
    data.push(out);
  }

  return { binSize, data, length: bins };
}

export function computePeaks(buffer: AudioBuffer): PeakSet {
  return {
    levels: BIN_SIZES.map((b) => buildLevel(buffer, b)),
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
  };
}

/**
 * Choose the coarsest level that still gives at least one bin per pixel.
 * Going finer than that costs time and changes nothing on screen.
 */
export function pickLevel(
  peaks: PeakSet,
  samplesPerPixel: number,
): PeakLevel {
  let chosen = peaks.levels[0];
  for (const lvl of peaks.levels) {
    if (lvl.binSize <= samplesPerPixel) chosen = lvl;
    else break;
  }
  return chosen;
}

/**
 * Reduce a peak level down to exactly `width` columns of min/max, ready
 * to hand straight to a canvas path.
 */
export function columnsFor(
  peaks: PeakSet,
  channel: number,
  startSample: number,
  endSample: number,
  width: number,
): { min: Float32Array; max: Float32Array } {
  const spp = (endSample - startSample) / width;
  const lvl = pickLevel(peaks, spp);
  const src = lvl.data[Math.min(channel, lvl.data.length - 1)];

  const min = new Float32Array(width);
  const max = new Float32Array(width);

  for (let x = 0; x < width; x++) {
    const s0 = Math.floor((startSample + x * spp) / lvl.binSize);
    const s1 = Math.max(
      s0 + 1,
      Math.floor((startSample + (x + 1) * spp) / lvl.binSize),
    );

    let lo = 0;
    let hi = 0;
    let seeded = false;
    for (let b = s0; b < s1 && b < lvl.length; b++) {
      const bMin = src[b * 2];
      const bMax = src[b * 2 + 1];
      if (!seeded) {
        lo = bMin;
        hi = bMax;
        seeded = true;
      } else {
        if (bMin < lo) lo = bMin;
        if (bMax > hi) hi = bMax;
      }
    }
    min[x] = lo;
    max[x] = hi;
  }

  return { min, max };
}
