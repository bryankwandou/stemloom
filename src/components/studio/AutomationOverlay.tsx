"use client";

/**
 * An envelope drawn over a track lane.
 *
 * SVG rather than canvas: an envelope is a handful of points, each of which
 * has to be hit-tested, dragged, and focusable, and that is exactly what
 * the DOM is good at. The waveform underneath has thousands of strokes and
 * stays on canvas.
 *
 * When `editing` is off the line is still drawn, faintly, and lets every
 * pointer event through to the waveform. A lane with automation on it
 * should never look identical to one without.
 */

import { useRef, useState } from "react";
import {
  LANE_RANGE,
  normalise,
  valueAt,
  type Lane,
  type Point,
} from "@/lib/audio/automation";

type Props = {
  lane: Lane;
  points: Point[];
  /** The fader value, which a lane with no points reads as. */
  fallback: number;
  editing: boolean;
  color: string;
  height: number;
  scrollSec: number;
  secPerPx: number;
  /** Track offset on the timeline, in seconds. */
  offset: number;
  /** Track length, so points cannot be dragged past either end. */
  duration: number;
  /** `final` is false while a drag is in progress and true on release. */
  onChange: (points: Point[], final: boolean) => void;
};

/** Pixels within which a press lands on an existing point. */
const HIT = 7;

export function formatLaneValue(lane: Lane, v: number) {
  if (lane === "gain") return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
  if (Math.abs(v) < 0.005) return "C";
  return `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`;
}

export function AutomationOverlay({
  lane,
  points,
  fallback,
  editing,
  color,
  height,
  scrollSec,
  secPerPx,
  offset,
  duration,
  onChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);

  const { min, max } = LANE_RANGE[lane];
  const pad = 6;
  const usable = height - pad * 2;

  const xOf = (t: number) => (offset + t - scrollSec) / secPerPx;
  const yOf = (v: number) => pad + (1 - (v - min) / (max - min)) * usable;
  const tOf = (x: number) =>
    Math.min(duration, Math.max(0, x * secPerPx + scrollSec - offset));
  const vOf = (y: number) => {
    const raw = min + (1 - (y - pad) / usable) * (max - min);
    const clamped = Math.min(max, Math.max(min, raw));
    // A gentle snap to the neutral value. Landing exactly on 0 dB or dead
    // centre by hand is otherwise nearly impossible.
    // Both lanes happen to be neutral at zero: unity gain, dead centre.
    return Math.abs(clamped) < (max - min) * 0.025 ? 0 : clamped;
  };

  const local = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    if (r.width !== width) setWidth(r.width);
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitIndex = (x: number, y: number) => {
    let best = -1;
    let bestD = HIT;
    points.forEach((p, i) => {
      const d = Math.hypot(xOf(p.t) - x, yOf(p.v) - y);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };

  // Path across the visible span. The envelope holds flat beyond its first
  // and last points, so the line runs from the track start to its end.
  const startX = xOf(0);
  const endX = xOf(duration);
  let d = "";
  if (points.length === 0) {
    const y = yOf(fallback);
    d = `M${startX},${y}L${endX},${y}`;
  } else {
    d = `M${startX},${yOf(points[0].v)}`;
    for (const p of points) d += `L${xOf(p.t)},${yOf(p.v)}`;
    d += `L${endX},${yOf(points[points.length - 1].v)}`;
  }
  const neutralY = yOf(0);
  const shown = hover !== null ? points[hover] : null;

  return (
    <svg
      ref={svgRef}
      data-automation-lane={lane}
      className="absolute inset-0 h-full w-full"
      style={{
        pointerEvents: editing ? "auto" : "none",
        cursor: editing ? (hover !== null ? "grab" : "copy") : undefined,
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        if (!editing) return;
        e.stopPropagation();
        const { x, y } = local(e);
        const i = hitIndex(x, y);

        // Alt-click or a right button on a point removes it, the same
        // gesture the larger editors settled on.
        if (i >= 0 && (e.altKey || e.button === 2)) {
          e.preventDefault();
          onChange(points.filter((_, k) => k !== i), true);
          setHover(null);
          return;
        }

        e.currentTarget.setPointerCapture(e.pointerId);
        if (i >= 0) {
          drag.current = { index: i, moved: false };
          return;
        }

        // A press on the line itself adds a point where the line already
        // is, so clicking to add a handle never changes what you hear.
        const t = tOf(x);
        const onLine = Math.abs(yOf(valueAt(points, t, fallback)) - y) < HIT;
        const v = onLine ? valueAt(points, t, fallback) : vOf(y);
        const next = normalise([...points, { t, v }]);
        const index = next.findIndex((p) => p.t === t);
        onChange(next, false);
        drag.current = { index, moved: true };
        setHover(index);
      }}
      onPointerMove={(e) => {
        if (!editing) return;
        const { x, y } = local(e);
        const g = drag.current;
        if (!g) {
          const i = hitIndex(x, y);
          setHover(i >= 0 ? i : null);
          return;
        }
        // Neighbours bound the drag so points never pass each other; the
        // order of an envelope is its meaning.
        const lo = g.index > 0 ? points[g.index - 1].t + 1e-3 : 0;
        const hi =
          g.index < points.length - 1 ? points[g.index + 1].t - 1e-3 : duration;
        const t = Math.min(hi, Math.max(lo, tOf(x)));
        const next = points.map((p, k) =>
          k === g.index ? { t, v: vOf(y) } : p,
        );
        g.moved = true;
        onChange(next, false);
      }}
      onPointerUp={() => {
        const g = drag.current;
        drag.current = null;
        if (g?.moved) onChange(points, true);
      }}
      onDoubleClick={(e) => {
        if (!editing) return;
        const { x, y } = local(e as unknown as React.PointerEvent);
        const i = hitIndex(x, y);
        if (i >= 0) {
          onChange(points.filter((_, k) => k !== i), true);
          setHover(null);
        }
      }}
      onContextMenu={(e) => editing && e.preventDefault()}
      onPointerLeave={() => !drag.current && setHover(null)}
    >
      {editing && (
        <>
          <rect x={0} y={0} width="100%" height="100%" fill="rgba(0,0,0,0.35)" />
          <line
            x1={0}
            x2="100%"
            y1={neutralY}
            y2={neutralY}
            stroke="var(--color-line)"
            strokeDasharray="2 4"
          />
        </>
      )}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={editing ? 1.5 : 1}
        strokeOpacity={editing ? 1 : points.length ? 0.55 : 0}
        strokeLinejoin="round"
      />
      {editing &&
        points.map((p, i) => (
          <circle
            key={i}
            data-automation-point={i}
            cx={xOf(p.t)}
            cy={yOf(p.v)}
            r={hover === i ? 4.5 : 3.5}
            fill={hover === i ? color : "var(--color-canvas)"}
            stroke={color}
            strokeWidth={1.5}
          />
        ))}
      {editing && shown && (
        <text
          x={Math.min(Math.max(xOf(shown.t) + 8, 4), Math.max(4, width - 64))}
          y={Math.max(12, yOf(shown.v) - 8)}
          fill="var(--color-ink)"
          fontSize={10}
          className="tnum"
        >
          {formatLaneValue(lane, shown.v)}
        </text>
      )}
    </svg>
  );
}
