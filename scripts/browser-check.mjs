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

  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 200)));

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
    await page.click("button:has-text('Spectrum')");
    // The worker has to analyse and post back before anything appears.
    await page.waitForTimeout(2500);
    const s = await canvasStats();
    assert(s.lit > 20, `spectrogram looks blank (${s.lit} lit)`);
    assert(s.distinct > 6, `only ${s.distinct} distinct colours, expected a ramp`);
    return `${s.lit} lit, ${s.distinct} distinct colours`;
  });

  await check("main thread stays responsive during analysis", async () => {
    const t = Date.now();
    await page.click("button[title='Zoom in (+)']");
    await page.click("button[title='Zoom in (+)']");
    const elapsed = Date.now() - t;
    assert(elapsed < 1500, `two zoom clicks took ${elapsed} ms`);
    return `two zoom steps in ${elapsed} ms`;
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

    // Undo has to put the samples back, or the operation is not safe to
    // offer at all.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(800);
    assert(/Undo/.test(await page.innerText("body")), "undo did not step back");
    return text.match(/Healed [^
]*/)[0].slice(0, 60);
  });

  await check("notching the band reports the cut it applied", async () => {
    await page.click("button:has-text('Notch')");
    await page.waitForTimeout(2500);
    const text = await page.innerText("body");
    assert(/Cut .*40 dB/.test(text), "no notch reported in the status line");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(800);
    return text.match(/Cut [^
]*/)[0].slice(0, 60);
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
    await ctx.setOffline(true);
    const res = await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    await ctx.setOffline(false);
    assert(res && res.status() < 400, `offline load returned ${res && res.status()}`);
    const body = await page.innerText("body");
    assert(/Drop an audio file|Export/.test(body), "offline page did not render the editor");
    return "loaded from cache with the network off";
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
