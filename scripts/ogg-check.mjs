/**
 * Checks for the hand-written Ogg muxer.
 *
 * The CRC is held to a published value: Ogg's checksum is CRC-32/CKSUM
 * without the final inversion, whose check value for "123456789" is
 * 0x765E7680, so Ogg's must be 0x89A1897F. Everything else is checked by
 * reading the stream back the way a player would — page by page, verifying
 * every checksum, and reassembling packets from the lacing values.
 *
 *   npx tsc src/lib/audio/ogg.ts --target es2020 --module es2020 --skipLibCheck --outDir .tmp-check
 *   node scripts/ogg-check.mjs
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { oggCrc, muxOggOpus } = await import(
  pathToFileURL(resolve(".tmp-check/ogg.js")).href
);

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}

/** Read a stream back into pages and packets, verifying as a player does. */
function demux(bytes) {
  const pages = [];
  const packets = [];
  let partial = [];
  let at = 0;
  while (at < bytes.length) {
    const magic = String.fromCharCode(...bytes.slice(at, at + 4));
    if (magic !== "OggS") throw new Error(`no capture pattern at ${at}`);
    const v = new DataView(bytes.buffer, bytes.byteOffset + at);
    const nseg = bytes[at + 26];
    const lacing = [...bytes.slice(at + 27, at + 27 + nseg)];
    const bodyLen = lacing.reduce((a, b) => a + b, 0);
    const len = 27 + nseg + bodyLen;
    const raw = bytes.slice(at, at + len);
    const stored = v.getUint32(22, true);
    raw.fill(0, 22, 26);
    pages.push({
      flags: bytes[at + 5],
      granule: v.getBigUint64(6, true),
      serial: v.getUint32(14, true),
      seq: v.getUint32(18, true),
      crcOk: oggCrc(raw) === stored,
      nseg,
    });
    let p = at + 27 + nseg;
    for (const l of lacing) {
      partial.push(bytes.slice(p, p + l));
      p += l;
      if (l < 255) {
        const total = partial.reduce((a, b) => a + b.length, 0);
        const pk = new Uint8Array(total);
        let o = 0;
        for (const s of partial) {
          pk.set(s, o);
          o += s.length;
        }
        packets.push(pk);
        partial = [];
      }
    }
    at += len;
  }
  return { pages, packets };
}

const join = (arrs) => {
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

// ---- CRC ----
const crc = oggCrc(new TextEncoder().encode("123456789"));
check("CRC matches the published check value", crc === 0x89a1897f, `0x${crc.toString(16)}`);
check("CRC of nothing is zero", oggCrc(new Uint8Array(0)) === 0);

// ---- A realistic stream ----
// Packets of awkward sizes: tiny, exactly 255, exactly 510, and large.
const sizes = [3, 255, 510, 700, 254, 256, 1];
const input = [];
for (let i = 0; i < 300; i++) {
  const n = sizes[i % sizes.length];
  const d = new Uint8Array(n);
  for (let k = 0; k < n; k++) d[k] = (i * 31 + k) & 0xff;
  input.push({ data: d, samples: 960 });
}
const preSkip = 312;
const totalSamples = 300 * 960 - 500; // the encoder padded the last frame
const stream = join(
  muxOggOpus(input, { channels: 2, preSkip, inputRate: 44100, totalSamples, serial: 0x1234 }),
);
const { pages, packets } = demux(stream);

check("every page's checksum verifies", pages.every((p) => p.crcOk), `${pages.length} pages`);
check(
  "first page is BOS and alone carries OpusHead",
  pages[0].flags === 0x02 && pages[0].granule === 0n &&
    String.fromCharCode(...packets[0].slice(0, 8)) === "OpusHead",
);
check(
  "second page carries OpusTags, granule zero",
  pages[1].granule === 0n && String.fromCharCode(...packets[1].slice(0, 8)) === "OpusTags",
);
const head = new DataView(packets[0].buffer, packets[0].byteOffset);
check(
  "OpusHead records channels, pre-skip, and input rate",
  packets[0][8] === 1 && packets[0][9] === 2 && head.getUint16(10, true) === preSkip &&
    head.getUint32(12, true) === 44100,
);
check(
  "only the last page is EOS",
  pages.at(-1).flags === 0x04 && pages.slice(0, -1).every((p) => !(p.flags & 0x04)),
);
check(
  "sequence numbers run unbroken from zero",
  pages.every((p, i) => p.seq === i) && pages.every((p) => p.serial === 0x1234),
);
check(
  "final granule trims the encoder's padding",
  pages.at(-1).granule === BigInt(preSkip + totalSamples),
  `${pages.at(-1).granule} vs ${preSkip + totalSamples}`,
);
check(
  "granules never go backwards",
  pages.every((p, i) => i === 0 || p.granule >= pages[i - 1].granule),
);
check("no page exceeds 255 segments", pages.every((p) => p.nseg <= 255));

const audio = packets.slice(2);
check(
  "every packet comes back byte for byte, including 255 and 510",
  audio.length === input.length &&
    audio.every((p, i) => p.length === input[i].data.length && p.every((b, k) => b === input[i].data[k])),
  `${audio.length} of ${input.length}`,
);

// ---- Edge cases ----
const empty = demux(join(muxOggOpus([], { channels: 1, preSkip, inputRate: 48000, totalSamples: 0 })));
check(
  "a stream with no audio still opens and closes",
  empty.pages.length === 3 && empty.pages.at(-1).flags === 0x04 && empty.pages.every((p) => p.crcOk),
);

const big = [];
for (let i = 0; i < 40; i++) big.push({ data: new Uint8Array(4000).fill(i), samples: 960 });
const bigDemux = demux(join(muxOggOpus(big, { channels: 2, preSkip, inputRate: 48000, totalSamples: 40 * 960 })));
check(
  "packets too big for one page's lacing split across pages",
  bigDemux.pages.every((p) => p.nseg <= 255 && p.crcOk) && bigDemux.packets.length === 42,
  `${bigDemux.pages.length} pages`,
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
