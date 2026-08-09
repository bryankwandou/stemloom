/**
 * The Stemloom mark.
 *
 * Two vertical warp threads (the fixed structure of a loom) crossed by
 * three horizontal weft strands (the stems). The strands alternate over
 * and under exactly the way real weaving does, and their thickness swells
 * toward the centre so the group also reads as a waveform envelope.
 *
 * Built from primitives on a 32-unit grid so it stays crisp at 16px in a
 * browser tab and at 2000px on a poster.
 */

type MarkProps = {
  size?: number;
  className?: string;
  /** Draws the strands on mount instead of showing them immediately. */
  animate?: boolean;
};

// Warp threads: where the vertical structure sits on the grid.
const WARP_A = { x: 10.5, w: 2.6 };
const WARP_B = { x: 18.9, w: 2.6 };

// Clearance either side of a thread when a strand passes underneath it.
const GAP = 1.15;

function underSegments(from: number, to: number, warps: { x: number; w: number }[]) {
  // Returns the visible pieces of a strand once the warps it dives under
  // have been subtracted from its span.
  const cuts = warps
    .map((t) => [t.x - GAP, t.x + t.w + GAP] as const)
    .sort((a, b) => a[0] - b[0]);

  const out: [number, number][] = [];
  let cursor = from;
  for (const [a, b] of cuts) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < to) out.push([cursor, to]);
  return out;
}

export function Mark({ size = 32, className = "", animate = false }: MarkProps) {
  // y-centre, thickness, and which warps this strand passes beneath.
  const strands = [
    { y: 8.6, h: 2.2, under: [WARP_B] },
    { y: 16, h: 3.4, under: [WARP_A] },
    { y: 23.4, h: 2.2, under: [WARP_B] },
  ];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="Stemloom"
    >
      {/* Warp — the loom's frame. Deliberately recessive: structure
          should support the signal, not compete with it. */}
      {[WARP_A, WARP_B].map((t, i) => (
        <rect
          key={`warp-${i}`}
          x={t.x}
          y={3.6}
          width={t.w}
          height={24.8}
          rx={1.3}
          fill="var(--color-ink-faint)"
        />
      ))}

      {/* Weft — the audio. Amber, and always drawn last so the strands
          that pass "over" genuinely sit on top. */}
      {strands.map((s, i) =>
        underSegments(3.4, 28.6, s.under).map(([a, b], j) => (
          <rect
            key={`weft-${i}-${j}`}
            x={a}
            y={s.y - s.h / 2}
            width={b - a}
            height={s.h}
            rx={s.h / 2}
            fill="var(--color-signal)"
            style={
              animate
                ? {
                    animation: `weave-in 0.5s var(--ease-out-quint) both`,
                    animationDelay: `${i * 0.09 + j * 0.04}s`,
                  }
                : undefined
            }
          />
        )),
      )}
    </svg>
  );
}

export function Wordmark({
  size = 28,
  className = "",
  animate = false,
}: MarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Mark size={size} animate={animate} />
      <span
        className="font-semibold tracking-[-0.03em] text-ink"
        style={{ fontSize: size * 0.62 }}
      >
        Stemloom
      </span>
    </span>
  );
}
