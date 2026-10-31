"use client";

/**
 * Project state.
 *
 * A hand-rolled external store rather than a state library. An editor
 * fires updates on every pointer move over a fader, and this lets
 * components subscribe to exactly the slice they draw instead of
 * re-rendering the whole timeline sixty times a second.
 *
 * Undo is a stack of whole snapshots. AudioBuffers are shared by
 * reference between snapshots — the edit functions never mutate, so two
 * snapshots pointing at the same buffer is safe and costs nothing.
 */

import { useSyncExternalStore } from "react";
import type { Track } from "./audio/engine";
import { emptyAutomation, valueAt, type Lane } from "./audio/automation";
import { copyRange } from "./audio/edits";
import type { EffectInstance } from "./audio/effects";
import { computePeaks, type PeakSet } from "./audio/peaks";

export type Selection = { trackId: string; start: number; end: number } | null;

export type LaneView = "wave" | "spectrogram";

/**
 * The vertical half of a spectrogram selection.
 *
 * Kept apart from `selection` rather than folded into it because the two
 * have different lifetimes: dragging in the waveform view sets a time
 * range and has no opinion about frequency, and switching views should not
 * silently throw away either one.
 */
/** A named point on the timeline, in seconds. */
export type Marker = { id: string; t: number };

export type BandSelection = { loHz: number; hiHz: number } | null;

export type ProjectState = {
  tracks: Track[];
  peaks: Record<string, PeakSet>;
  activeTrackId: string | null;
  selection: Selection;
  masterChain: EffectInstance[];
  masterDb: number;
  /** Horizontal zoom, in samples per pixel. */
  spp: number;
  scrollSec: number;
  /** Amplitude envelope, or the frequency picture over time. */
  view: LaneView;
  band: BandSelection;
  /** Which envelope the pointer edits, or null to edit audio as usual. */
  automationLane: Lane | null;
  /** When on, dragging a lane slides the whole track along the timeline. */
  moveTool: boolean;
  /** Kept sorted by time. */
  markers: Marker[];

  playhead: number;
  playing: boolean;
  clipboard: AudioBuffer | null;
  status: string;
};

const TRACK_COLORS = [
  "#f5b843",
  "#6fe3c4",
  "#7aa2f7",
  "#e07a9c",
  "#9ece6a",
  "#c39ae8",
];

const initial: ProjectState = {
  tracks: [],
  peaks: {},
  activeTrackId: null,
  selection: null,
  masterChain: [],
  masterDb: 0,
  spp: 512,
  scrollSec: 0,
  view: "wave",
  band: null,
  automationLane: null,
  moveTool: false,
  markers: [],
  playhead: 0,
  playing: false,
  clipboard: null,
  status: "Ready",
};

let state: ProjectState = initial;
const listeners = new Set<() => void>();

// Snapshots taken before each destructive action.
const undoStack: ProjectState[] = [];
const redoStack: ProjectState[] = [];
const MAX_HISTORY = 60;

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

/** Update without touching history — cursor moves, zoom, transport. */
export function set(patch: Partial<ProjectState>) {
  state = { ...state, ...patch };
  emit();
}

/**
 * State as it stood when a drag began. A drag previews through `preview`
 * many times a second; the undo point has to be where it started, not the
 * frame before it ended.
 */
let gestureBase: ProjectState | null = null;

/** A live, unrecorded change that the next `commit` will fold into one step. */
export function preview(patch: Partial<ProjectState>) {
  if (!gestureBase) gestureBase = state;
  set(patch);
}

/** Update and record an undo point. Use for anything that changes audio. */
export function commit(patch: Partial<ProjectState>, label: string) {
  undoStack.push(gestureBase ?? state);
  gestureBase = null;
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  state = { ...state, ...patch, status: label };
  emit();
}

export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(state);
  state = { ...prev, status: "Undo" };
  emit();
}

export function redo() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(state);
  state = { ...next, status: "Redo" };
  emit();
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/** Subscribe to one derived slice. Re-renders only when it actually changes. */
export function useProject<T>(selector: (s: ProjectState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initial),
  );
}

/* ------------------------------------------------------------------ */
/* Track operations                                                    */
/* ------------------------------------------------------------------ */

let trackCounter = 0;

export function addTrack(name: string, buffer: AudioBuffer) {
  const id = `t${++trackCounter}`;
  const track: Track = {
    id,
    name,
    buffer,
    offset: 0,
    gainDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
    effects: [],
    automation: emptyAutomation(),
    color: TRACK_COLORS[(trackCounter - 1) % TRACK_COLORS.length],
  };

  commit(
    {
      tracks: [...state.tracks, track],
      peaks: { ...state.peaks, [id]: computePeaks(buffer) },
      activeTrackId: id,
    },
    `Added ${name}`,
  );
  return id;
}

export function removeTrack(id: string) {
  const rest = state.tracks.filter((t) => t.id !== id);
  const peaks = { ...state.peaks };
  delete peaks[id];
  commit(
    {
      tracks: rest,
      peaks,
      activeTrackId: rest[0]?.id ?? null,
      selection: state.selection?.trackId === id ? null : state.selection,
    },
    "Removed track",
  );
}

/** Patch a track without recording history — for live fader moves. */
export function patchTrack(id: string, patch: Partial<Track>) {
  set({
    tracks: state.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  });
}

/**
 * Replace a track's audio and rebuild its peaks. Every destructive edit
 * funnels through here so history and waveform cache stay in step.
 */
export function replaceAudio(id: string, buffer: AudioBuffer, label: string) {
  commit(
    {
      tracks: state.tracks.map((t) => (t.id === id ? { ...t, buffer } : t)),
      peaks: { ...state.peaks, [id]: computePeaks(buffer) },
      selection: null,
    },
    label,
  );
}

export function activeTrack(): Track | null {
  return state.tracks.find((t) => t.id === state.activeTrackId) ?? null;
}

/** Longest point on the timeline, used to size the ruler and scrollbar. */
export function projectDuration(): number {
  if (state.tracks.length === 0) return 30;
  return Math.max(
    30,
    ...state.tracks.map((t) => t.offset + t.buffer.duration),
  );
}

/* ------------------------------------------------------------------ */
/* Effects                                                             */
/* ------------------------------------------------------------------ */

let fxCounter = 0;

export function addEffect(
  target: "master" | string,
  id: string,
  values: Record<string, number>,
) {
  const inst: EffectInstance = {
    uid: `fx${++fxCounter}`,
    id,
    enabled: true,
    values,
  };

  if (target === "master") {
    commit({ masterChain: [...state.masterChain, inst] }, "Added effect");
  } else {
    commit(
      {
        tracks: state.tracks.map((t) =>
          t.id === target ? { ...t, effects: [...t.effects, inst] } : t,
        ),
      },
      "Added effect",
    );
  }
}

export function updateEffect(
  target: "master" | string,
  uid: string,
  patch: Partial<EffectInstance>,
) {
  const apply = (list: EffectInstance[]) =>
    list.map((e) => (e.uid === uid ? { ...e, ...patch } : e));

  if (target === "master") {
    set({ masterChain: apply(state.masterChain) });
  } else {
    set({
      tracks: state.tracks.map((t) =>
        t.id === target ? { ...t, effects: apply(t.effects) } : t,
      ),
    });
  }
}

export function removeEffect(target: "master" | string, uid: string) {
  const strip = (list: EffectInstance[]) => list.filter((e) => e.uid !== uid);

  if (target === "master") {
    commit({ masterChain: strip(state.masterChain) }, "Removed effect");
  } else {
    commit(
      {
        tracks: state.tracks.map((t) =>
          t.id === target ? { ...t, effects: strip(t.effects) } : t,
        ),
      },
      "Removed effect",
    );
  }
}

/**
 * Swap the whole project out, rebuilding the peak cache for every track.
 * Used when opening something off disk.
 */
export function loadTracks(
  tracks: Track[],
  masterChain: EffectInstance[],
  masterDb: number,
  label: string,
  markers: Marker[] = [],
) {
  const peaks: Record<string, PeakSet> = {};
  for (const t of tracks) peaks[t.id] = computePeaks(t.buffer);

  // Keep the counter ahead of anything restored, or the next new track
  // would collide with an id that already exists.
  for (const t of tracks) {
    const n = Number(t.id.replace(/^t/, ""));
    if (Number.isFinite(n) && n > trackCounter) trackCounter = n;
  }

  undoStack.length = 0;
  redoStack.length = 0;
  state = {
    ...initial,
    tracks,
    peaks,
    masterChain,
    masterDb,
    markers,
    activeTrackId: tracks[0]?.id ?? null,
    status: label,
  };
  emit();
}

export function resetProject() {
  undoStack.length = 0;
  redoStack.length = 0;
  trackCounter = 0;
  state = initial;
  emit();
}

/**
 * Replace one envelope on one track. While a drag is live (`final` false)
 * this previews without history; the release commits a single undo step
 * covering the whole gesture.
 */
export function setEnvelope(
  id: string,
  lane: Lane,
  points: { t: number; v: number }[],
  final: boolean,
) {
  const tracks = state.tracks.map((t) =>
    t.id === id
      ? {
          ...t,
          automation: { ...(t.automation ?? emptyAutomation()), [lane]: points },
        }
      : t,
  );
  if (!final) return preview({ tracks });
  const name = lane === "gain" ? "Volume" : "Pan";
  commit(
    { tracks },
    points.length
      ? `${name} envelope, ${points.length} point${points.length === 1 ? "" : "s"}`
      : `${name} envelope cleared`,
  );
}

/**
 * Slide a track along the timeline. Previewed while dragging, committed as
 * one undo step on release, the same way envelope drags work.
 */
export function moveTrack(id: string, offset: number, final: boolean) {
  const at = Math.max(0, offset);
  const tracks = state.tracks.map((t) => (t.id === id ? { ...t, offset: at } : t));
  if (!final) return preview({ tracks });
  const name = state.tracks.find((t) => t.id === id)?.name ?? "track";
  commit({ tracks }, `Moved ${name} to ${at.toFixed(3)} s`);
}

/* ------------------------------------------------------------------ */
/* Arranging                                                           */
/* ------------------------------------------------------------------ */

let markerCounter = 0;

/** Drop a marker. A second one within 10 ms of an existing one is ignored. */
export function addMarker(t: number) {
  const at = Math.max(0, t);
  if (state.markers.some((m) => Math.abs(m.t - at) < 0.01)) return;
  const markers = [...state.markers, { id: `m${++markerCounter}`, t: at }].sort(
    (a, b) => a.t - b.t,
  );
  commit({ markers }, `Marker ${markers.findIndex((m) => m.t === at) + 1} at ${at.toFixed(3)} s`);
}

export function removeMarker(id: string) {
  commit({ markers: state.markers.filter((m) => m.id !== id) }, "Marker removed");
}

/** The next marker after `t` (or before it, going back), if any. */
export function neighbourMarker(t: number, dir: 1 | -1): Marker | null {
  const eps = 0.005;
  if (dir > 0) return state.markers.find((m) => m.t > t + eps) ?? null;
  for (let i = state.markers.length - 1; i >= 0; i--) {
    if (state.markers[i].t < t - eps) return state.markers[i];
  }
  return null;
}

/**
 * Cut an envelope in two at a track-local time. Each half keeps a point
 * at the cut holding the value the line had there, so neither side's
 * level jumps at the join.
 */
function splitPoints(points: { t: number; v: number }[], at: number, fallback: number) {
  if (points.length === 0) return [[], []] as const;
  const v = valueAt(points, at, fallback);
  const left = [...points.filter((p) => p.t < at), { t: at, v }];
  const right = [{ t: 0, v }, ...points.filter((p) => p.t > at).map((p) => ({ t: p.t - at, v: p.v }))];
  return [left, right] as const;
}

/**
 * Split a track at a timeline position into two tracks, the second
 * starting exactly where the cut fell. With the move tool this is how a
 * take is rearranged: split, then slide the pieces.
 */
export function splitTrack(id: string, atSec: number): boolean {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return false;
  const local = atSec - t.offset;
  const cut = Math.round(local * t.buffer.sampleRate);
  // A cut within a few milliseconds of either end would leave a sliver.
  const margin = Math.round(t.buffer.sampleRate * 0.005);
  if (cut <= margin || cut >= t.buffer.length - margin) return false;

  const left = copyRange(t.buffer, { start: 0, end: cut });
  const right = copyRange(t.buffer, { start: cut, end: t.buffer.length });
  const auto = t.automation ?? emptyAutomation();
  const [gl, gr] = splitPoints(auto.gain, cut / t.buffer.sampleRate, 0);
  const [pl, pr] = splitPoints(auto.pan, cut / t.buffer.sampleRate, t.pan);

  const nid = `t${++trackCounter}`;
  const a: Track = { ...t, buffer: left, automation: { gain: [...gl], pan: [...pl] } };
  const b: Track = {
    ...t,
    id: nid,
    name: `${t.name} (2)`,
    buffer: right,
    offset: t.offset + cut / t.buffer.sampleRate,
    effects: t.effects.map((e) => ({ ...e, uid: `${e.uid}-${nid}`, values: { ...e.values } })),
    automation: { gain: [...gr], pan: [...pr] },
    soloed: false,
  };
  const i = state.tracks.indexOf(t);
  const tracks = [...state.tracks.slice(0, i), a, b, ...state.tracks.slice(i + 1)];
  commit(
    {
      tracks,
      peaks: { ...state.peaks, [t.id]: computePeaks(left), [nid]: computePeaks(right) },
      selection: null,
    },
    `Split ${t.name} at ${atSec.toFixed(3)} s`,
  );
  return true;
}

/** A copy of a track, effects and envelopes included, placed beneath it. */
export function duplicateTrack(id: string) {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return;
  const nid = `t${++trackCounter}`;
  // Buffers are never edited in place, so the copy can share the samples.
  const copy: Track = {
    ...t,
    id: nid,
    name: `${t.name} copy`,
    effects: t.effects.map((e) => ({ ...e, uid: `${e.uid}-${nid}`, values: { ...e.values } })),
    automation: {
      gain: (t.automation?.gain ?? []).map((p) => ({ ...p })),
      pan: (t.automation?.pan ?? []).map((p) => ({ ...p })),
    },
    soloed: false,
  };
  const i = state.tracks.indexOf(t);
  commit(
    {
      tracks: [...state.tracks.slice(0, i + 1), copy, ...state.tracks.slice(i + 1)],
      peaks: { ...state.peaks, [nid]: state.peaks[t.id] ?? computePeaks(t.buffer) },
      activeTrackId: nid,
    },
    `Duplicated ${t.name}`,
  );
}
