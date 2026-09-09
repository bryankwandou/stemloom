"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Mark } from "@/components/brand/Logo";
import { Waveform } from "@/components/studio/Waveform";
import { FxRack } from "@/components/studio/FxRack";
import { ExportDialog } from "@/components/studio/ExportDialog";
import { ProjectsDialog } from "@/components/studio/ProjectsDialog";
import { RecordButton } from "@/components/studio/RecordButton";
import { ShortcutsDialog } from "@/components/studio/ShortcutsDialog";
import { Engine, type Track } from "@/lib/audio/engine";
import * as ed from "@/lib/audio/edits";
import {
  addTrack,
  canRedo,
  canUndo,
  getState,
  patchTrack,
  projectDuration,
  redo,
  removeTrack,
  replaceAudio,
  set,
  undo,
  useProject,
} from "@/lib/store";

const LANE_H = 96;

function timecode(sec: number) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const ms = Math.floor((r % 1) * 1000);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(r)).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */

function Meter({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    // Peak hold decays slowly so a transient stays readable for a moment
    // instead of flashing past at 60fps.
    let holdL = 0;
    let holdR = 0;

    const tick = () => {
      const c = ref.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        const w = 150;
        const h = 26;
        if (c.width !== w * dpr) {
          c.width = w * dpr;
          c.height = h * dpr;
          c.style.width = `${w}px`;
          c.style.height = `${h}px`;
        }
        const g = c.getContext("2d")!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);

        const m = engine.masterMeter();
        holdL = Math.max(m.peak, holdL - 0.008);
        holdR = Math.max(m.rms, holdR - 0.008);

        const bars = [
          { v: holdL, y: 3, label: "peak" },
          { v: holdR, y: 15, label: "rms" },
        ];

        for (const b of bars) {
          g.fillStyle = "rgba(255,255,255,0.06)";
          g.fillRect(0, b.y, w, 8);

          // dBFS is the meaningful scale, not raw amplitude.
          const db = b.v > 0 ? 20 * Math.log10(b.v) : -60;
          const frac = Math.max(0, Math.min(1, (db + 60) / 60));
          const px = frac * w;

          const grad = g.createLinearGradient(0, 0, w, 0);
          grad.addColorStop(0, "#2fa387");
          grad.addColorStop(0.72, "#6fe3c4");
          grad.addColorStop(0.88, "#f5b843");
          grad.addColorStop(1, "#f2603c");
          g.fillStyle = grad;
          g.fillRect(0, b.y, px, 8);
        }

        // -6dBFS reference tick, the mark most people mix toward.
        g.fillStyle = "rgba(255,255,255,0.25)";
        g.fillRect(w * 0.9, 1, 1, h - 2);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return <canvas ref={ref} className="block" aria-label="Master level" />;
}

function Spectrum({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const bins = new Uint8Array(1024);

    const tick = () => {
      const c = ref.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        const w = c.clientWidth;
        const h = 54;
        if (w > 0 && c.width !== w * dpr) {
          c.width = w * dpr;
          c.height = h * dpr;
          c.style.height = `${h}px`;
        }
        const g = c.getContext("2d")!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);

        if (engine.spectrum(bins)) {
          const cols = 64;
          const bw = w / cols;
          for (let i = 0; i < cols; i++) {
            // Log frequency mapping: linear bins waste most of the width
            // on content nobody can hear as pitch.
            const lo = Math.floor(Math.pow(i / cols, 2.2) * 512);
            const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / cols, 2.2) * 512));
            let v = 0;
            for (let b = lo; b < hi; b++) v = Math.max(v, bins[b]);
            const bh = (v / 255) * h;
            g.fillStyle = `rgba(245,184,67,${0.25 + (v / 255) * 0.7})`;
            g.fillRect(i * bw, h - bh, bw - 1, bh);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return <canvas ref={ref} className="block w-full" aria-hidden />;
}

/* ------------------------------------------------------------------ */

function ToolButton({
  onClick,
  disabled,
  children,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-[5px] px-2 py-1 text-[11.5px] text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */

export default function Studio() {
  // Safe to build during prerender: the constructor does not touch
  // AudioContext, which is created lazily on the first user gesture.
  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) engineRef.current = new Engine();
  const engine = engineRef.current;

  const tracks = useProject((s) => s.tracks);
  const peaks = useProject((s) => s.peaks);
  const activeId = useProject((s) => s.activeTrackId);
  const selection = useProject((s) => s.selection);
  const spp = useProject((s) => s.spp);
  const scrollSec = useProject((s) => s.scrollSec);
  const playhead = useProject((s) => s.playhead);
  const playing = useProject((s) => s.playing);
  const masterChain = useProject((s) => s.masterChain);
  const masterDb = useProject((s) => s.masterDb);
  const status = useProject((s) => s.status);

  const [busy, setBusy] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [rackTab, setRackTab] = useState<"track" | "master">("track");
  const fileRef = useRef<HTMLInputElement>(null);

  const active = tracks.find((t) => t.id === activeId) ?? null;
  const duration = useMemo(
    () => (tracks.length ? projectDuration() : 30),
    [tracks],
  );

  /* ---- Import ---------------------------------------------------- */

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const ctx = engine.context();
      for (const f of Array.from(files)) {
        setBusy(`Decoding ${f.name}`);
        try {
          const buf = await ctx.decodeAudioData(await f.arrayBuffer());
          addTrack(f.name.replace(/\.[^.]+$/, ""), buf);
        } catch {
          set({ status: `Could not decode ${f.name}` });
        }
      }
      setBusy(null);
    },
    [engine],
  );

  /** A synthesised test signal, so the editor is usable with no files. */
  const addTestTone = useCallback(() => {
    const rate = engine.context().sampleRate;
    const secs = 8;
    const buf = ed.makeBuffer(2, rate * secs, rate);

    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const t = i / rate;
        // A simple chord with a plucked envelope, detuned per channel so
        // there is real stereo information to look at.
        const env = Math.exp(-((t % 2) * 2.2));
        const detune = c === 0 ? 1 : 1.004;
        d[i] =
          0.34 *
          env *
          (Math.sin(2 * Math.PI * 220 * detune * t) * 0.5 +
            Math.sin(2 * Math.PI * 277.18 * detune * t) * 0.32 +
            Math.sin(2 * Math.PI * 329.63 * detune * t) * 0.26 +
            Math.sin(2 * Math.PI * 110 * detune * t) * 0.4);
      }
    }
    addTrack("Test Chord", buf);
  }, [engine]);

  /* ---- Transport -------------------------------------------------- */

  const togglePlay = useCallback(async () => {
    const s = getState();
    if (s.playing) {
      engine.pause();
      set({ playing: false, playhead: engine.position() });
    } else {
      if (s.tracks.length === 0) return;
      await engine.play(s.tracks, s.playhead, s.masterDb);
      set({ playing: true });
    }
  }, [engine]);

  const stopAll = useCallback(() => {
    engine.stop();
    set({ playing: false, playhead: 0 });
  }, [engine]);

  // Drive the playhead from the audio clock, not from a setInterval.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const p = engine.position();
      if (p >= duration) {
        engine.stop();
        set({ playing: false, playhead: 0 });
        return;
      }
      set({ playhead: p });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, engine, duration]);

  /* ---- Edit operations ------------------------------------------- */

  const withActive = (
    fn: (buf: AudioBuffer, range: ed.Range | undefined) => AudioBuffer,
    label: string,
  ) => {
    if (!active) return;
    const r = selection?.trackId === active.id ? selection : undefined;
    replaceAudio(active.id, fn(active.buffer, r), label);
  };

  const doCopy = () => {
    if (!active || !selection || selection.trackId !== active.id) return;
    set({
      clipboard: ed.copyRange(active.buffer, selection),
      status: "Copied",
    });
  };

  const cutSelection = () => {
    if (!active || !selection || selection.trackId !== active.id) return;
    set({ clipboard: ed.copyRange(active.buffer, selection) });
    replaceAudio(active.id, ed.deleteRange(active.buffer, selection), "Cut");
  };

  const paste = () => {
    const s = getState();
    if (!active || !s.clipboard) return;
    const at = Math.floor(
      (s.playhead - active.offset) * active.buffer.sampleRate,
    );
    replaceAudio(
      active.id,
      ed.insertAt(active.buffer, s.clipboard, Math.max(0, at)),
      "Pasted",
    );
  };

  /* ---- Keyboard --------------------------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;

      const mod = e.metaKey || e.ctrlKey;

      if (e.code === "Space") {
        e.preventDefault();
        void togglePlay();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === "c") {
        doCopy();
      } else if (mod && e.key.toLowerCase() === "x") {
        cutSelection();
      } else if (mod && e.key.toLowerCase() === "v") {
        paste();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        cutSelection();
      } else if (e.key === "Home") {
        set({ playhead: 0 });
        engine.seek(0);
      } else if (e.key === "=" || e.key === "+") {
        set({ spp: Math.max(16, getState().spp / 1.6) });
      } else if (e.key === "-") {
        set({ spp: Math.min(65536, getState().spp * 1.6) });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlay, active, selection]);

  useEffect(() => () => engine.dispose(), [engine]);

  /* ---- Render ----------------------------------------------------- */

  const secPerPx = spp / (engine.sampleRate || 48000);
  const hasSel = !!selection && selection.trackId === activeId;

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-void text-ink"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      {/* ---- Top bar ---- */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-canvas px-3">
        <Link href="/" className="flex items-center gap-2">
          <Mark size={19} />
          <span className="text-[13px] font-semibold tracking-[-0.02em]">
            Stemloom
          </span>
        </Link>

        <div className="mx-1 h-4 w-px bg-line" />

        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(e) => e.target.files && void importFiles(e.target.files)}
        />
        <ToolButton onClick={() => fileRef.current?.click()} title="Import audio">
          Import
        </ToolButton>
        <ToolButton onClick={addTestTone} title="Insert a synthesised test signal">
          Test Signal
        </ToolButton>
        <RecordButton engine={engine} onStatus={(m) => set({ status: m })} />
        <ToolButton onClick={() => setShowProjects(true)} title="Save or open a project">
          Projects
        </ToolButton>
        <ToolButton onClick={() => setShowExport(true)} disabled={!tracks.length}>
          Export
        </ToolButton>

        <div className="mx-1 h-4 w-px bg-line" />

        <ToolButton onClick={undo} disabled={!canUndo()} title="Undo (Ctrl+Z)">
          Undo
        </ToolButton>
        <ToolButton onClick={redo} disabled={!canRedo()} title="Redo (Ctrl+Shift+Z)">
          Redo
        </ToolButton>

        <div className="ml-auto flex items-center gap-3">
          <span className="max-w-[280px] truncate text-[11px] text-ink-faint">
            {status}
          </span>
          <button
            onClick={() => setShowKeys(true)}
            title="Keyboard shortcuts"
            className="grid size-6 place-items-center rounded-[5px] border border-line text-[10px] text-ink-faint transition-colors hover:border-signal hover:text-signal"
          >
            ?
          </button>
          <Meter engine={engine} />
        </div>
      </header>

      {/* ---- Edit toolbar ---- */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-canvas px-3">
        <ToolButton onClick={doCopy} disabled={!hasSel}>Copy</ToolButton>
        <ToolButton onClick={cutSelection} disabled={!hasSel}>Cut</ToolButton>
        <ToolButton onClick={paste} disabled={!active}>Paste</ToolButton>
        <ToolButton
          onClick={() => withActive((b, r) => (r ? ed.cropTo(b, r) : b), "Cropped")}
          disabled={!hasSel}
        >
          Crop
        </ToolButton>
        <ToolButton
          onClick={() => withActive((b, r) => (r ? ed.silenceRange(b, r) : b), "Silenced")}
          disabled={!hasSel}
        >
          Silence
        </ToolButton>

        <div className="mx-1.5 h-4 w-px bg-line" />

        <ToolButton
          onClick={() =>
            withActive(
              (b, r) => ed.fade(b, r ?? { start: 0, end: Math.min(b.length, b.sampleRate) }, "in"),
              "Fade in",
            )
          }
          disabled={!active}
        >
          Fade In
        </ToolButton>
        <ToolButton
          onClick={() =>
            withActive(
              (b, r) =>
                ed.fade(b, r ?? { start: Math.max(0, b.length - b.sampleRate), end: b.length }, "out"),
              "Fade out",
            )
          }
          disabled={!active}
        >
          Fade Out
        </ToolButton>

        <div className="mx-1.5 h-4 w-px bg-line" />

        <ToolButton onClick={() => withActive((b, r) => ed.normalize(b, -1, r), "Normalised")} disabled={!active}>
          Normalise
        </ToolButton>
        <ToolButton onClick={() => withActive((b, r) => ed.gainDb(b, 3, r), "Gain +3dB")} disabled={!active}>
          +3 dB
        </ToolButton>
        <ToolButton onClick={() => withActive((b, r) => ed.gainDb(b, -3, r), "Gain -3dB")} disabled={!active}>
          −3 dB
        </ToolButton>
        <ToolButton onClick={() => withActive((b, r) => ed.reverse(b, r), "Reversed")} disabled={!active}>
          Reverse
        </ToolButton>
        <ToolButton onClick={() => withActive((b, r) => ed.invertPhase(b, r), "Phase inverted")} disabled={!active}>
          Invert
        </ToolButton>

        <div className="mx-1.5 h-4 w-px bg-line" />

        <ToolButton onClick={() => withActive((b) => ed.trimSilence(b), "Trimmed silence")} disabled={!active}>
          Trim Silence
        </ToolButton>
        <ToolButton onClick={() => withActive((b) => ed.removeDcOffset(b), "DC offset removed")} disabled={!active}>
          Fix DC
        </ToolButton>
        <ToolButton onClick={() => withActive((b) => ed.swapChannels(b), "Channels swapped")} disabled={!active}>
          Swap L/R
        </ToolButton>

        <div className="ml-auto flex items-center gap-1">
          <ToolButton onClick={() => set({ spp: Math.min(65536, spp * 1.6) })} title="Zoom out (−)">
            −
          </ToolButton>
          <span className="tnum w-16 text-center text-[10.5px] text-ink-faint">
            {spp < 1000 ? `${spp.toFixed(0)} s/px` : `${(spp / 1000).toFixed(1)}k s/px`}
          </span>
          <ToolButton onClick={() => set({ spp: Math.max(16, spp / 1.6) })} title="Zoom in (+)">
            +
          </ToolButton>
        </div>
      </div>

      {/* ---- Main ---- */}
      <div className="flex min-h-0 flex-1">
        {/* Timeline */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            {tracks.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                <Mark size={44} animate />
                <div>
                  <p className="text-[15px] text-ink">Drop an audio file anywhere</p>
                  <p className="mt-1 text-[12.5px] text-ink-dim">
                    Nothing is uploaded. Decoding, editing, and export all happen
                    in this tab.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="rounded-[6px] bg-signal px-3.5 py-1.5 text-[12.5px] font-medium text-black transition-transform hover:scale-[1.02] active:scale-[0.99]"
                  >
                    Choose file
                  </button>
                  <button
                    onClick={addTestTone}
                    className="rounded-[6px] border border-line px-3.5 py-1.5 text-[12.5px] text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
                  >
                    Use a test signal
                  </button>
                </div>
              </div>
            ) : (
              tracks.map((t) => (
                <TrackLane
                  key={t.id}
                  track={t}
                  peaks={peaks[t.id]}
                  isActive={t.id === activeId}
                  scrollSec={scrollSec}
                  spp={spp}
                  playhead={playhead}
                  selection={
                    selection?.trackId === t.id
                      ? { start: selection.start, end: selection.end }
                      : null
                  }
                  onSelect={(r) =>
                    set({
                      selection: r ? { trackId: t.id, ...r } : null,
                      activeTrackId: t.id,
                    })
                  }
                  onScrub={(sec) => {
                    set({ playhead: Math.max(0, sec), activeTrackId: t.id });
                    engine.seek(Math.max(0, sec));
                  }}
                  engine={engine}
                />
              ))
            )}
          </div>

          {/* Transport */}
          <div className="flex h-14 shrink-0 items-center gap-4 border-t border-line bg-canvas px-4">
            <div className="flex items-center gap-1.5">
              <button
                onClick={stopAll}
                className="grid size-8 place-items-center rounded-[6px] border border-line text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
                aria-label="Stop"
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <rect width="10" height="10" rx="1.5" fill="currentColor" />
                </svg>
              </button>
              <button
                onClick={togglePlay}
                disabled={!tracks.length}
                className="grid size-9 place-items-center rounded-[6px] bg-signal text-black transition-transform hover:scale-105 active:scale-95 disabled:opacity-30 disabled:hover:scale-100"
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? (
                  <svg width="11" height="12" viewBox="0 0 11 12">
                    <rect width="3.5" height="12" rx="1" fill="currentColor" />
                    <rect x="7.5" width="3.5" height="12" rx="1" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="12" height="13" viewBox="0 0 12 13">
                    <path d="M1 1.3v10.4a.6.6 0 0 0 .92.5l8.3-5.2a.6.6 0 0 0 0-1L1.92.8A.6.6 0 0 0 1 1.3Z" fill="currentColor" />
                  </svg>
                )}
              </button>
            </div>

            <div className="tnum text-[19px] tracking-tight text-ink">
              {timecode(playhead)}
            </div>
            <div className="tnum text-[11px] text-ink-faint">
              / {timecode(duration)}
            </div>

            <div className="mx-2 h-7 w-px bg-line" />

            <div className="min-w-0 flex-1">
              <Spectrum engine={engine} />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                Master
              </span>
              <input
                type="range"
                min={-40}
                max={12}
                step={0.5}
                value={masterDb}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  set({ masterDb: v });
                  engine.setMasterGain(v);
                }}
                className="w-24"
                aria-label="Master gain"
              />
              <span className="tnum w-12 text-right text-[11px] text-ink-dim">
                {masterDb > 0 ? "+" : ""}
                {masterDb.toFixed(1)}
              </span>
            </div>
          </div>
        </div>

        {/* Right rack */}
        <aside className="flex w-[264px] shrink-0 flex-col border-l border-line bg-canvas">
          <div className="flex shrink-0 border-b border-line">
            {(["track", "master"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setRackTab(tab)}
                className="flex-1 border-b-2 px-3 py-2 text-[11px] uppercase tracking-[0.12em] transition-colors"
                style={{
                  borderColor: rackTab === tab ? "var(--color-signal)" : "transparent",
                  color: rackTab === tab ? "var(--color-ink)" : "var(--color-ink-faint)",
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {rackTab === "master" ? (
              <FxRack target="master" chain={masterChain} title="Master chain" />
            ) : active ? (
              <FxRack
                target={active.id}
                chain={active.effects}
                title={active.name}
              />
            ) : (
              <p className="px-4 py-8 text-center text-[11.5px] text-ink-faint">
                Select a track to build its effect chain.
              </p>
            )}
          </div>
        </aside>
      </div>

      {showProjects && (
        <ProjectsDialog
          tracks={tracks}
          masterChain={masterChain}
          masterDb={masterDb}
          onClose={() => setShowProjects(false)}
          onStatus={(msg) => set({ status: msg })}
        />
      )}

      {showKeys && <ShortcutsDialog onClose={() => setShowKeys(false)} />}

      {showExport && (
        <ExportDialog
          tracks={tracks}
          masterChain={masterChain}
          masterDb={masterDb}
          onClose={() => setShowExport(false)}
          onStatus={(msg) => set({ status: msg })}
        />
      )}

      {busy && !showExport && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-panel px-4 py-1.5 text-[12px] text-ink-dim">
          {busy}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TrackLane({
  track,
  peaks,
  isActive,
  scrollSec,
  spp,
  playhead,
  selection,
  onSelect,
  onScrub,
  engine,
}: {
  track: Track;
  peaks: import("@/lib/audio/peaks").PeakSet | undefined;
  isActive: boolean;
  scrollSec: number;
  spp: number;
  playhead: number;
  selection: { start: number; end: number } | null;
  onSelect: (r: { start: number; end: number } | null) => void;
  onScrub: (sec: number) => void;
  engine: Engine;
}) {
  return (
    <div
      className="flex border-b border-line-soft transition-colors"
      style={{ background: isActive ? "rgba(245,184,67,0.03)" : "transparent" }}
    >
      {/* Channel strip */}
      <div
        className="flex w-[188px] shrink-0 flex-col gap-1.5 border-r border-line px-2.5 py-2"
        style={{ height: LANE_H }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: track.color }}
          />
          <input
            value={track.name}
            onChange={(e) => patchTrack(track.id, { name: e.target.value })}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none"
          />
          <button
            onClick={() => removeTrack(track.id)}
            className="text-ink-faint transition-colors hover:text-alert"
            aria-label="Remove track"
          >
            <svg width="12" height="12" viewBox="0 0 16 16">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex gap-1">
          {(
            [
              ["M", "muted", track.muted, "var(--color-alert)"],
              ["S", "soloed", track.soloed, "var(--color-signal)"],
            ] as const
          ).map(([label, key, on, col]) => (
            <button
              key={key}
              onClick={() => patchTrack(track.id, { [key]: !on })}
              className="grid size-5 place-items-center rounded-[4px] border text-[9.5px] font-semibold transition-colors"
              style={{
                borderColor: on ? col : "var(--color-line)",
                background: on ? col : "transparent",
                color: on ? "#000" : "var(--color-ink-faint)",
              }}
            >
              {label}
            </button>
          ))}

          <input
            type="range"
            min={-40}
            max={12}
            step={0.5}
            value={track.gainDb}
            onChange={(e) => {
              const v = Number(e.target.value);
              patchTrack(track.id, { gainDb: v });
              engine.setTrackGain(track.id, v);
            }}
            className="ml-1 min-w-0 flex-1"
            aria-label={`${track.name} gain`}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[9.5px] uppercase tracking-wider text-ink-faint">Pan</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.02}
            value={track.pan}
            onChange={(e) => {
              const v = Number(e.target.value);
              patchTrack(track.id, { pan: v });
              engine.setTrackPan(track.id, v);
            }}
            className="min-w-0 flex-1"
            aria-label={`${track.name} pan`}
          />
          <span className="tnum w-8 text-right text-[9.5px] text-ink-faint">
            {track.pan === 0
              ? "C"
              : `${track.pan < 0 ? "L" : "R"}${Math.abs(Math.round(track.pan * 100))}`}
          </span>
        </div>
      </div>

      {/* Waveform */}
      <div className="min-w-0 flex-1">
        {peaks && (
          <Waveform
            peaks={peaks}
            color={track.color}
            height={LANE_H}
            scrollSec={scrollSec}
            spp={spp}
            playhead={playhead}
            offset={track.offset}
            selection={selection}
            onSelect={onSelect}
            onScrub={onScrub}
          />
        )}
      </div>
    </div>
  );
}
