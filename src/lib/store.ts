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
import type { EffectInstance } from "./audio/effects";
import { computePeaks, type PeakSet } from "./audio/peaks";

export type Selection = { trackId: string; start: number; end: number } | null;

export type LaneView = "wave" | "spectrogram";

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

/** Update and record an undo point. Use for anything that changes audio. */
export function commit(patch: Partial<ProjectState>, label: string) {
  undoStack.push(state);
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
