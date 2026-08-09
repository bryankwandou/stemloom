/**
 * WAV (RIFF) reader and writer, written from scratch.
 *
 * The browser will happily decode a WAV for us, but it will not write one,
 * and it always hands back 32-bit float at the context sample rate. Owning
 * the encoder is what makes real export options possible: bit depth, sample
 * rate, channel count, and dithering are all decisions we get to make here
 * rather than accept.
 */

export type BitDepth = 16 | 24 | 32;

export type EncodeOptions = {
  bitDepth?: BitDepth;
  /** Triangular dither on down-conversion to fixed point. */
  dither?: boolean;
  /** 1 = downmix to mono, 2 = keep/expand to stereo. */
  channels?: 1 | 2;
};

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** Triangular probability density dither — two uniform sources summed. */
function tpdf(scale: number) {
  return (Math.random() - Math.random()) * scale;
}

/**
 * Collect channel data, applying any requested channel-count change.
 * Downmix is -3dB per side so a centred mono source does not clip.
 */
function shapeChannels(buffer: AudioBuffer, want?: 1 | 2): Float32Array[] {
  const have = buffer.numberOfChannels;
  const target = want ?? (have >= 2 ? 2 : 1);

  if (target === have) {
    return Array.from({ length: have }, (_, c) =>
      new Float32Array(buffer.getChannelData(c)),
    );
  }

  if (target === 1) {
    const out = new Float32Array(buffer.length);
    for (let c = 0; c < have; c++) {
      const src = buffer.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += src[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= have;
    return [out];
  }

  // Mono source, stereo target: duplicate rather than synthesise width.
  const mono = new Float32Array(buffer.getChannelData(0));
  return [mono, new Float32Array(mono)];
}

export function encodeWav(
  buffer: AudioBuffer,
  opts: EncodeOptions = {},
): Blob {
  const bitDepth = opts.bitDepth ?? 24;
  const dither = opts.dither ?? bitDepth < 32;
  const chans = shapeChannels(buffer, opts.channels);

  const numCh = chans.length;
  const frames = chans[0].length;
  const bytesPerSample = bitDepth / 8;
  const isFloat = bitDepth === 32;
  const blockAlign = numCh * bytesPerSample;
  const dataBytes = frames * blockAlign;

  // RIFF header is 44 bytes for the canonical PCM layout.
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  let p = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  const u32 = (v: number) => {
    view.setUint32(p, v, true);
    p += 4;
  };
  const u16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };

  str("RIFF");
  u32(36 + dataBytes);
  str("WAVE");
  str("fmt ");
  u32(16);
  u16(isFloat ? 3 : 1); // 3 = IEEE float, 1 = integer PCM
  u16(numCh);
  u32(buffer.sampleRate);
  u32(buffer.sampleRate * blockAlign); // byte rate
  u16(blockAlign);
  u16(bitDepth);
  str("data");
  u32(dataBytes);

  // Interleave. Sample order in a WAV is frame-major, channel-minor.
  if (isFloat) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        view.setFloat32(p, chans[c][i], true);
        p += 4;
      }
    }
  } else if (bitDepth === 16) {
    const d = dither ? 0.5 : 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = clamp(chans[c][i] * 32767 + tpdf(d), -32768, 32767);
        view.setInt16(p, Math.round(s), true);
        p += 2;
      }
    }
  } else {
    // 24-bit has no DataView helper; write three little-endian bytes.
    const d = dither ? 0.5 : 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.round(
          clamp(chans[c][i] * 8388607 + tpdf(d), -8388608, 8388607),
        );
        const u = s < 0 ? s + 0x1000000 : s;
        view.setUint8(p++, u & 0xff);
        view.setUint8(p++, (u >> 8) & 0xff);
        view.setUint8(p++, (u >> 16) & 0xff);
      }
    }
  }

  return new Blob([out], { type: "audio/wav" });
}

/**
 * Peak and true-RMS of a buffer, used by the export dialog to warn about
 * clipping before the user commits to a render.
 */
export function analyse(buffer: AudioBuffer) {
  let peak = 0;
  let sumSq = 0;
  let count = 0;
  let clipped = 0;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += d[i] * d[i];
    }
    count += d.length;
  }

  const rms = Math.sqrt(sumSq / Math.max(1, count));
  return {
    peak,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    rms,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    clippedSamples: clipped,
  };
}
