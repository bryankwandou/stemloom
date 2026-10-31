/**
 * Compressed export.
 *
 * Rather than ship an MP3 encoder as a dependency, this drives the AAC
 * encoder the browser already has through WebCodecs. WebCodecs hands back
 * bare AAC access units with no container, so the frames are wrapped in
 * ADTS headers here — seven bytes each, written by hand. An .aac file that
 * is just ADTS frames back to back plays in every player worth naming and
 * imports into every editor.
 *
 * WebCodecs is not everywhere yet. Callers should check `canEncodeAac`
 * first and offer WAV, which always works, when it returns false.
 */

// Index into the sample rate table baked into the AAC bitstream format.
const RATE_INDEX: Record<number, number> = {
  96000: 0,
  88200: 1,
  64000: 2,
  48000: 3,
  44100: 4,
  32000: 5,
  24000: 6,
  22050: 7,
  16000: 8,
  12000: 9,
  11025: 10,
  8000: 11,
  7350: 12,
};

export function canEncodeAac(): boolean {
  return (
    typeof window !== "undefined" &&
    "AudioEncoder" in window &&
    "AudioData" in window
  );
}

/** Seven-byte ADTS header describing the frame that follows it. */
function adtsHeader(
  payloadBytes: number,
  sampleRate: number,
  channels: number,
): Uint8Array {
  const rateIdx = RATE_INDEX[sampleRate] ?? 4;
  const frameLen = payloadBytes + 7;
  const h = new Uint8Array(7);

  // Syncword, MPEG-4, layer 0, no CRC.
  h[0] = 0xff;
  h[1] = 0xf1;

  // Profile (AAC LC = 1, stored as value-1 = 01), rate index, channel cfg.
  h[2] =
    (0x01 << 6) | (rateIdx << 2) | ((channels >> 2) & 0x01);

  h[3] = ((channels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
  h[4] = (frameLen >> 3) & 0xff;
  h[5] = ((frameLen & 0x07) << 5) | 0x1f;

  // Buffer fullness 0x7FF means variable rate; one raw block per frame.
  h[6] = 0xfc;

  return h;
}

export type AacOptions = {
  /** Bits per second across all channels. */
  bitrate?: number;
  channels?: 1 | 2;
  onProgress?: (fraction: number) => void;
};

export async function encodeAac(
  buffer: AudioBuffer,
  opts: AacOptions = {},
): Promise<Blob> {
  if (!canEncodeAac()) {
    throw new Error("This browser has no AAC encoder available.");
  }

  const channels = opts.channels ?? Math.min(2, buffer.numberOfChannels);
  const bitrate = opts.bitrate ?? 192000;
  const rate = buffer.sampleRate;

  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      chunks.push(adtsHeader(payload.length, rate, channels));
      chunks.push(payload);
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });

  encoder.configure({
    codec: "mp4a.40.2", // AAC-LC
    sampleRate: rate,
    numberOfChannels: channels,
    bitrate,
  });

  // WebCodecs wants interleaved f32 for this layout.
  const FRAME = 1024;
  const total = buffer.length;
  const interleaved = new Float32Array(FRAME * channels);

  for (let pos = 0; pos < total; pos += FRAME) {
    if (failure) break;

    const count = Math.min(FRAME, total - pos);

    for (let c = 0; c < channels; c++) {
      const src = buffer.getChannelData(
        Math.min(c, buffer.numberOfChannels - 1),
      );
      for (let i = 0; i < count; i++) {
        interleaved[i * channels + c] = src[pos + i];
      }
    }
    // Zero the tail of a short final frame so it does not repeat the
    // previous block's contents.
    if (count < FRAME) interleaved.fill(0, count * channels);

    const data = new AudioData({
      format: "f32",
      sampleRate: rate,
      numberOfFrames: FRAME,
      numberOfChannels: channels,
      timestamp: Math.round((pos / rate) * 1e6),
      data: interleaved,
    });

    encoder.encode(data);
    data.close();

    opts.onProgress?.(pos / total);

    // Let the encoder drain so a long file does not build an unbounded
    // queue and blow out memory.
    if (encoder.encodeQueueSize > 16) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (encoder.encodeQueueSize <= 4) resolve();
          else setTimeout(check, 4);
        };
        check();
      });
    }
  }

  await encoder.flush();
  encoder.close();

  if (failure) throw failure;

  opts.onProgress?.(1);
  return new Blob(chunks as BlobPart[], { type: "audio/aac" });
}

export type ExportFormat = "wav" | "aac" | "opus";

export const FORMAT_INFO: Record<
  ExportFormat,
  { label: string; ext: string; lossless: boolean; note: string }
> = {
  wav: {
    label: "WAV",
    ext: "wav",
    lossless: true,
    note: "Uncompressed. Every sample preserved. Large files.",
  },
  aac: {
    label: "AAC",
    ext: "aac",
    lossless: false,
    note: "Compressed via the browser's own encoder. Roughly a tenth the size.",
  },
  opus: {
    label: "Opus",
    ext: "opus",
    lossless: false,
    note: "Ogg Opus, an open codec with no licence attached. Always encoded at 48 kHz, whatever rate is chosen below.",
  },
};

/* ------------------------------------------------------------------ */
/* Opus in Ogg                                                         */
/* ------------------------------------------------------------------ */

/**
 * Whether this browser's WebCodecs offers an Opus encoder. Checked rather
 * than assumed: AudioEncoder existing says nothing about which codecs it
 * was built with.
 */
export async function canEncodeOpus(): Promise<boolean> {
  if (!canEncodeAac()) return false;
  try {
    const r = await AudioEncoder.isConfigSupported({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128000,
    });
    return !!r.supported;
  } catch {
    return false;
  }
}

/** Opus only runs at 48 kHz; anything else is resampled first. */
async function to48k(buffer: AudioBuffer, channels: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === 48000 && buffer.numberOfChannels >= channels) return buffer;
  const length = Math.ceil((buffer.length * 48000) / buffer.sampleRate);
  const ctx = new OfflineAudioContext(channels, Math.max(1, length), 48000);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

/**
 * libopus at 48 kHz looks 312 samples ahead, and that is what Chrome's
 * encoder reports in the header it attaches to its first chunk. Read from
 * there when it is present so a different build cannot drift the timing.
 */
const DEFAULT_PRE_SKIP = 312;

export async function encodeOpus(
  input: AudioBuffer,
  opts: AacOptions = {},
): Promise<Blob> {
  const { muxOggOpus, OPUS_RATE } = await import("./ogg");
  const channels = opts.channels ?? Math.min(2, input.numberOfChannels);
  const bitrate = Math.min(510000, opts.bitrate ?? 160000);
  const buffer = await to48k(input, channels);

  const packets: { data: Uint8Array; samples: number }[] = [];
  let preSkip = DEFAULT_PRE_SKIP;
  let failure: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc && packets.length === 0) {
        const bytes = ArrayBuffer.isView(desc)
          ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
          : new Uint8Array(desc);
        // An OpusHead: "OpusHead", version, channels, then pre-skip.
        if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 8)) === "OpusHead") {
          preSkip = bytes[10] | (bytes[11] << 8);
        }
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const samples = Math.round(((chunk.duration ?? 20000) * OPUS_RATE) / 1e6);
      packets.push({ data, samples });
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });

  encoder.configure({
    codec: "opus",
    sampleRate: OPUS_RATE,
    numberOfChannels: channels,
    bitrate,
  });

  // Twenty milliseconds, Opus's own default frame.
  const FRAME = 960;
  const total = buffer.length;
  const interleaved = new Float32Array(FRAME * channels);

  for (let pos = 0; pos < total; pos += FRAME) {
    if (failure) break;
    const count = Math.min(FRAME, total - pos);
    for (let c = 0; c < channels; c++) {
      const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      for (let i = 0; i < count; i++) interleaved[i * channels + c] = src[pos + i];
    }
    if (count < FRAME) interleaved.fill(0, count * channels);

    const data = new AudioData({
      format: "f32",
      sampleRate: OPUS_RATE,
      numberOfFrames: FRAME,
      numberOfChannels: channels,
      timestamp: Math.round((pos / OPUS_RATE) * 1e6),
      data: interleaved,
    });
    encoder.encode(data);
    data.close();
    opts.onProgress?.(pos / total);

    if (encoder.encodeQueueSize > 16) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (encoder.encodeQueueSize <= 4) resolve();
          else setTimeout(check, 4);
        };
        check();
      });
    }
  }

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  const pages = muxOggOpus(packets, {
    channels,
    preSkip,
    inputRate: input.sampleRate,
    totalSamples: total,
  });
  opts.onProgress?.(1);
  return new Blob(pages as BlobPart[], { type: "audio/ogg" });
}
