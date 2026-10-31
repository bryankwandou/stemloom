/**
 * Automation: a value that moves over the length of a track.
 *
 * A fader gets you one number for the whole take. That is fine until a
 * chorus is four decibels hotter than the verse, or a guitar needs to slide
 * left while the vocal comes forward. Both of those are a line drawn over
 * time rather than a knob set once.
 *
 * Points are stored in track-local seconds, not timeline seconds. Sliding a
 * track along the timeline then carries its automation with it, which is
 * what anyone would expect and what the alternative quietly fails to do.
 */

export type Point = {
  /** Seconds from the start of the track. */
  t: number;
  v: number;
};

export type Automation = {
  /** Decibels, roughly −60 to +12. */
  gain: Point[];
  /** −1 hard left to 1 hard right. */
  pan: Point[];
};

export type Lane = keyof Automation;

export const emptyAutomation = (): Automation => ({ gain: [], pan: [] });

export const LANE_RANGE: Record<Lane, { min: number; max: number }> = {
  gain: { min: -60, max: 12 },
  pan: { min: -1, max: 1 },
};

/**
 * Value of an envelope at a given moment.
 *
 * Before the first point and after the last one the envelope holds flat
 * rather than running off toward nothing. An envelope with no points at all
 * hands back the fader setting, so adding a lane and drawing nothing on it
 * changes precisely nothing.
 */
export function valueAt(points: Point[], t: number, fallback: number): number {
  if (points.length === 0) return fallback;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;

  // Linear scan. An envelope is drawn by hand and rarely runs past a few
  // dozen points, so a binary search would cost more in complexity than it
  // saves in time.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.v;
      return a.v + ((b.v - a.v) * (t - a.t)) / span;
    }
  }
  return last.v;
}

/** Sorted by time, with any two points at the same instant collapsed. */
export function normalise(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out: Point[] = [];
  for (const p of sorted) {
    if (out.length && Math.abs(out[out.length - 1].t - p.t) < 1e-6) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Write an envelope onto an AudioParam.
 *
 * `origin` is the context time at which the track's own clock reads zero,
 * so a track sitting three seconds into the timeline has an origin of three
 * and its first point lands there. `localStart` is where playback is
 * beginning within the track, which may be part-way through the envelope or
 * before it starts.
 *
 * Events already in the past are not scheduled. The parameter is set once
 * to whatever the envelope reads at `localStart` and ramps from there,
 * which is the difference between resuming mid-fade at the right level and
 * jumping to the beginning of the fade.
 */
export function schedule(
  param: AudioParam,
  points: Point[],
  origin: number,
  localStart: number,
  now: number,
  fallback: number,
  transform: (v: number) => number = (v) => v,
) {
  const env = normalise(points);
  param.cancelScheduledValues(now);

  if (env.length === 0) {
    param.setValueAtTime(transform(fallback), now);
    return;
  }

  param.setValueAtTime(transform(valueAt(env, localStart, fallback)), now);

  for (const p of env) {
    const at = origin + p.t;
    if (at <= now) continue;
    // Ramping on the transformed value rather than in decibels. A straight
    // line drawn between two amplitudes is what a fade sounds like; a
    // straight line in decibels sags in the middle.
    param.linearRampToValueAtTime(transform(p.v), at);
  }
}
