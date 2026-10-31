/**
 * An Ogg container for Opus, written by hand.
 *
 * WebCodecs hands back bare Opus packets, the same way it hands back bare
 * AAC frames. AAC only needed a seven-byte header per frame; Opus needs
 * Ogg, which is pages of packets, each page carrying a checksum and a
 * granule position that says how many samples have been decoded by the
 * end of it. Both are spelled out in RFC 3533 (Ogg) and RFC 7845 (Opus in
 * Ogg), and this file follows them closely enough that the line numbers of
 * the RFCs are a better guide to it than its own comments.
 *
 * Nothing here touches a browser API, so the muxer can be checked in Node.
 */

/** Opus always runs its granule clock at 48 kHz, whatever went in. */
export const OPUS_RATE = 48000;

/* ------------------------------------------------------------------ */
/* CRC                                                                 */
/* ------------------------------------------------------------------ */

// Ogg's CRC is the unreflected CRC-32 with polynomial 0x04C11DB7, zero
// initial value, and no final xor. It is not the zlib CRC, which reflects
// its bits; reusing that one is the usual way to write an Ogg file that
// every player rejects.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;

/**
 * One page holding whole packets. Lacing splits each packet into 255-byte
 * segments; a packet whose length is an exact multiple of 255 needs a
 * zero-length segment after it, or the reader takes it to continue.
 */
function page(
  packets: Uint8Array[],
  granule: bigint,
  serial: number,
  sequence: number,
  flags: number,
): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) {
    throw new Error("Too many segments for one Ogg page.");
  }

  const body = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(out.buffer);

  out.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  out[4] = 0; // stream structure version
  out[5] = flags;
  v.setBigUint64(6, granule, true);
  v.setUint32(14, serial, true);
  v.setUint32(18, sequence, true);
  // Bytes 22-25 hold the CRC, computed with them zeroed, filled below.
  out[26] = lacing.length;
  out.set(lacing, 27);

  let at = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }

  v.setUint32(22, oggCrc(out), true);
  return out;
}

/** The identification header, RFC 7845 section 5.1. */
export function opusHead(
  channels: number,
  preSkip: number,
  inputRate: number,
): Uint8Array {
  const h = new Uint8Array(19);
  const v = new DataView(h.buffer);
  h.set(new TextEncoder().encode("OpusHead"), 0);
  h[8] = 1; // version
  h[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  v.setInt16(16, 0, true); // output gain
  h[18] = 0; // channel mapping family: mono or stereo, no table
  return h;
}

/** The comment header, RFC 7845 section 5.2. */
export function opusTags(vendor = "Stemloom"): Uint8Array {
  const name = new TextEncoder().encode(vendor);
  const h = new Uint8Array(8 + 4 + name.length + 4);
  const v = new DataView(h.buffer);
  h.set(new TextEncoder().encode("OpusTags"), 0);
  v.setUint32(8, name.length, true);
  h.set(name, 12);
  v.setUint32(12 + name.length, 0, true); // no user comments
  return h;
}

export type OpusPacket = {
  data: Uint8Array;
  /** Samples this packet decodes to, at 48 kHz. */
  samples: number;
};

export type OggOpusOptions = {
  channels: number;
  /** Samples the decoder must discard from the start, at 48 kHz. */
  preSkip: number;
  /** The rate the audio had before encoding; informational only. */
  inputRate: number;
  /** Real length of the audio, at 48 kHz, so the padded tail is trimmed. */
  totalSamples: number;
  serial?: number;
};

/**
 * Wrap Opus packets in an Ogg stream.
 *
 * The two headers get a page each, as the spec requires. Audio follows at
 * up to a second per page, which keeps the overhead under one percent
 * while still letting a player seek to within a second.
 *
 * The final page's granule is set to the true length plus pre-skip rather
 * than the sum of packet durations. The encoder pads the last frame with
 * silence; this is how a reader learns to cut that padding off again, so
 * a file goes in and comes out the same length.
 */
export function muxOggOpus(
  packets: OpusPacket[],
  opts: OggOpusOptions,
): Uint8Array[] {
  const serial = opts.serial ?? (Math.random() * 0xffffffff) >>> 0;
  const pages: Uint8Array[] = [];
  let seq = 0;

  pages.push(
    page([opusHead(opts.channels, opts.preSkip, opts.inputRate)], BigInt(0), serial, seq++, FLAG_BOS),
  );
  pages.push(page([opusTags()], BigInt(0), serial, seq++, 0));

  const end = BigInt(opts.preSkip + opts.totalSamples);
  let granule = BigInt(0);
  let batch: Uint8Array[] = [];
  let segments = 0;
  let batchSamples = 0;

  const flush = (last: boolean) => {
    if (batch.length === 0 && !last) return;
    let g = granule;
    if (last || g > end) g = end;
    pages.push(page(batch, g, serial, seq++, last ? FLAG_EOS : 0));
    batch = [];
    segments = 0;
    batchSamples = 0;
  };

  packets.forEach((p, i) => {
    const need = Math.floor(p.data.length / 255) + 1;
    if (segments + need > 255 || batchSamples >= OPUS_RATE) flush(false);
    batch.push(p.data);
    segments += need;
    batchSamples += p.samples;
    granule += BigInt(p.samples);
    if (i === packets.length - 1) flush(true);
  });

  // A stream with no audio still has to end.
  if (packets.length === 0) flush(true);

  return pages;
}
