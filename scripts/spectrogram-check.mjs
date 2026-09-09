/**
 * Numerical checks on the short-time transform.
 *
 * A spectrogram that draws something is not the same as a spectrogram
 * that is correct, and a wrong one is worse than none — it would have you
 * chasing a hum that is not there. These drive synthesised tones through
 * the analysis and check where the energy lands.
 *
 * Compile the module first, since this runs outside the bundler:
 *
 *   npx tsc src/lib/audio/spectrogram.ts --target es2020 --module es2020  *     --types --skipLibCheck --outDir .tmp-check
 *   node scripts/spectrogram-check.mjs .tmp-check/spectrogram.js
 */

// A Windows absolute path is not a URL, and the ESM loader will not take
// one, so everything goes through pathToFileURL.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const modulePath = resolve(process.argv[2] ?? ".tmp-check/spectrogram.js");
const { analyse, bandFrequency } = await import(pathToFileURL(modulePath).href);


const SR = 48000;
const N = SR * 2;
const BANDS = 128;
const COLS = 64;

function tone(hz, amp = 1) {
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return a;
}

// Peak band for a pure tone should land on the band whose frequency is
// nearest the tone.
function peakBandFreq(sig) {
  const f = analyse(sig, 0, N, COLS, BANDS, SR);
  // average each band over columns, then take the max
  let best = 0, bestV = -1;
  for (let b = 0; b < BANDS; b++) {
    let s = 0;
    for (let x = 0; x < COLS; x++) s += f.data[x * BANDS + b];
    if (s > bestV) { bestV = s; best = b; }
  }
  return { hz: bandFrequency(best + 0.5, BANDS, SR), norm: bestV / COLS };
}

let fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
}

for (const hz of [50, 100, 440, 1000, 5000, 12000]) {
  const { hz: got } = peakBandFreq(tone(hz));
  const cents = 1200 * Math.log2(got / hz);
  check(`tone ${hz} Hz resolves`, Math.abs(cents) < 120,
    `peak at ${got.toFixed(1)} Hz (${cents.toFixed(0)} cents off)`);
}

// Level: a full-scale sine should read near the top of the ramp; -60 dBFS
// should read well below it; digital silence should read zero.
const full = peakBandFreq(tone(1000, 1.0));
const quiet = peakBandFreq(tone(1000, 0.001));
const silent = peakBandFreq(new Float32Array(N));
check("full-scale sine is near the ceiling", full.norm > 0.85, `norm=${full.norm.toFixed(3)}`);
check("-60 dBFS sine sits mid-ramp", quiet.norm > 0.2 && quiet.norm < 0.7, `norm=${quiet.norm.toFixed(3)}`);
check("silence is floored", silent.norm === 0, `norm=${silent.norm}`);
check("full is louder than quiet", full.norm > quiet.norm + 0.2, "");

// Two tones an octave apart must produce two distinct peaks, not one blob.
const two = new Float32Array(N);
const a = tone(440, 0.5), b = tone(880, 0.5);
for (let i = 0; i < N; i++) two[i] = a[i] + b[i];
const f = analyse(two, 0, N, COLS, BANDS, SR);
const prof = [];
for (let bd = 0; bd < BANDS; bd++) {
  let s = 0;
  for (let x = 0; x < COLS; x++) s += f.data[x * BANDS + bd];
  prof.push(s / COLS);
}
// Count contiguous runs above the threshold rather than strict local
// maxima. Where a display band is narrower than an FFT bin, neighbouring
// bands read the same bin and a peak arrives as a short plateau.
let peaks = 0;
let inRun = false;
for (let i = 0; i < BANDS; i++) {
  const hot = prof[i] > 0.75;
  if (hot && !inRun) peaks++;
  inRun = hot;
}
check("two tones give two separate peaks", peaks === 2, `found ${peaks}`);

// And the trough between them has to actually be a trough, or they are
// one blob with a dent in it.
const at = (hz) => {
  let bi = 0;
  for (let i = 0; i < BANDS; i++) {
    if (Math.abs(bandFrequency(i + 0.5, BANDS, SR) - hz) <
        Math.abs(bandFrequency(bi + 0.5, BANDS, SR) - hz)) bi = i;
  }
  return prof[bi];
};
check("the gap between them is deep", at(620) < 0.2,
  `mid-gap reads ${at(620).toFixed(3)} against peaks near 1.0`);

// No NaN anywhere, including when the window runs off the end of the buffer.
const edge = analyse(tone(440), N - 100, N + 5000, 32, 64, SR);
check("out-of-range reads stay finite", edge.data.every(Number.isFinite), "");

// Parseval-ish sanity: a louder input never produces a lower reading.
let monotone = true;
let prev = -1;
for (const amp of [0.001, 0.01, 0.1, 0.5, 1.0]) {
  const v = peakBandFreq(tone(1000, amp)).norm;
  if (v < prev) monotone = false;
  prev = v;
}
check("level reading is monotonic in amplitude", monotone, "");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
