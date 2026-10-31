/**
 * Checks for the automation envelope maths.
 *
 * Node has no AudioContext, so `schedule()` is driven against a fake
 * AudioParam that records every call. What matters is the event list it
 * produces: the value playback starts from, which ramps are skipped as
 * already past, and that ramps carry the transformed value rather than
 * the decibel figure.
 *
 *   npx tsc src/lib/audio/automation.ts --target es2020 --module es2020 --skipLibCheck --outDir .tmp-check
 *   node scripts/automation-check.mjs
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(
  pathToFileURL(resolve(".tmp-check/automation.js")).href
);
const { valueAt, normalise, schedule, emptyAutomation } = mod;

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function fakeParam() {
  const calls = [];
  return {
    calls,
    cancelScheduledValues: (t) => calls.push(["cancel", t]),
    setValueAtTime: (v, t) => calls.push(["set", v, t]),
    linearRampToValueAtTime: (v, t) => calls.push(["ramp", v, t]),
  };
}

const env = [
  { t: 1, v: 0 },
  { t: 3, v: -20 },
  { t: 5, v: 6 },
];

// ---- valueAt ----
check("empty envelope reads the fallback", valueAt([], 2, -4.5) === -4.5);
check("holds flat before the first point", valueAt(env, 0, 99) === 0);
check("holds flat after the last point", valueAt(env, 50, 99) === 6);
check("interpolates linearly between points", near(valueAt(env, 2, 0), -10));
check("lands exactly on a point", valueAt(env, 3, 0) === -20);
check(
  "a vertical step holds the later value after it",
  valueAt([{ t: 0, v: 0 }, { t: 1, v: 0 }, { t: 1, v: 5 }, { t: 2, v: 5 }], 1.5, 0) === 5,
);

// ---- normalise ----
const messy = normalise([
  { t: 3, v: 1 },
  { t: 1, v: 2 },
  { t: 3 + 1e-8, v: 7 },
]);
check(
  "sorts and collapses points at the same instant",
  messy.length === 2 && messy[0].t === 1 && messy[1].v === 7,
  JSON.stringify(messy),
);
check("does not mutate its input", (() => {
  const src = [{ t: 2, v: 0 }, { t: 1, v: 0 }];
  normalise(src);
  return src[0].t === 2;
})());

// ---- schedule ----
const db = (v) => Math.pow(10, v / 20);

{
  const p = fakeParam();
  schedule(p, [], 10, 0, 10, -6, db);
  check(
    "no points: one set to the transformed fallback",
    p.calls.length === 2 && p.calls[1][0] === "set" && near(p.calls[1][1], db(-6)),
    JSON.stringify(p.calls),
  );
}

{
  // Track placed at 10 s on the timeline, playback starting at its head.
  const p = fakeParam();
  schedule(p, env, 10, 0, 10, 0, db);
  const ramps = p.calls.filter((c) => c[0] === "ramp");
  check(
    "from the start: every point becomes a ramp at origin + t",
    ramps.length === 3 &&
      ramps[0][2] === 11 && ramps[1][2] === 13 && ramps[2][2] === 15,
    JSON.stringify(ramps.map((r) => r[2])),
  );
  check(
    "ramps carry linear amplitude, not decibels",
    near(ramps[1][1], db(-20)) && near(ramps[2][1], db(6)),
  );
  check("cancels from now before writing", p.calls[0][0] === "cancel" && p.calls[0][1] === 10);
}

{
  // Resuming two seconds into the track: half way down the first fade.
  const now = 100;
  const p = fakeParam();
  schedule(p, env, now - 2, 2, now, 0, db);
  const set = p.calls.find((c) => c[0] === "set");
  const ramps = p.calls.filter((c) => c[0] === "ramp");
  check(
    "resuming mid-fade starts at the envelope's value there",
    near(set[1], db(-10)) && set[2] === now,
    `${set[1]} vs ${db(-10)}`,
  );
  check(
    "points already in the past are not scheduled",
    ramps.length === 2 && ramps[0][2] === 101 && ramps[1][2] === 103,
    JSON.stringify(ramps.map((r) => r[2])),
  );
}

{
  // A track that starts four seconds from now: local time is negative.
  const p = fakeParam();
  schedule(p, env, 104, -4, 100, 0);
  const set = p.calls.find((c) => c[0] === "set");
  check(
    "a track not yet started holds its first point's value",
    set[1] === 0 && p.calls.filter((c) => c[0] === "ramp").length === 3,
  );
}

{
  // Identity transform for pan.
  const p = fakeParam();
  schedule(p, [{ t: 0, v: -1 }, { t: 2, v: 1 }], 0, 1, 1, 0);
  const set = p.calls.find((c) => c[0] === "set");
  check("pan reads its raw value with no transform", near(set[1], 0));
}

{
  const a = emptyAutomation();
  const b = emptyAutomation();
  a.gain.push({ t: 0, v: 0 });
  check("emptyAutomation hands out a fresh object each time", b.gain.length === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
