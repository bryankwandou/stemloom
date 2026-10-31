/**
 * Checks for noise reduction.
 *
 * Synthesised material only, so the right answer is known exactly: a
 * 440 Hz tone over white noise, with the first half second noise alone to
 * learn from. Measured, not listened to — the noise-only stretch has to
 * drop by close to the reduction asked for, and the tone has to come
 * through at the level it went in.
 *
 *   npx tsc src/lib/audio/denoise.ts src/lib/audio/spectral.ts src/lib/audio/spectrogram.ts --target es2020 --module es2020 --skipLibCheck --outDir .tmp-check
 *   node scripts/fix-esm.mjs .tmp-check
 *   node scripts/denoise-check.mjs
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { learnNoise, reduceNoise } = await import(
  pathToFileURL(resolve(".tmp-check/denoise.js")).href
);

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}

const SR = 48000;
const len = SR * 3;
const noiseOnly = SR / 2;

// Deterministic noise, so a failure reproduces.
let seed = 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const noise = new Float32Array(len);
for (let i = 0; i < len; i++) noise[i] = (rand() * 2 - 1) * 0.03;
const tone = new Float32Array(len);
for (let i = noiseOnly; i < len; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
const mix = new Float32Array(len);
for (let i = 0; i < len; i++) mix[i] = noise[i] + tone[i];

const rms = (a, s, e) => {
  let t = 0;
  for (let i = s; i < e; i++) t += a[i] * a[i];
  return Math.sqrt(t / (e - s));
};
const db = (x) => 20 * Math.log10(x);

const profile = learnNoise([mix], 0, noiseOnly, SR);
check("profile learns from many frames", profile.frames > 40, `${profile.frames} frames`);

// ---- Doing nothing changes nothing ----
const same = reduceNoise(mix, profile.mags[0], { reductionDb: 0 });
let worst = 0;
for (let i = 0; i < len; i++) worst = Math.max(worst, Math.abs(same[i] - mix[i]));
check("0 dB of reduction returns the input", worst < 1e-5, `${db(worst).toFixed(0)} dBFS worst deviation`);

// ---- A real reduction ----
const out = reduceNoise(mix, profile.mags[0], { reductionDb: 18, sensitivityDb: 6 });
check("output is the same length and finite", out.length === len && out.every(Number.isFinite));

// Skip a window at the edge of each region, where frames straddle it.
const pad = 4096;
const before = rms(mix, pad, noiseOnly - pad);
const after = rms(out, pad, noiseOnly - pad);
const drop = db(before) - db(after);
check("noise alone drops by close to the 18 dB asked for", drop > 16 && drop < 19, `${drop.toFixed(1)} dB`);

// The tone region: compare against the clean tone. What is left over after
// subtracting it is residual noise plus any damage to the tone.
const s0 = noiseOnly + pad;
const s1 = len - pad;
const toneIn = rms(tone, s0, s1);
let dot = 0;
let tt = 0;
for (let i = s0; i < s1; i++) {
  dot += out[i] * tone[i];
  tt += tone[i] * tone[i];
}
// Projection of the output onto the tone: how much of the tone survived.
const kept = dot / tt;
check("the tone comes through within half a decibel", Math.abs(db(kept)) < 0.5, `${db(kept).toFixed(2)} dB`);

const resid = new Float32Array(len);
for (let i = 0; i < len; i++) resid[i] = out[i] - kept * tone[i];
const noiseUnderTone = db(rms(noise, s0, s1)) - db(rms(resid, s0, s1));
check(
  "noise under the tone is reduced too, away from the tone's own bins",
  noiseUnderTone > 8,
  `${noiseUnderTone.toFixed(1)} dB`,
);

// ---- Edges ----
let threw = false;
try {
  learnNoise([mix], 0, 1000, SR);
} catch {
  threw = true;
}
check("refuses to learn from a selection too short to mean anything", threw);

const tiny = reduceNoise(new Float32Array(10), profile.mags[0]);
check("a track shorter than one window survives", tiny.length === 10 && tiny.every(Number.isFinite));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
