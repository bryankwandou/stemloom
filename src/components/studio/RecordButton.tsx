"use client";

/**
 * Arm, monitor, record.
 *
 * Deliberately a two-step control. Hitting record and only then noticing
 * the input is clipping wastes a take, so arming opens the stream and
 * shows a live meter first, and the actual capture is a second press.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Recorder } from "@/lib/audio/recorder";
import type { Engine } from "@/lib/audio/engine";
import { addTrack } from "@/lib/store";

export function RecordButton({
  engine,
  onStatus,
}: {
  engine: Engine;
  onStatus: (msg: string) => void;
}) {
  const recRef = useRef<Recorder | null>(null);
  const [phase, setPhase] = useState<"off" | "armed" | "rolling">("off");
  const [elapsed, setElapsed] = useState(0);
  const [clean, setClean] = useState(false);
  const meterRef = useRef<HTMLCanvasElement>(null);

  const teardown = useCallback(() => {
    recRef.current?.dispose();
    recRef.current = null;
    setPhase("off");
    setElapsed(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const arm = async () => {
    try {
      await engine.resume();
      const rec = new Recorder(engine.context());
      await rec.arm({ cleanup: clean });
      recRef.current = rec;
      setPhase("armed");
      onStatus("Input open. Check the level, then press record.");
    } catch (e) {
      const msg =
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access was declined."
          : "No input device could be opened.";
      onStatus(msg);
      teardown();
    }
  };

  const roll = () => {
    recRef.current?.start();
    setPhase("rolling");
    onStatus("Recording.");
  };

  const finish = () => {
    const rec = recRef.current;
    if (!rec) return;
    const take = rec.stop();
    if (take && take.duration > 0.05) {
      addTrack(`Take ${new Date().toLocaleTimeString()}`, take);
      onStatus(`Captured ${take.duration.toFixed(1)} seconds.`);
    } else {
      onStatus("Nothing was captured.");
    }
    teardown();
  };

  // Live meter and elapsed clock while the stream is open.
  useEffect(() => {
    if (phase === "off") return;
    let raf = 0;
    let hold = 0;

    const tick = () => {
      const rec = recRef.current;
      const c = meterRef.current;

      if (rec && c) {
        if (phase === "rolling") setElapsed(rec.duration);

        const dpr = window.devicePixelRatio || 1;
        const w = 54;
        const h = 8;
        if (c.width !== w * dpr) {
          c.width = w * dpr;
          c.height = h * dpr;
          c.style.width = `${w}px`;
          c.style.height = `${h}px`;
        }
        const g = c.getContext("2d")!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);

        const { peak } = rec.level();
        hold = Math.max(peak, hold - 0.01);

        const db = hold > 0 ? 20 * Math.log10(hold) : -60;
        const frac = Math.max(0, Math.min(1, (db + 60) / 60));

        g.fillStyle = "rgba(255,255,255,0.07)";
        g.fillRect(0, 0, w, h);
        g.fillStyle =
          db > -1 ? "#f2603c" : db > -6 ? "#f5b843" : "#6fe3c4";
        g.fillRect(0, 0, frac * w, h);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  if (phase === "off") {
    return (
      <button
        onClick={arm}
        title="Open an input and arm for recording"
        className="flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11.5px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
      >
        <span className="size-2 rounded-full border border-current" />
        Record
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-[6px] border border-line bg-panel px-2 py-1">
      <canvas ref={meterRef} aria-label="Input level" />

      {phase === "armed" ? (
        <>
          <button
            onClick={roll}
            className="flex items-center gap-1.5 text-[11.5px] font-medium text-alert transition-opacity hover:opacity-80"
          >
            <span className="size-2 rounded-full bg-alert" />
            Roll
          </button>
          <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-ink-faint">
            <input
              type="checkbox"
              checked={clean}
              onChange={(e) => {
                setClean(e.target.checked);
                // The constraint is applied when the stream opens, so the
                // change only takes effect on the next arm.
                onStatus("Reopen the input to apply that.");
              }}
              className="size-3 accent-[var(--color-signal)]"
            />
            Clean up
          </label>
        </>
      ) : (
        <button
          onClick={finish}
          className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink"
        >
          <span
            className="size-2 rounded-[1px] bg-alert"
            style={{ animation: "pulse-soft 1.1s ease-in-out infinite" }}
          />
          <span className="tnum">{elapsed.toFixed(1)}s</span>
          <span className="text-ink-dim">Stop</span>
        </button>
      )}

      <button
        onClick={teardown}
        className="text-ink-faint transition-colors hover:text-ink"
        aria-label="Close input"
      >
        <svg width="11" height="11" viewBox="0 0 16 16">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
