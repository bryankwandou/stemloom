"use client";

/**
 * Saved projects.
 *
 * Everything lives in this browser profile on this machine. That is the
 * honest trade for a tool with no server: your work is private by
 * construction, and it is also not backed up anywhere. The dialog says so
 * rather than letting anyone find out the hard way.
 */

import { useCallback, useEffect, useState } from "react";
import type { Track } from "@/lib/audio/engine";
import type { EffectInstance } from "@/lib/audio/effects";
import {
  deleteProject,
  listProjects,
  loadProject,
  requestPersistence,
  saveProject,
  storageUsage,
  type ProjectSummary,
} from "@/lib/persist";
import { loadTracks } from "@/lib/store";

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function ago(ts: number) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(ts).toLocaleDateString();
}

export function ProjectsDialog({
  tracks,
  masterChain,
  masterDb,
  onClose,
  onStatus,
}: {
  tracks: Track[];
  masterChain: EffectInstance[];
  masterDb: number;
  onClose: () => void;
  onStatus: (msg: string) => void;
}) {
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await listProjects());
      setUsage(await storageUsage());
    } catch {
      onStatus("Local storage could not be read.");
    }
  }, [onStatus]);

  useEffect(() => {
    void refresh();
    // Asking for durable storage the first time the user shows intent to
    // save is the moment it is most likely to be granted.
    void requestPersistence();
  }, [refresh]);

  const save = async () => {
    if (!tracks.length) {
      onStatus("Nothing to save yet.");
      return;
    }
    setBusy(true);
    try {
      const label = name.trim() || `Session ${new Date().toLocaleString()}`;
      await saveProject(label, tracks, masterChain, masterDb);
      setName("");
      await refresh();
      onStatus(`Saved as "${label}".`);
    } catch {
      onStatus("Save failed. The browser may be out of quota.");
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string, label: string) => {
    setBusy(true);
    try {
      const proj = await loadProject(id);
      if (!proj) {
        onStatus("That project could not be found.");
        return;
      }
      loadTracks(
        proj.tracks,
        proj.masterChain,
        proj.masterDb,
        `Opened "${proj.name}"`,
      );
      onClose();
    } catch {
      onStatus(`"${label}" could not be opened.`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await deleteProject(id);
    setConfirming(null);
    await refresh();
    onStatus("Project deleted.");
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-[12px] border border-line bg-panel p-5 anim-weave"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold">Projects</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
          Stored in this browser on this machine. Nothing syncs, which also
          means nothing leaks — but clearing site data will take these with
          it.
        </p>

        {/* Save */}
        <div className="mt-4 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
            placeholder="Name this session"
            className="min-w-0 flex-1 rounded-[6px] border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-signal"
          />
          <button
            onClick={save}
            disabled={busy || !tracks.length}
            className="shrink-0 rounded-[6px] bg-signal px-3.5 py-1.5 text-[12.5px] font-medium text-black transition-transform hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100"
          >
            Save current
          </button>
        </div>

        {/* List */}
        <div className="mt-4 max-h-[300px] space-y-1.5 overflow-y-auto">
          {items.length === 0 && (
            <p className="py-8 text-center text-[12px] text-ink-faint">
              No saved projects yet.
            </p>
          )}

          {items.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-[8px] border border-line bg-canvas px-3 py-2.5 transition-colors hover:border-ink-faint"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-ink">{p.name}</div>
                <div className="tnum mt-0.5 text-[10.5px] text-ink-faint">
                  {p.trackCount} track{p.trackCount === 1 ? "" : "s"} ·{" "}
                  {p.duration.toFixed(1)}s · {bytes(p.bytes)} · {ago(p.savedAt)}
                </div>
              </div>

              {confirming === p.id ? (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => remove(p.id)}
                    className="rounded-[5px] bg-alert px-2 py-1 text-[11px] font-medium text-black"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded-[5px] border border-line px-2 py-1 text-[11px] text-ink-dim"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => open(p.id, p.name)}
                    disabled={busy}
                    className="rounded-[5px] border border-line px-2.5 py-1 text-[11.5px] text-ink-dim transition-colors hover:border-signal hover:text-signal disabled:opacity-40"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => setConfirming(p.id)}
                    className="text-ink-faint transition-colors hover:text-alert"
                    aria-label={`Delete ${p.name}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16">
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {usage && usage.quota > 0 && (
          <div className="mt-4 border-t border-line-soft pt-3">
            <div className="flex justify-between text-[10.5px] text-ink-faint">
              <span>Local storage used</span>
              <span className="tnum">
                {bytes(usage.used)} of {bytes(usage.quota)}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-signal transition-[width] duration-500"
                style={{
                  width: `${Math.min(100, (usage.used / usage.quota) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-4 w-full rounded-[6px] border border-line py-2 text-[12.5px] text-ink-dim transition-colors hover:text-ink"
        >
          Close
        </button>
      </div>
    </div>
  );
}
