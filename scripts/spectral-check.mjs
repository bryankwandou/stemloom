/**
 * Numerical checks for spectral repair.
 *
 * The claim being tested is narrow and specific: a rectangle of the
 * transform can be rewritten without disturbing anything outside it. So
 * the first check is that an edit which changes nothing gives the samples
 * back unchanged, and the rest measure what a real edit leaves behind.
 *
 *   npx tsc src/lib/audio/spectral.ts src/lib/audio/spectrogram.ts \
 *     --target es2020 --module es2020 --skipLibCheck --outDir .tmp-check
 *   node scripts/fix-esm.mjs .tmp-check
 *   node scripts/spectral-check.mjs
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = process.argv[2] ?? ".tmp-check/spectral.js";
const { repairChannel } = await import(pathToFileURL(resolve(mod)).href);

const SR = 48000;
let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function tone(buf, hz, amp, from = 0, to = buf.length) {
  for (let i = from; i < to; i++) {
    buf[i] += amp * Math.sin((2 * Math.PI * hz * i) / SR);
  }
}

/** Level of one frequency in a range, by direct correlation. */
function levelAt(buf, hz, from, to) {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const a = (2 * Math.PI * hz * i) / SR;
    re += buf[i] * Math.cos(a);
    im += buf[i] * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

function rms(buf, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / (to - from));
}

// ---- Reconstruction ----------------------------------------------------

{
  // Something with content everywhere, so an error anywhere shows up.
  const src = new Float32Array(SR);
  tone(src, 220, 0.3);
  tone(src, 1370, 0.2);
  for (let i = 0; i < src.length; i++) src[i] += (Math.random() - 0.5) * 0.02;

  const out = repairChannel(
    src,
    SR * 0.3,
    SR * 0.6,
    { loHz: 900, hiHz: 1100 },
    SR,
    "attenuate",
    { gainDb: 0 },
  );

  let worst = 0;
  for (let i = 0; i < src.length; i++) {
    worst = Math.max(worst, Math.abs(out[i] - src[i]));
  }
  const db = 20 * Math.log10(worst + 1e-12);
  check(
    "an edit of zero decibels returns the samples it was given",
    db < -80,
    `worst deviation ${db.toFixed(1)} dBFS`,
  );
}

{
  const src = new Float32Array(SR);
  tone(src, 440, 0.4);
  const out = repairChannel(src, SR * 0.4, SR * 0.5, { loHz: 3000, hiHz: 4000 }, SR, "heal");

  let touched = 0;
  for (let i = 0; i < src.length; i++) {
    if (i >= Math.floor(SR * 0.4) && i < Math.ceil(SR * 0.5)) continue;
    if (out[i] !== src[i]) touched++;
  }
  check(
    "samples outside the selected time are left alone entirely",
    touched === 0,
    `${touched} samples changed outside the range`,
  );
}

// ---- Removing one tone from among several ------------------------------

{
  // The unwanted tone exists only over the stretch being repaired. That
  // distinction matters: healing fills from the neighbours, so a tone that
  // also runs either side of the selection gets faithfully put back, which
  // is the behaviour you want and not a way to remove anything.
  const src = new Float32Array(SR * 2);
  tone(src, 400, 0.3);

  const from = Math.floor(SR * 0.8);
  const to = Math.floor(SR * 1.2);
  tone(src, 1000, 0.3, from, to);
  const out = repairChannel(src, from, to, { loHz: 900, hiHz: 1100 }, SR, "heal");

  const inner = [from + 4000, to - 4000];
  const before1k = levelAt(src, 1000, ...inner);
  const after1k = levelAt(out, 1000, ...inner);
  const before400 = levelAt(src, 400, ...inner);
  const after400 = levelAt(out, 400, ...inner);

  const drop = 20 * Math.log10(after1k / before1k + 1e-12);
  const keep = 20 * Math.log10(after400 / before400 + 1e-12);

  check(
    "the selected tone is pulled well down inside the selection",
    drop < -25,
    `1 kHz moved ${drop.toFixed(1)} dB`,
  );
  check(
    "a tone outside the band is untouched by the same edit",
    Math.abs(keep) < 0.5,
    `400 Hz moved ${keep.toFixed(2)} dB`,
  );

  // A tone that does run through the selection has to come back out of it
  // at the level it went in, or healing would be gouging holes in
  // sustained material.
  const held = new Float32Array(SR * 2);
  tone(held, 1000, 0.3);
  const kept = repairChannel(held, from, to, { loHz: 900, hiHz: 1100 }, SR, "heal");
  const moved =
    20 * Math.log10(levelAt(kept, 1000, ...inner) / levelAt(held, 1000, ...inner) + 1e-12);
  check(
    "a tone that carries through the selection is filled back in",
    Math.abs(moved) < 1,
    `sustained 1 kHz moved ${moved.toFixed(2)} dB`,
  );
}

// ---- Healing fills from the surrounding sound --------------------------

{
  // A held note with a short burst of noise sitting on top of it. Healing
  // should take out the burst and leave the note running through.
  const src = new Float32Array(SR * 2);
  tone(src, 700, 0.25);
  const bFrom = Math.floor(SR * 0.95);
  const bTo = Math.floor(SR * 1.05);
  for (let i = bFrom; i < bTo; i++) src[i] += (Math.random() - 0.5) * 0.8;

  const out = repairChannel(src, bFrom, bTo, { loHz: 2000, hiHz: 20000 }, SR, "heal");

  // Measured well inside the burst. A frame is 2048 samples long, so the
  // frames straddling each edge of the selection are left alone and carry
  // some of the burst with them — the repair is clean in the middle and
  // tapers over roughly a window at each end.
  const noisyBefore = rms(src, bFrom + 1600, bTo - 1600);
  const noisyAfter = rms(out, bFrom + 1600, bTo - 1600);
  check(
    "a broadband burst loses most of its energy",
    noisyAfter < noisyBefore * 0.75,
    `RMS ${noisyBefore.toFixed(4)} to ${noisyAfter.toFixed(4)}`,
  );

  const heldLevel = levelAt(out, 700, bFrom + 1600, bTo - 1600);
  check(
    "the note underneath keeps its level through the repair",
    heldLevel > 0.2 && heldLevel < 0.31,
    `700 Hz reads ${heldLevel.toFixed(3)} against 0.25 either side`,
  );
}

// ---- Behaviour at the edges -------------------------------------------

{
  const src = new Float32Array(SR);
  tone(src, 500, 0.5);

  const cases = [
    ["a selection starting at sample zero", 0, 2000],
    ["a selection running to the last sample", SR - 2000, SR],
    ["a selection of a single sample", 5000, 5001],
    ["a selection outside the buffer", SR + 100, SR + 500],
    ["a reversed selection", 9000, 8000],
  ];

  for (const [name, a, b] of cases) {
    const out = repairChannel(src, a, b, { loHz: 400, hiHz: 600 }, SR, "heal");
    let finite = true;
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(out[i]) || Math.abs(out[i]) > 4) {
        finite = false;
        break;
      }
    }
    check(name + " stays finite and in range", finite);
  }
}

{
  const src = new Float32Array(SR);
  tone(src, 800, 0.4);
  const quiet = repairChannel(src, 10000, 20000, { loHz: 700, hiHz: 900 }, SR, "attenuate", {
    gainDb: -60,
  });
  const level = levelAt(quiet, 800, 12000, 18000);
  check(
    "attenuating by sixty decibels leaves the band near silent",
    level < 0.004,
    `800 Hz reads ${level.toExponential(2)}`,
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
