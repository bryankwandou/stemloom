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

import { useCallback, useEffect, useRef } from "react";
import { columnsFor, type PeakSet } from "@/lib/audio/peaks";

type Props = {
  peaks: PeakSet;
  color: string;
  height: number;
  /** Leftmost visible time, in seconds. */
  scrollSec: number;
  /** Samples per pixel — the zoom level. */
  spp: number;
  playhead: number;
  offset: number;
  selection: { start: number; end: number } | null;
  onScrub: (sec: number) => void;
  onSelect: (range: { start: number; end: number } | null) => void;
};

export function Waveform({
  peaks,
  color,
  height,
  scrollSec,
  spp,
  playhead,
  offset,
  selection,
  onScrub,
  onSelect,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);

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

    // Selection wash sits underneath the waveform so it never dims it.
    if (selection) {
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
    }

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
    const px = (playhead - scrollSec) / secPerPx;
    if (px >= 0 && px <= w) {
      g.strokeStyle = "#fff";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(px) + 0.5, 0);
      g.lineTo(Math.round(px) + 0.5, h);
      g.stroke();
    }
  }, [
    peaks,
    color,
    height,
    scrollSec,
    spp,
    playhead,
    offset,
    selection,
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

  return (
    <div
      ref={wrapRef}
      className="relative w-full cursor-text select-none"
      style={{ height }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const s = sampleAt(e.clientX);
        dragStart.current = s;
        onSelect(null);
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
      }}
      onPointerUp={() => {
        dragStart.current = null;
      }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
