"use client";

/**
 * The waveform canvas.
 *
 * Drawn on a 2D canvas rather than in SVG or DOM because a five-minute
 * stereo file at typical zoom is several thousand vertical strokes, and
 * that many DOM nodes would make scrolling unusable.
 *
 * Rendered at device pixel ratio so the waveform stays hairline-sharp on
 * a retina display instead of turning into a soft grey smear.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { columnsFor, type PeakSet } from "@/lib/audio/peaks";
import type {
  SpectrogramReply,
  SpectrogramRequest,
} from "@/lib/audio/spectrogram.worker";
import { bandFrequency, bandPosition } from "@/lib/audio/spectrogram";
import type { BandSelection, LaneView } from "@/lib/store";

/**
 * Half of the worker's transform size. The analysis window is centred on
 * each column, so the slice sent for analysis has to carry this much extra
 * on both sides or the first and last columns would be reading zeros.
 */
const FFT_PAD = 2048;

type Props = {
  peaks: PeakSet;
  /** Needed only by the spectrogram, which reads samples rather than peaks. */
  buffer: AudioBuffer;
  view: LaneView;
  color: string;
  height: number;
  /** Leftmost visible time, in seconds. */
  scrollSec: number;
  /** Samples per pixel — the zoom level. */
  spp: number;
  playhead: number;
  offset: number;
  selection: { start: number; end: number } | null;
  /** Only meaningful in the spectrogram view. */
  band: BandSelection;
  onScrub: (sec: number) => void;
  onSelect: (range: { start: number; end: number } | null) => void;
  onBand: (band: BandSelection) => void;
};

export function Waveform({
  peaks,
  buffer,
  view,
  color,
  height,
  scrollSec,
  spp,
  playhead,
  offset,
  selection,
  band,
  onScrub,
  onSelect,
  onBand,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);
  /** Frequency the drag began at, so a rectangle can be worked out. */
  const dragHz = useRef<number | null>(null);

  /**
   * The last spectrogram the worker sent back, with the window it covers.
   *
   * Keeping the geometry alongside the pixels is what lets a stale tile
   * still be useful: while a new one is being analysed the old one is
   * drawn shifted and scaled into its correct place, so scrolling and
   * zooming stay continuous instead of blinking to empty. It behaves the
   * way map tiles do.
   */
  const tileRef = useRef<{
    buf: AudioBuffer;
    startSample: number;
    endSample: number;
    canvas: HTMLCanvasElement;
  } | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef({ id: 0, pending: "" });

  // A landed tile has to repaint the lane, but it lives in a ref rather
  // than state — the pixels themselves never need to drive React.
  const [tileVersion, tileLanded] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (view !== "spectrogram" || workerRef.current) return;

    const worker = new Worker(
      // Relative and with the extension: the bundler resolves worker URLs
      // statically, and a path alias is not something it can follow here.
      new URL("../../lib/audio/spectrogram.worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e: MessageEvent<SpectrogramReply>) => {
      const reply = e.data;
      // Anything but the newest request is a window the user has already
      // scrolled away from.
      if (String(reply.id) !== jobRef.current.pending.split("|")[0]) return;

      const off = document.createElement("canvas");
      off.width = reply.width;
      off.height = reply.height;
      const og = off.getContext("2d");
      if (!og) return;
      const img = og.createImageData(reply.width, reply.height);
      img.data.set(new Uint8ClampedArray(reply.pixels));
      og.putImageData(img, 0, 0);

      const [, start, end] = jobRef.current.pending.split("|");
      tileRef.current = {
        buf: buffer,
        startSample: Number(start),
        endSample: Number(end),
        canvas: off,
      };
      tileLanded();
    };

    workerRef.current = worker;
  }, [view, buffer]);

  // Tear the worker down when the lane goes, not when the view flips —
  // flipping back and forth would otherwise pay for a new module each time.
  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  const secPerPx = spp / peaks.sampleRate;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = height;
    if (w === 0) return;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const chans = Math.min(2, peaks.channels);
    const laneH = h / chans;

    // Which samples are on screen for this track, accounting for its
    // position on the timeline.
    const startSec = scrollSec - offset;
    const startSample = Math.floor(startSec * peaks.sampleRate);
    const endSample = startSample + Math.floor(w * spp);

    const drawWash = () => {
      if (!selection) return;
      const x0 = (selection.start / peaks.sampleRate - startSec) / secPerPx;
      const x1 = (selection.end / peaks.sampleRate - startSec) / secPerPx;
      g.fillStyle = "rgba(245, 184, 67, 0.13)";
      g.fillRect(x0, 0, x1 - x0, h);
      g.strokeStyle = "rgba(245, 184, 67, 0.55)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(x0) + 0.5, 0);
      g.lineTo(Math.round(x0) + 0.5, h);
      g.moveTo(Math.round(x1) + 0.5, 0);
      g.lineTo(Math.round(x1) + 0.5, h);
      g.stroke();
    };

    const drawPlayhead = () => {
      const px = (playhead - scrollSec) / secPerPx;
      if (px < 0 || px > w) return;
      g.strokeStyle = "#fff";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(px) + 0.5, 0);
      g.lineTo(Math.round(px) + 0.5, h);
      g.stroke();
    };

    if (view === "spectrogram") {
      const bands = Math.max(1, Math.floor(laneH));
      const want = `${startSample}|${endSample}`;
      const tile = tileRef.current;
      const stale =
        !tile ||
        tile.buf !== buffer ||
        tile.startSample !== startSample ||
        tile.endSample !== endSample;

      const worker = workerRef.current;
      if (stale && worker && jobRef.current.pending.split("|").slice(1).join("|") !== want) {
        const id = ++jobRef.current.id;
        jobRef.current.pending = `${id}|${want}`;

        // Copy out only the window, with the analysis window's overhang on
        // each side. Reads past either end of the track stay zero, which
        // is what makes a partially decoded or offset track line up with
        // the waveform instead of sliding left.
        const total = endSample - startSample + FFT_PAD * 2;
        const slices: ArrayBuffer[] = [];
        for (let c = 0; c < chans; c++) {
          const src = buffer.getChannelData(c);
          const slice = new Float32Array(total);
          const from = startSample - FFT_PAD;
          const lo = Math.max(0, -from);
          const hi = Math.min(total, src.length - from);
          for (let i = lo; i < hi; i++) slice[i] = src[from + i];
          slices.push(slice.buffer);
        }

        const req: SpectrogramRequest = {
          id,
          channels: slices,
          sliceOffset: FFT_PAD,
          // Analysed at CSS resolution rather than device pixels. Matching
          // a retina display would double the transform count for detail
          // no one can resolve in a lane this short, and a spectrogram is
          // a soft image to begin with.
          columns: Math.max(64, w),
          bands,
          sampleRate: peaks.sampleRate,
          windowSamples: endSample - startSample,
        };
        worker.postMessage(req, slices);
      }

      // Ground the lane first, so a window with no tile yet reads as
      // "nothing analysed here" rather than as silence.
      g.fillStyle = "#08090a";
      g.fillRect(0, 0, w, h);

      if (tile && tile.buf === buffer) {
        // Place the tile by the window it was computed for, not by the
        // window on screen now. If the user has scrolled since, it lands
        // off to one side, which is correct and readable.
        const dx = (tile.startSample - startSample) / spp;
        const dw = (tile.endSample - tile.startSample) / spp;
        g.imageSmoothingEnabled = true;
        g.drawImage(tile.canvas, dx, 0, dw, laneH * chans);
      }

      for (let c = 1; c < chans; c++) {
        g.strokeStyle = "rgba(255,255,255,0.14)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, Math.round(c * laneH) + 0.5);
        g.lineTo(w, Math.round(c * laneH) + 0.5);
        g.stroke();
      }

      // Over the image rather than under it, since there is no empty
      // background left for a wash to sit behind.
      drawWash();

      if (band) {
        // Shade everything the repair will not touch, rather than outline
        // what it will. The eye reads the bright unshaded rectangle as the
        // subject, which is the right way round: what matters is what is
        // about to be altered.
        const x0 = selection
          ? (selection.start / peaks.sampleRate - startSec) / secPerPx
          : 0;
        const x1 = selection
          ? (selection.end / peaks.sampleRate - startSec) / secPerPx
          : w;
        const lo = bandPosition(band.loHz, peaks.sampleRate);
        const hi = bandPosition(band.hiHz, peaks.sampleRate);

        g.save();
        g.beginPath();
        g.rect(0, 0, w, h);
        for (let c = 0; c < chans; c++) {
          const top = c * laneH;
          const yTop = top + laneH * (1 - hi);
          const yBot = top + laneH * (1 - lo);
          g.rect(x0, yTop, x1 - x0, yBot - yTop);
        }
        g.fillStyle = "rgba(6, 7, 8, 0.62)";
        g.fill("evenodd");
        g.restore();

        g.strokeStyle = "rgba(245, 184, 67, 0.8)";
        g.lineWidth = 1;
        for (let c = 0; c < chans; c++) {
          const top = c * laneH;
          const yTop = Math.round(top + laneH * (1 - hi)) + 0.5;
          const yBot = Math.round(top + laneH * (1 - lo)) + 0.5;
          g.strokeRect(Math.round(x0) + 0.5, yTop, Math.round(x1 - x0), yBot - yTop);
        }
      }

      drawPlayhead();
      return;
    }

    drawWash();

    for (let c = 0; c < chans; c++) {
      const top = c * laneH;
      const mid = top + laneH / 2;
      const amp = (laneH / 2) * 0.92;

      // Zero line — faint, but it gives the eye a reference for asymmetry.
      g.strokeStyle = "rgba(255,255,255,0.08)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, Math.round(mid) + 0.5);
      g.lineTo(w, Math.round(mid) + 0.5);
      g.stroke();

      const { min, max } = columnsFor(
        peaks,
        c,
        Math.max(0, startSample),
        endSample,
        w,
      );

      // Body: one filled path for the whole channel is far cheaper than
      // thousands of individual strokes.
      g.beginPath();
      const leadIn = Math.max(0, -startSample / spp);
      for (let x = 0; x < w; x++) {
        if (x < leadIn) continue;
        const hi = mid - max[x] * amp;
        const lo = mid - min[x] * amp;
        // Guarantee at least one pixel so silence still shows a line.
        g.rect(x, hi, 1, Math.max(1, lo - hi));
      }
      g.fillStyle = color;
      g.globalAlpha = 0.92;
      g.fill();
      g.globalAlpha = 1;

      // Peak caps in a lighter tint read as a highlight and make the
      // envelope legible even when the body is dense.
      g.beginPath();
      for (let x = 0; x < w; x++) {
        if (x < leadIn) continue;
        g.rect(x, mid - max[x] * amp, 1, 1);
        g.rect(x, mid - min[x] * amp, 1, 1);
      }
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fill();

      if (c < chans - 1) {
        g.strokeStyle = "rgba(255,255,255,0.06)";
        g.beginPath();
        g.moveTo(0, Math.round(top + laneH) + 0.5);
        g.lineTo(w, Math.round(top + laneH) + 0.5);
        g.stroke();
      }
    }

    // Playhead last, on top of everything.
    drawPlayhead();
  }, [
    peaks,
    buffer,
    view,
    tileVersion,
    color,
    height,
    scrollSec,
    spp,
    playhead,
    offset,
    selection,
    band,
    secPerPx,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [draw]);

  const timeAt = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return scrollSec + (clientX - rect.left) * secPerPx;
  };

  const sampleAt = (clientX: number) =>
    Math.max(
      0,
      Math.round((timeAt(clientX) - offset) * peaks.sampleRate),
    );

  /**
   * Frequency under the pointer, read from whichever channel lane it is
   * over. Both lanes show the same frequency axis, so the channel only
   * matters for working out how far down its own lane the pointer sits.
   */
  const hzAt = (clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const chans = Math.min(2, peaks.channels);
    const laneH = rect.height / chans;
    const y = clientY - rect.top;
    const within = ((y % laneH) + laneH) % laneH;
    const bands = Math.max(1, Math.floor(laneH));
    return bandFrequency((1 - within / laneH) * bands, bands, peaks.sampleRate);
  };

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none"
      style={{ height, cursor: view === "spectrogram" ? "crosshair" : "text" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const s = sampleAt(e.clientX);
        dragStart.current = s;
        dragHz.current = view === "spectrogram" ? hzAt(e.clientY) : null;
        onSelect(null);
        if (view === "spectrogram") onBand(null);
        onScrub(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragStart.current === null) return;
        const s = sampleAt(e.clientX);
        const a = Math.min(dragStart.current, s);
        const b = Math.max(dragStart.current, s);
        // A few pixels of travel before it counts as a drag, so a plain
        // click places the cursor instead of making a zero-width selection.
        if (b - a > spp * 3) onSelect({ start: a, end: b });

        if (view === "spectrogram" && dragHz.current !== null) {
          const hz = hzAt(e.clientY);
          const loHz = Math.min(dragHz.current, hz);
          const hiHz = Math.max(dragHz.current, hz);
          // A band narrower than a couple of semitones is almost certainly
          // a horizontal drag that strayed, not a deliberate one.
          if (hiHz / loHz > 1.12) onBand({ loHz, hiHz });
        }
      }}
      onPointerUp={() => {
        dragStart.current = null;
        dragHz.current = null;
      }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
