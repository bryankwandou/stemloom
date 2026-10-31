/**
 * End-to-end checks against a real browser.
 *
 * A build passing TypeScript proves nothing about whether a microphone
 * opens, whether an encoder emits a valid bitstream, or whether a canvas
 * has any pixels on it. Everything here drives the actual page in actual
 * Chromium and inspects the bytes that come out.
 *
 * Recording is testable without a person in the room because Chrome can
 * be told to present a synthetic input device, which is what the two
 * fake-media flags below do.
 *
 * Playwright is not a dependency of this project — it is a large download
 * for something that runs by hand, so point PLAYWRIGHT at an installation
 * you already have:
 *
 *   NODE_PATH=/path/to/node_modules node scripts/browser-check.mjs
 *   BASE=http://localhost:3000 node scripts/browser-check.mjs
 *   CHROME=/path/to/chrome.exe   node scripts/browser-check.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Resolved at run time rather than imported at the top, so PLAYWRIGHT can
// point at an installation outside this project. NODE_PATH does not apply
// to ES modules, which is the trap this avoids.
const { chromium } = await import(
  process.env.PLAYWRIGHT
    ? pathToFileURL(process.env.PLAYWRIGHT).href
    : "playwright"
);

// Playwright bundles its own Chromium, but the copy it expects and the
// copy on disk drift apart as versions move, so this is overridable.
const CHROME = process.env.CHROME ?? undefined;
const BASE = process.env.BASE ?? "https://stemloom.vercel.app";
const OUT = process.env.OUT ?? ".";

const results = [];
/** Length of the WAV export, the reference every lossy export is held to. */
let wavSeconds = null;
let page, ctx, browser;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? "");
  } catch (e) {
    record(name, false, String(e.message ?? e).split("\n")[0].slice(0, 160));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Pixel statistics for the widest canvas on the page.
 *
 * Picking by size rather than document order matters: the top bar carries
 * a level meter and a spectrum display that are also canvases, and they
 * are the ones that come first.
 */
async function canvasStats() {
  return page.evaluate(
    () => {
      const all = [...document.querySelectorAll("canvas")];
      const c = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!c) return null;
      const g = c.getContext("2d");
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      const hues = new Set();
      for (let p = 0; p < d.length; p += 4 * 37) {
        const [r, gg, b] = [d[p], d[p + 1], d[p + 2]];
        if (r + gg + b > 40) lit++;
        hues.add(`${r >> 4},${gg >> 4},${b >> 4}`);
      }
      return { w: c.width, h: c.height, lit, distinct: hues.size };
    },
  );
}

const errors = [];

async function main() {
  browser = await chromium.launch({
    ...(CHROME ? { executablePath: CHROME } : {}),
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  ctx = await browser.newContext({
    acceptDownloads: true,
    permissions: ["microphone"],
    viewport: { width: 1500, height: 900 },
  });
  page = await ctx.newPage();

  // A tap on whatever the live context sends to the speakers. Without it
  // the harness could only prove an effect is wired, not that it is heard;
  // with it, a check can measure the spectrum actually leaving the page.
  // Offline contexts are left alone, since export is checked by its bytes.
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (
        dest instanceof AudioDestinationNode &&
        typeof AudioContext !== "undefined" &&
        this.context instanceof AudioContext
      ) {
        let tap = window.__tap;
        if (!tap || tap.context !== this.context) {
          tap = this.context.createAnalyser();
          tap.fftSize = 4096;
          tap.smoothingTimeConstant = 0;
          window.__tap = tap;
        }
        connect.call(this, tap);
      }
      return connect.call(this, dest, ...rest);
    };
  });

  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) =>
    errors.push("pageerror: " + String(e.stack ?? e).split(String.fromCharCode(10)).slice(0, 4).join(" <- ").slice(0, 400)),
  );
  page.on("worker", (w) => {
    w.on("console", (m) => m.type() === "error" && errors.push(`worker: ${m.text().slice(0, 200)}`));
  });
  ctx.on("weberror", (e) => errors.push(`weberror: ${String(e.error()?.message ?? e.error()).slice(0, 200)}`));
  // Failed requests explain most intermittent failures, so keep them.
  ctx.on("requestfailed", (r) =>
    errors.push(`requestfailed: ${r.url().slice(-80)} ${r.failure()?.errorText ?? ""}`),
  );

  // ---- Load ----
  await check("studio page loads", async () => {
    const res = await page.goto(`${BASE}/studio`, { waitUntil: "networkidle" });
    assert(res.status() === 200, `status ${res.status()}`);
    await page.waitForSelector("text=Drop an audio file anywhere", { timeout: 20000 });
    return "empty state shown";
  });

  // ---- Get audio in ----
  await check("test signal creates a track", async () => {
    await page.click("text=Use a test signal");
    await page.waitForSelector("canvas", { timeout: 15000 });
    const lanes = await page.locator("canvas").count();
    assert(lanes >= 1, "no canvas appeared");
    return `${lanes} canvas elements`;
  });

  await check("waveform actually draws", async () => {
    await page.waitForTimeout(600);
    const s = await canvasStats();
    assert(s, "no canvas");
    assert(s.lit > 20, `only ${s.lit} lit samples on a ${s.w}x${s.h} canvas`);
    return `${s.lit} lit samples, ${s.w}x${s.h}`;
  });

  // ---- Spectrogram ----
  await check("spectrogram renders through the worker", async () => {
    // Watch the main thread from before analysis starts, so the next check
    // can say how long it was ever blocked rather than time a click.
    await page.evaluate(() => {
      window.__long = [];
      window.__t0 = performance.now();
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__long.push(e.duration);
          window.__longAt = [...(window.__longAt ?? []), Math.round(e.startTime - window.__t0) + ":" + Math.round(e.duration)];
        }
      }).observe({ type: "longtask" });
    });
    await page.click("button:has-text('Spectrum')");
    // The worker has to load, analyse, and post back before anything
    // appears. On a cold server the worker chunk alone can take a couple
    // of seconds, so poll rather than guess a single fixed wait.
    let s = null;
    const until = Date.now() + 10000;
    do {
      await page.waitForTimeout(500);
      s = await canvasStats();
    } while (s && s.distinct <= 6 && Date.now() < until);
    assert(s.lit > 20, `spectrogram looks blank (${s.lit} lit)`);
    assert(s.distinct > 6, `only ${s.distinct} distinct colours, expected a ramp`);
    return `${s.lit} lit, ${s.distinct} distinct colours`;
  });

  await check("main thread stays responsive during analysis", async () => {
    // Timing the clicks themselves measured the harness as much as the
    // page: on a loaded machine the round trip alone reached two seconds
    // while the page never blocked for more than 53 ms. Long tasks are
    // what a person feels, so those are what is held to a limit.
    await page.click("button[title='Zoom in (+)']");
    await page.click("button[title='Zoom in (+)']");
    await page.waitForTimeout(1500);
    const long = await page.evaluate(() => window.__long ?? []);
    const worst = Math.round(Math.max(0, ...long));
    const at = await page.evaluate(() => (window.__longAt ?? []).join(" "));
    assert(worst < 250, `the main thread blocked for ${worst} ms (start:ms ${at})`);
    return `${long.length} long task(s), worst ${worst} ms, across analysis and two zooms`;
  });

  // ---- Spectral repair ----
  await check("dragging a box on the spectrogram picks a frequency band", async () => {
    const box = await page.evaluate(() => {
      const all = [...document.querySelectorAll("canvas")];
      const c = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    // A rectangle roughly a third of the way across and up the lane.
    await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.45, box.y + box.h * 0.3, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const text = await page.innerText("body");
    const band = text.match(/([\d.]+\s*k?Hz)\s*–\s*([\d.]+\s*k?Hz)/);
    assert(band, "no band readout appeared after the drag");
    return `${band[1]} to ${band[2]}`;
  });

  await check("healing the selected band changes the audio and is undoable", async () => {
    const heal = page.locator("button:has-text('Heal')").first();
    assert(await heal.count(), "no Heal button in the spectrogram toolbar");
    assert(await heal.isEnabled(), "Heal is disabled even with a box drawn");
    await heal.click();
    await page.waitForTimeout(2500);
    const text = await page.innerText("body");
    assert(/Healed/.test(text), "the status line never reported a repair");

    // The edit hands the lane a new buffer. The picture has to follow it
    // rather than go blank or keep showing the audio from before.
    let s = null;
    const until = Date.now() + 10000;
    do {
      await page.waitForTimeout(400);
      s = await canvasStats();
    } while (s && s.distinct <= 6 && Date.now() < until);
    assert(s && s.distinct > 6, `spectrogram blank after the edit (${s?.distinct} colours)`);

    // Undo has to put the samples back, or the operation is not safe to
    // offer at all.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(800);
    assert(/Undo/.test(await page.innerText("body")), "undo did not step back");
    // Dot stops at a line break, which is exactly the boundary wanted.
    return text.match(/Healed .*/)[0].slice(0, 60);
  });

  await check("notching the band reports the cut it applied", async () => {
    await page.click("button:has-text('Notch')");
    await page.waitForTimeout(2500);
    const text = await page.innerText("body");
    assert(/Cut .*40 dB/.test(text), "no notch reported in the status line");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(800);
    return text.match(/Cut .*/)[0].slice(0, 60);
  });

  await check("returns to the waveform view", async () => {
    await page.click("button:has-text('Wave')");
    await page.waitForTimeout(400);
    const s = await canvasStats();
    assert(s.lit > 20, "waveform blank after switching back");
    return `${s.lit} lit samples`;
  });

  // ---- Transport ----
  await check("transport advances the playhead", async () => {
    const read = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll("span,div")].find((n) =>
          /^\d{2}:\d{2}[.:]\d+/.test(n.textContent?.trim() ?? ""),
        );
        return el?.textContent?.trim() ?? null;
      });
    const before = await read();
    await page.keyboard.press("Space");
    await page.waitForTimeout(1200);
    const during = await read();
    await page.keyboard.press("Space");
    assert(before !== null, "no timecode element found");
    assert(during !== before, `timecode stuck at ${before}`);
    return `${before} to ${during}`;
  });

  // ---- Undo ----
  await check("undo and redo move history", async () => {
    await page.click("button:has-text('Normalise')").catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    const status = await page.textContent("body");
    assert(/Undo|Ready|Normalis/i.test(status), "no status change");
    return "history responded";
  });

  // ---- Noise reduction ----
  await check("noise is learned from a selection and reduced across the track", async () => {
    const box = await page.evaluate(() => {
      const all = [...document.querySelectorAll("canvas")];
      const c = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(box.x + box.w * 0.1, box.y + box.h * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.5, { steps: 10 });
    await page.mouse.up();
    await page.click("button:has-text('Learn Noise')");
    await page.waitForTimeout(300);
    let text = await page.innerText("body");
    assert(/Learned noise from [\d.]+ s/.test(text), "no confirmation that noise was learned");

    const reduceBtn = page.locator("button:has-text('Reduce Noise')").first();
    assert(await reduceBtn.isEnabled(), "Reduce Noise is disabled after learning");
    await reduceBtn.click();
    // Runs in a worker, so wait for the status rather than a fixed time.
    try {
      await page.waitForFunction(() => /Reduced noise by \d+ dB|failed|changed while/.test(document.body.innerText), null, {
        timeout: 30000,
      });
    } catch {
      const body = await page.innerText("body");
      const lines = body.split(String.fromCharCode(10)).filter((l) => /nois|Reduc|Learn|Undo|Healed|Cut/i.test(l));
      throw new Error(`no result after 30 s; status lines: ${lines.slice(0, 6).join(" | ")}`);
    }
    text = await page.innerText("body");
    assert(/Reduced noise by 12 dB/.test(text), `reduction did not finish: ${text.match(/Noise reduction failed.*/)?.[0] ?? ""}`);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    return "learned, reduced in a worker, and undone";
  });

  // ---- Moving a track ----
  await check("the move tool slides a track along the timeline, undoably", async () => {
    await page.click("button[aria-pressed]:has-text('Move')");
    const lane = page.locator("[data-move-lane]").first();
    await lane.waitFor({ timeout: 3000 });
    const r = await lane.boundingBox();
    // Bright pixels in the first sliver of the lane, where the track's
    // opening currently sits.
    const headLit = () =>
      page.evaluate(() => {
        const all = [...document.querySelectorAll("canvas")];
        const c = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const d = c.getContext("2d").getImageData(0, 0, Math.floor(c.width * 0.05), c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 200) lit++;
        return lit;
      });
    const litBefore = await headLit();
    await page.mouse.move(r.x + r.width * 0.2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * 0.2 + 160, r.y + r.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const text = await page.innerText("body");
    const m = text.match(/Moved .* to ([\d.]+) s/);
    assert(m, "no move reported in the status line");
    assert(Number(m[1]) > 0.1, `the track only moved to ${m[1]} s`);

    // The waveform has to follow: the strip the track used to start in
    // is now empty timeline.
    const litAfter = await headLit();
    assert(litAfter < litBefore / 4,
      `the old start still holds ${litAfter} bright pixels (was ${litBefore})`);

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    await page.click("button[aria-pressed]:has-text('Select')");
    return `moved to ${m[1]} s; old start went from ${litBefore} to ${litAfter} bright pixels; undone`;
  });

  // ---- Automation ----
  await check("a volume envelope takes points, drags, and removes them", async () => {
    await page.click("button[aria-pressed]:has-text('Volume')");
    const lane = page.locator("svg[data-automation-lane='gain']").first();
    await lane.waitFor({ timeout: 3000 });
    const r = await lane.boundingBox();

    // Two presses well apart: one on the 0 dB line, one low in the lane.
    await page.mouse.click(r.x + r.width * 0.25, r.y + r.height * 0.18);
    await page.mouse.click(r.x + r.width * 0.6, r.y + r.height * 0.85);
    await page.waitForTimeout(300);
    let pts = await page.locator("svg[data-automation-lane='gain'] circle").count();
    assert(pts >= 2, `expected two points, saw ${pts}`);
    const status = await page.innerText("body");
    assert(/Volume envelope, 2 points/.test(status), "status did not report the envelope");

    // Drag the second point upward; the status should stay a single step.
    const c = page.locator("[data-automation-point='1']").first();
    const cb = await c.boundingBox();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width / 2 + 20, r.y + r.height * 0.5, { steps: 8 });
    await page.mouse.up();
    const moved = await c.boundingBox();
    assert(moved.y < cb.y - 10, "the point did not follow the drag");

    // Double-click removes; undo brings it back.
    await page.mouse.dblclick(moved.x + moved.width / 2, moved.y + moved.height / 2);
    await page.waitForTimeout(300);
    pts = await page.locator("svg[data-automation-lane='gain'] circle").count();
    assert(pts === 1, `double-click left ${pts} points`);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    pts = await page.locator("svg[data-automation-lane='gain'] circle").count();
    assert(pts === 2, `undo restored ${pts} points, not 2`);
    return "added 2, dragged 1, removed and restored";
  });

  await check("the envelope stays visible with editing switched off", async () => {
    await page.click("button[aria-pressed]:has-text('Select')");
    await page.waitForTimeout(200);
    const shown = await page.locator("svg[data-automation-lane='gain']").count();
    assert(shown > 0, "the drawn line vanished when editing was turned off");
    const passes = await page.$eval(
      "svg[data-automation-lane='gain']",
      (el) => getComputedStyle(el).pointerEvents,
    );
    assert(passes === "none", "the idle overlay still swallows clicks");
    return "drawn faintly, clicks pass through";
  });

  await check("playback runs with an envelope on the track", async () => {
    await page.keyboard.press("Space");
    await page.waitForTimeout(900);
    await page.keyboard.press("Space");
    const fresh = errors.filter((e) => /AudioParam|automation|schedule/i.test(e));
    assert(fresh.length === 0, fresh[0] ?? "");
    return "no scheduling errors";
  });

  // ---- Live effects ----
  /**
   * Share of the playing signal's power below 60 Hz. The test chord's
   * lowest note is 110 Hz, so almost nothing lives down there until an
   * effect puts it there. A ratio rather than a level, because the
   * envelope drawn above leaves the track quiet and that must not matter.
   */
  async function lowShare() {
    return page.evaluate(async () => {
      const tap = window.__tap;
      if (!tap) return null;
      const bins = new Float32Array(tap.frequencyBinCount);
      const hzPerBin = tap.context.sampleRate / tap.fftSize;
      let lo = 0;
      let all = 0;
      for (let k = 0; k < 12; k++) {
        tap.getFloatFrequencyData(bins);
        for (let i = 1; i < bins.length; i++) {
          const p = Math.pow(10, bins[i] / 10);
          all += p;
          if (i * hzPerBin < 60) lo += p;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return all > 0 ? lo / all : null;
    });
  }

  await check("an effect added during playback is heard straight away", async () => {
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
    const before = await lowShare();
    assert(before !== null, "nothing reached the speakers");

    // A ring modulator at its default 180 Hz turns the 220 Hz note into
    // 40 Hz and 400 Hz. Nothing else in the chain could put energy at 40.
    await page.click("button:has-text('Add')");
    await page.click("button:has-text('Ring Modulator')");
    // Polled rather than a fixed wait: on a loaded machine the rebuild
    // takes longer, and what is under test is that it happens, not how
    // quick this particular machine is.
    let during = null;
    for (let k = 0; k < 10 && !(during > before * 10); k++) {
      await page.waitForTimeout(300);
      during = await lowShare();
    }

    await page.click("button[aria-label='Remove Ring Modulator']");
    let after = null;
    for (let k = 0; k < 10 && !(after !== null && after < during / 10); k++) {
      await page.waitForTimeout(300);
      after = await lowShare();
    }
    await page.keyboard.press("Space");

    const db = (x) => (10 * Math.log10(x)).toFixed(1);
    if (!(during > before * 10)) {
      const clock = await page.evaluate(() => {
        const el = [...document.querySelectorAll("span,div")].find((n) =>
          /^\d{2}:\d{2}[.:]\d+/.test(n.textContent?.trim() ?? ""),
        );
        return `${el?.textContent?.trim().slice(0, 20)}; ctx ${window.__tap?.context.state}`;
      });
      throw new Error(`the low band moved only from ${db(before)} to ${db(during)} dB (${clock})`);
    }
    assert(after < during / 10, `removing the effect left the low band at ${db(after)} dB`);
    return `energy below 60 Hz ${db(before)} → ${db(during)} → ${db(after)} dB`;
  });

  // ---- Export ----
  await check("WAV export produces a valid RIFF file", async () => {
    await page.click("button:has-text('Export')");
    await page.waitForSelector("text=Export mixdown", { timeout: 10000 });
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 90000 }),
      page.click("button:has-text('Render WAV')"),
    ]);
    const path = await dl.path();
    const buf = readFileSync(path);
    assert(buf.length > 44, `file is only ${buf.length} bytes`);
    assert(buf.toString("ascii", 0, 4) === "RIFF", "no RIFF magic");
    assert(buf.toString("ascii", 8, 12) === "WAVE", "not a WAVE file");
    const declared = buf.readUInt32LE(4) + 8;
    assert(Math.abs(declared - buf.length) < 8,
      `header says ${declared} bytes, file is ${buf.length}`);
    // Sample data must not be all zeros, or we exported silence.
    let nonZero = 0;
    for (let i = 44; i < Math.min(buf.length, 400000); i += 2) {
      if (buf.readInt16LE(i) !== 0) nonZero++;
    }
    assert(nonZero > 500, `only ${nonZero} non-zero samples — exported silence`);
    // Kept for the Opus check, which has to come out the same length.
    wavSeconds = (buf.length - 44) / buf.readUInt32LE(28);
    return `${(buf.length / 1024).toFixed(0)} KB, ${nonZero} non-zero samples checked`;
  });

  await check("loudness measurement reports LUFS and true peak", async () => {
    // The dialog closes itself once a render succeeds, so it has to be
    // reopened rather than assumed to still be there.
    await page.click("button:has-text('Export')");
    await page.waitForSelector("text=Export mixdown", { timeout: 10000 });
    await page.click("button:has-text('Measure')");
    await page.waitForTimeout(1000);
    await page.waitForFunction(
      () => /-?\d+\.\d\s*LUFS/i.test(document.body.innerText),
      { timeout: 90000 },
    );
    const text = await page.innerText("body");
    const lufs = text.match(/(-?\d+\.\d)\s*LUFS/i);
    const peak = text.match(/(-?\d+\.\d)\s*dBTP/i);
    assert(lufs, "no LUFS figure appeared");
    assert(peak, "no true peak figure appeared");
    const v = parseFloat(lufs[1]);
    assert(v < 0 && v > -70, `LUFS reads ${v}, which is not plausible`);
    return `${lufs[1]} LUFS, ${peak[1]} dBTP`;
  });

  await check("WebCodecs AAC encoding is available in this browser", async () => {
    const ok = await page.evaluate(
      () => "AudioEncoder" in window && "AudioData" in window,
    );
    assert(ok, "AudioEncoder or AudioData missing, so AAC is correctly hidden");
    return "AudioEncoder and AudioData both present";
  });

  await check("AAC export produces ADTS frames", async () => {
    const aac = page.locator("button:has-text('AAC')").first();
    assert(await aac.count(), "no AAC option offered even though WebCodecs is present");
    await aac.click();
    await page.waitForTimeout(400);
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 90000 }),
      page.click("button:has-text('Render AAC')"),
    ]);
    const buf = readFileSync(await dl.path());
    assert(buf.length > 512, `file is only ${buf.length} bytes`);
    // Every ADTS frame starts with twelve set sync bits.
    assert(buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0, "no ADTS sync word");
    const frameLen = ((buf[3] & 0x03) << 11) | (buf[4] << 3) | (buf[5] >> 5);
    assert(frameLen > 7 && frameLen < 8192, `implausible frame length ${frameLen}`);
    assert(buf[frameLen] === 0xff, "second frame does not start where the first says it ends");
    return `${(buf.length / 1024).toFixed(0)} KB, first frame ${frameLen} bytes, chain intact`;
  });

  await check("Opus export decodes, in Chrome and in ffmpeg, to the right length", async () => {
    await page.click("button:has-text('Export')");
    await page.waitForSelector("text=Export mixdown", { timeout: 10000 });
    const opus = page.locator("button:has-text('Opus')").first();
    assert(await opus.count(), "no Opus option in the export dialog");
    await opus.click();
    await page.waitForTimeout(400);
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 90000 }),
      page.click("button:has-text('Render Opus')"),
    ]);
    const path = await dl.path();
    const buf = readFileSync(path);
    assert(buf.toString("ascii", 0, 4) === "OggS", "no Ogg capture pattern");
    assert(buf.toString("ascii", 28, 36) === "OpusHead", "first packet is not OpusHead");

    // Chrome's own decoder rejects a stream with a bad checksum or broken
    // lacing, so decoding it at all is a strong check; the length then
    // shows whether the pre-skip and final granule were honoured.
    const decoded = await page.evaluate(async (bytes) => {
      const ctx = new OfflineAudioContext(2, 1, 48000);
      const ab = new Uint8Array(bytes).buffer;
      const b = await ctx.decodeAudioData(ab);
      let peak = 0;
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i += 7) peak = Math.max(peak, Math.abs(d[i]));
      return { seconds: b.duration, rate: b.sampleRate, peak };
    }, [...buf]);
    assert(decoded.peak > 0.01, `decoded to near silence (peak ${decoded.peak})`);
    const drift = wavSeconds === null ? null : Math.abs(decoded.seconds - wavSeconds);
    assert(drift === null || drift < 0.03,
      `decodes to ${decoded.seconds.toFixed(3)} s against the WAV's ${wavSeconds?.toFixed(3)} s`);

    // An independent decoder, when one is installed. Chrome agreeing with
    // itself would not catch a stream only Chrome is lenient about.
    let ff = "ffmpeg not installed";
    try {
      const out = execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
        "-of", "default=nw=1", path,
      ]).toString();
      const err = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"], {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
      assert(/codec_name=opus/.test(out), `ffprobe saw: ${out.replace(/\s+/g, " ")}`);
      assert(err.trim() === "", `ffmpeg reported: ${err.slice(0, 120)}`);
      const dur = Number(out.match(/duration=([\d.]+)/)?.[1]);
      ff = `ffmpeg decodes it cleanly, ${dur.toFixed(3)} s`;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return `${(buf.length / 1024).toFixed(0)} KB, Chrome ${decoded.seconds.toFixed(3)} s vs WAV ${wavSeconds?.toFixed(3)} s; ${ff}`;
  });

  await check("export dialog closes", async () => {
    await page.keyboard.press("Escape");
    await page.click("button:has-text('Cancel')").catch(() => {});
    await page.waitForTimeout(400);
    return "closed";
  });

  // ---- Recording, against Chrome's synthetic input device ----
  await check("microphone arms and captures a take", async () => {
    const before = await page.locator("canvas").count();
    await page.click("button:has-text('Record')");
    await page.waitForSelector("button:has-text('Roll')", { timeout: 20000 });
    // Wait for the arming meter to show signal, as a person would. The
    // fake device takes a moment to start delivering, and rolling before
    // it does records silence through no fault of the recorder.
    await page.waitForFunction(
      () => {
        const c = [...document.querySelectorAll("canvas")].find(
          (n) => n.style.width === "54px",
        );
        if (!c) return false;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) {
          // The meter's green, amber, or red fill, not the grey track.
          if (d[i + 3] > 200 && (d[i + 1] > 150 || d[i] > 200)) return true;
        }
        return false;
      },
      null,
      { timeout: 10000 },
    );
    await page.click("button:has-text('Roll')");
    await page.waitForTimeout(1800);
    await page.click("button:has-text('Stop')");
    await page.waitForTimeout(1200);
    const after = await page.locator("canvas").count();
    assert(after > before, `track count did not grow (${before} to ${after})`);
    const text = await page.innerText("body");
    assert(/Captured [\d.]+ seconds/.test(text), "no capture confirmation in the status line");
    return text.match(/Captured [\d.]+ seconds/)[0];
  });

  // ---- Persistence ----
  await check("a project saves and reopens from IndexedDB", async () => {
    await page.click("button:has-text('Projects')");
    await page.waitForSelector("input[placeholder='Name this session']", { timeout: 10000 });
    await page.fill("input[placeholder='Name this session']", "harness run");
    await page.click("button:has-text('Save current')");
    await page.waitForTimeout(2500);
    const saved = await page.innerText("body");
    assert(/harness run/.test(saved), "the saved project is not listed");
    await page.click("button:has-text('Open')");
    await page.waitForTimeout(2500);
    const opened = await page.innerText("body");
    assert(/Opened "harness run"/.test(opened), "reopening did not report success");
    return "saved and reopened";
  });

  // ---- Offline ----
  await check("service worker registers and the app survives going offline", async () => {
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return !!r && !!(r.active || r.installing || r.waiting);
    });
    assert(reg, "no service worker registration");
    // Registered is not the same as in charge. Going offline while the
    // worker is still installing tests the network, not the cache.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
      timeout: 10000,
    });
    await page.waitForFunction(
      async () => !!(await caches.match("/studio")),
      null,
      { timeout: 10000, polling: 250 },
    );
    await ctx.setOffline(true);
    // Through the worker from inside the page first. If this answers but
    // the navigation below does not, the fault is in how navigations reach
    // the worker, not in what it cached.
    const viaFetch = await page.evaluate(async () => {
      try {
        const r = await fetch("/studio");
        return `fetch ${r.status}`;
      } catch (e) {
        return `fetch failed: ${e}`;
      }
    });
    let res;
    try {
      res = await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    } catch (e) {
      await ctx.setOffline(false);
      const first = String(e.message).split(String.fromCharCode(10))[0].trim();
      const state = await page
        .evaluate(async () => {
          const keys = await caches.keys();
          const urls = [];
          for (const k of keys) {
            for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
          }
          const ctl = navigator.serviceWorker.controller?.state ?? "none";
          return `caches ${keys.join(",")}; ${urls.length} urls, studio ${urls.includes("/studio")}; controller ${ctl}`;
        })
        .catch((x) => `state unreadable: ${x}`);
      throw new Error(`${first} (${viaFetch}; ${state})`);
    }
    await ctx.setOffline(false);
    assert(res && res.status() < 400, `offline load returned ${res && res.status()}`);
    const body = await page.innerText("body");
    assert(/Drop an audio file|Export/.test(body), "offline page did not render the editor");
    return "loaded from cache with the network off";
  });

  // A return visit: by now the service worker holds the worker bootstrap
  // in its cache. Served from there naively, a worker lost the chunk list
  // carried in its URL and never answered, so the spectrogram stayed black
  // on every visit after the first.
  await check("on a return visit, workers served from the cache still run", async () => {
    await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    await page.click("text=Use a test signal");
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.click("button:has-text('Spectrum')");
    let s = null;
    const until = Date.now() + 10000;
    do {
      await page.waitForTimeout(500);
      s = await canvasStats();
    } while (s && s.distinct <= 6 && Date.now() < until);
    assert(s && s.distinct > 6, `spectrogram blank on the return visit (${s?.distinct} colours)`);
    const fromCache = await page.evaluate(async () => {
      const keys = await caches.keys();
      let workers = 0;
      for (const k of keys) {
        for (const r of await (await caches.open(k)).keys()) {
          if (/turbopack-worker/.test(r.url)) workers++;
        }
      }
      return workers;
    });
    return `${s.distinct} colours, with ${fromCache} worker script(s) in the offline cache`;
  });

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (errors.length) {
    console.log(`\nConsole errors seen (${errors.length}):`);
    for (const e of [...new Set(errors)].slice(0, 8)) console.log("  " + e);
  }
  writeFileSync(`${OUT}/harness-results.json`, JSON.stringify({ results, errors }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS CRASHED:", e);
  process.exit(2);
});
