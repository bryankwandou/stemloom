/**
 * Saving projects.
 *
 * IndexedDB rather than localStorage, because localStorage stores strings
 * and a five-minute stereo take base64'd is roughly forty megabytes of
 * text against a quota that is usually five. IndexedDB takes ArrayBuffers
 * directly and has no practical ceiling.
 *
 * Audio is stored as raw float channel data. It is bulky, but re-encoding
 * on every save would be slow and would quietly degrade the take each time
 * — the exact generation loss an editor exists to avoid.
 */

import type { Track } from "./audio/engine";
import type { EffectInstance } from "./audio/effects";

const DB_NAME = "stemloom";
const DB_VERSION = 1;
const STORE = "projects";

export type ProjectSummary = {
  id: string;
  name: string;
  savedAt: number;
  trackCount: number;
  duration: number;
  bytes: number;
};

type StoredTrack = {
  id: string;
  name: string;
  offset: number;
  gainDb: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  color: string;
  effects: EffectInstance[];
  sampleRate: number;
  length: number;
  channels: ArrayBuffer[];
};

type StoredProject = ProjectSummary & {
  tracks: StoredTrack[];
  masterChain: EffectInstance[];
  masterDb: number;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("savedAt", "savedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export function isAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function saveProject(
  name: string,
  tracks: Track[],
  masterChain: EffectInstance[],
  masterDb: number,
  existingId?: string,
): Promise<string> {
  const id = existingId ?? `p${Date.now().toString(36)}`;
  let bytes = 0;

  const stored: StoredTrack[] = tracks.map((t) => {
    const channels: ArrayBuffer[] = [];
    for (let c = 0; c < t.buffer.numberOfChannels; c++) {
      // Copy out of the AudioBuffer: the underlying memory is not
      // structured-cloneable and must not be handed to IndexedDB directly.
      const data = new Float32Array(t.buffer.getChannelData(c));
      channels.push(data.buffer as ArrayBuffer);
      bytes += data.byteLength;
    }
    return {
      id: t.id,
      name: t.name,
      offset: t.offset,
      gainDb: t.gainDb,
      pan: t.pan,
      muted: t.muted,
      soloed: t.soloed,
      color: t.color,
      effects: t.effects,
      sampleRate: t.buffer.sampleRate,
      length: t.buffer.length,
      channels,
    };
  });

  const record: StoredProject = {
    id,
    name,
    savedAt: Date.now(),
    trackCount: tracks.length,
    duration: Math.max(0, ...tracks.map((t) => t.offset + t.buffer.duration)),
    bytes,
    tracks: stored,
    masterChain,
    masterDb,
  };

  await tx("readwrite", (s) => s.put(record));
  return id;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await tx<StoredProject[]>("readonly", (s) => s.getAll());
  return all
    .map(({ id, name, savedAt, trackCount, duration, bytes }) => ({
      id,
      name,
      savedAt,
      trackCount,
      duration,
      bytes,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export type LoadedProject = {
  name: string;
  tracks: Track[];
  masterChain: EffectInstance[];
  masterDb: number;
};

export async function loadProject(id: string): Promise<LoadedProject | null> {
  const rec = await tx<StoredProject | undefined>("readonly", (s) =>
    s.get(id),
  );
  if (!rec) return null;

  const factory = new OfflineAudioContext(1, 1, 44100);

  const tracks: Track[] = rec.tracks.map((st) => {
    const buffer = factory.createBuffer(
      Math.max(1, st.channels.length),
      Math.max(1, st.length),
      st.sampleRate,
    );
    st.channels.forEach((raw, c) => {
      buffer.copyToChannel(new Float32Array(raw), c);
    });

    return {
      id: st.id,
      name: st.name,
      buffer,
      offset: st.offset,
      gainDb: st.gainDb,
      pan: st.pan,
      muted: st.muted,
      soloed: st.soloed,
      effects: st.effects ?? [],
      color: st.color,
    };
  });

  return {
    name: rec.name,
    tracks,
    masterChain: rec.masterChain ?? [],
    masterDb: rec.masterDb ?? 0,
  };
}

export async function deleteProject(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** How much of the browser's quota this origin is currently using. */
export async function storageUsage(): Promise<{
  used: number;
  quota: number;
} | null> {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  return { used: est.usage ?? 0, quota: est.quota ?? 0 };
}

/**
 * Ask the browser not to evict this origin under storage pressure.
 * Without it, a project can vanish when the disk gets tight.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
