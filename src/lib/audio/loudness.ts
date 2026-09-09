/**
 * Loudness measurement to ITU-R BS.1770-4.
 *
 * Peak level tells you almost nothing about how loud something sounds. A
 * heavily limited pop master and a quiet acoustic take can both peak at
 * -0.1 dBFS and be twenty decibels apart to the ear. Every streaming
 * platform normalises on LUFS instead, so a tool that lets you export
 * without knowing your integrated loudness is setting you up to be turned
 * down by Spotify.
 *
 * The measurement has three parts: a K-weighting filter that approximates
 * how the ear responds across the spectrum, a mean-square over overlapping
 * 400ms blocks, and a two-stage gate that discards silence so a track with
 * long pauses is not scored as quieter than it plays.
 */

export type LoudnessReport = {
  /** Gated loudness over the whole programme, in LUFS. */
  integrated: number;
  /** Loudest single 400ms block. */
  shortTermMax: number;
  /** Loudness range: spread between the 10th and 95th percentile blocks. */
  range: number;
  /** Inter-sample peak, measured at four times the sample rate. */
  truePeak: number;
  truePeakDb: number;
  samplePeakDb: number;
  /** How much gain to apply to land on a given target. */
  gainToTarget: (targetLufs: number) => number;
};

type Biquad = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

/**
 * Stage one of K-weighting: a high shelf that stands in for the way a head
 * placed in a sound field boosts high frequencies.
 */
function shelfFilter(fs: number): Biquad {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;

  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;

  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

/** Stage two: a high pass that removes rumble the ear barely registers. */
function highpassFilter(fs: number): Biquad {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;

  const K = Math.tan((Math.PI * f0) / fs);
  const denom = 1 + K / Q + K * K;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / denom,
    a2: (1 - K / Q + K * K) / denom,
  };
}

/** Direct form I, in place. */
function applyBiquad(data: Float32Array, f: Biquad) {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 =
      f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    data[i] = y0;
  }
}

/**
 * Channel weights from the standard. Surround channels count for more
 * because they arrive off-axis; front channels are unweighted.
 */
function channelWeight(index: number, total: number): number {
  if (total <= 2) return 1;
  // 5.1 ordering: L R C LFE Ls Rs. LFE is excluded entirely.
  if (index === 3) return 0;
  return index >= 4 ? 1.41 : 1;
}

const MIN_LUFS = -70;

export async function measureLoudness(
  buffer: AudioBuffer,
): Promise<LoudnessReport> {
  const fs = buffer.sampleRate;
  const shelf = shelfFilter(fs);
  const hp = highpassFilter(fs);

  // K-weight a copy. The filters are destructive and the caller's audio
  // must survive being measured.
  const weighted: Float32Array[] = [];
  const weights: number[] = [];

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const w = channelWeight(c, buffer.numberOfChannels);
    weights.push(w);
    if (w === 0) {
      weighted.push(new Float32Array(0));
      continue;
    }
    const copy = new Float32Array(buffer.getChannelData(c));
    applyBiquad(copy, shelf);
    applyBiquad(copy, hp);
    weighted.push(copy);
  }

  // 400ms blocks advancing by 100ms, as the standard specifies.
  const blockLen = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  const blocks: number[] = [];

  for (let start = 0; start + blockLen <= buffer.length; start += step) {
    let sum = 0;
    for (let c = 0; c < weighted.length; c++) {
      if (weights[c] === 0) continue;
      const d = weighted[c];
      let acc = 0;
      for (let i = start; i < start + blockLen; i++) acc += d[i] * d[i];
      sum += weights[c] * (acc / blockLen);
    }
    blocks.push(sum);
  }

  if (blocks.length === 0) {
    return report(MIN_LUFS, MIN_LUFS, 0, 0, buffer);
  }

  const toLufs = (meanSquare: number) =>
    meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : MIN_LUFS;

  // First gate: throw away anything below absolute silence threshold.
  const aboveAbsolute = blocks.filter((b) => toLufs(b) > MIN_LUFS);
  if (aboveAbsolute.length === 0) {
    return report(MIN_LUFS, MIN_LUFS, 0, 0, buffer);
  }

  const meanOf = (xs: number[]) =>
    xs.reduce((a, b) => a + b, 0) / xs.length;

  // Second gate: relative to the ungated mean, drop anything more than
  // 10 LU below it. This is what stops long silences dragging the number
  // down on sparse material.
  const relativeThreshold = toLufs(meanOf(aboveAbsolute)) - 10;
  const gated = aboveAbsolute.filter((b) => toLufs(b) > relativeThreshold);

  const integrated = toLufs(meanOf(gated.length ? gated : aboveAbsolute));

  const blockLufs = aboveAbsolute.map(toLufs).sort((a, b) => a - b);
  const shortTermMax = blockLufs[blockLufs.length - 1];

  // Loudness range, per EBU Tech 3342: the spread between the quiet and
  // loud ends of the distribution, ignoring the extremes.
  const pct = (p: number) =>
    blockLufs[
      Math.min(blockLufs.length - 1, Math.floor(blockLufs.length * p))
    ];
  const range = Math.max(0, pct(0.95) - pct(0.1));

  const truePeak = await measureTruePeak(buffer);

  return report(integrated, shortTermMax, range, truePeak, buffer);
}

function report(
  integrated: number,
  shortTermMax: number,
  range: number,
  truePeak: number,
  buffer: AudioBuffer,
): LoudnessReport {
  let samplePeak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > samplePeak) samplePeak = a;
    }
  }

  return {
    integrated,
    shortTermMax,
    range,
    truePeak,
    truePeakDb: truePeak > 0 ? 20 * Math.log10(truePeak) : -Infinity,
    samplePeakDb: samplePeak > 0 ? 20 * Math.log10(samplePeak) : -Infinity,
    gainToTarget: (target: number) => target - integrated,
  };
}

/**
 * Inter-sample peak.
 *
 * A signal can sit at -0.2 dBFS on every sample and still overshoot 0 dB
 * between them, which is where converters and lossy encoders distort.
 * Oversampling by four reveals it. The browser's own resampler is used
 * because it interpolates far better than anything worth hand-writing here.
 */
async function measureTruePeak(buffer: AudioBuffer): Promise<number> {
  const rate = Math.min(192000, buffer.sampleRate * 4);

  try {
    const ctx = new OfflineAudioContext(
      buffer.numberOfChannels,
      Math.ceil(buffer.duration * rate),
      rate,
    );
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    const up = await ctx.startRendering();

    let peak = 0;
    for (let c = 0; c < up.numberOfChannels; c++) {
      const d = up.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    return peak;
  } catch {
    // Some rates are rejected by the platform; fall back to sample peak.
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    return peak;
  }
}

/** Reference targets people actually deliver to. */
export const LOUDNESS_TARGETS = [
  { name: "Spotify, Amazon, YouTube", lufs: -14, peak: -1 },
  { name: "Apple Music", lufs: -16, peak: -1 },
  { name: "Broadcast (EBU R128)", lufs: -23, peak: -1 },
  { name: "Club and CD master", lufs: -9, peak: -0.3 },
] as const;
