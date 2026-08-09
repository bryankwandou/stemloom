"use client";

/**
 * The hero.
 *
 * Woven strands that deform around the pointer, and — when you press play —
 * are driven by the output of a real Web Audio graph rather than a canned
 * animation. The amplitude you see is the amplitude the analyser reports,
 * so the page is demonstrating the actual engine the editor runs on.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const STRANDS = 9;
const WARPS = 14;

type Voice = {
  ctx: AudioContext;
  analyser: AnalyserNode;
  stop: () => void;
};

function startVoice(preset: "clean" | "space" | "grit"): Voice {
  const ctx = new AudioContext();
  const now = ctx.currentTime;

  const master = ctx.createGain();
  master.gain.value = 0;
  master.gain.linearRampToValueAtTime(0.5, now + 0.15);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  master.connect(analyser);
  analyser.connect(ctx.destination);

  let tail: AudioNode = master;

  if (preset === "space") {
    // Synthesised room, same technique the editor's reverb uses.
    const conv = ctx.createConvolver();
    const len = ctx.sampleRate * 2.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp = lp * 0.62 + (Math.random() * 2 - 1) * 0.38;
        d[i] = lp * Math.pow(1 - t, 2.4);
      }
    }
    conv.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.75;
    conv.connect(wet).connect(analyser);
    master.connect(conv);
  }

  if (preset === "grit") {
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(4096);
    const k = 42;
    for (let i = 0; i < 4096; i++) {
      const x = (i * 2) / 4096 - 1;
      curve[i] = ((3 + k) * x * 0.35) / (Math.PI + k * Math.abs(x));
    }
    shaper.curve = curve;
    shaper.oversample = "4x";
    master.disconnect();
    master.connect(shaper);
    shaper.connect(analyser);
    tail = shaper;
  }

  // A suspended chord: enough harmonic content to make the analyser
  // interesting without sounding like a ringtone.
  const freqs = [110, 164.81, 220, 246.94, 329.63, 493.88];
  const oscs: OscillatorNode[] = [];

  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = i < 2 ? "triangle" : "sine";
    osc.frequency.value = f;
    // Slight detune per voice stops the chord phasing into a single tone.
    osc.detune.value = (i - 2.5) * 4;

    const g = ctx.createGain();
    g.gain.value = 0;
    const at = now + i * 0.07;
    g.gain.linearRampToValueAtTime(0.16 / (1 + i * 0.28), at + 0.25);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.18 + i * 0.05;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.045 / (1 + i * 0.3);
    lfo.connect(lfoAmt).connect(g.gain);
    lfo.start(at);

    osc.connect(g).connect(master);
    osc.start(at);
    oscs.push(osc, lfo);
  });

  return {
    ctx,
    analyser,
    stop: () => {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + 0.35);
      oscs.forEach((o) => {
        try {
          o.stop(t + 0.4);
        } catch {
          /* already stopped */
        }
      });
      setTimeout(() => void ctx.close(), 600);
      void tail;
    },
  };
}

export function LoomCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const voiceRef = useRef<Voice | null>(null);
  const pointer = useRef({ x: -999, y: -999, active: false });
  const [playing, setPlaying] = useState(false);
  const [preset, setPreset] = useState<"clean" | "space" | "grit">("space");

  const toggle = useCallback(() => {
    if (voiceRef.current) {
      voiceRef.current.stop();
      voiceRef.current = null;
      setPlaying(false);
    } else {
      voiceRef.current = startVoice(preset);
      setPlaying(true);
    }
  }, [preset]);

  // Switching preset while it is running restarts the graph so the change
  // is audible immediately.
  useEffect(() => {
    if (!voiceRef.current) return;
    voiceRef.current.stop();
    voiceRef.current = startVoice(preset);
  }, [preset]);

  useEffect(() => () => voiceRef.current?.stop(), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let raf = 0;
    let t = 0;
    const bins = new Uint8Array(1024);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const render = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) {
        raf = requestAnimationFrame(render);
        return;
      }
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }

      const g = canvas.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      t += reduce ? 0 : 0.0075;

      // Live spectrum when audio is running, a slow idle breath otherwise.
      let energy = 0.22;
      if (voiceRef.current) {
        voiceRef.current.analyser.getByteFrequencyData(
          bins as Uint8Array<ArrayBuffer>,
        );
        let sum = 0;
        for (let i = 0; i < 220; i++) sum += bins[i];
        energy = 0.22 + (sum / (220 * 255)) * 1.5;
      }

      const padX = w * 0.06;
      const usableW = w - padX * 2;
      const midY = h / 2;
      const spread = Math.min(h * 0.34, 150);

      // --- Warp: the vertical frame. Drawn first, sits behind. ---
      for (let i = 0; i < WARPS; i++) {
        const x = padX + (usableW * i) / (WARPS - 1);
        const sway = Math.sin(t * 0.7 + i * 0.5) * 5 * energy;
        g.beginPath();
        g.moveTo(x + sway, midY - spread * 1.25);
        g.lineTo(x - sway, midY + spread * 1.25);
        g.strokeStyle = "rgba(255,255,255,0.055)";
        g.lineWidth = 1;
        g.stroke();
      }

      // --- Weft: the audio strands. ---
      for (let s = 0; s < STRANDS; s++) {
        const p = s / (STRANDS - 1);
        const baseY = midY + (p - 0.5) * spread * 2;

        // Amplitude follows the spectrum band this strand represents.
        const band = Math.floor((s / STRANDS) * 200);
        const bandV = voiceRef.current ? bins[band] / 255 : 0.35;
        const amp = (10 + bandV * 42) * energy;

        g.beginPath();
        for (let x = padX; x <= w - padX; x += 3) {
          const nx = (x - padX) / usableW;

          // Two travelling waves at different rates keep the line from
          // looking like a single sine.
          let y =
            baseY +
            Math.sin(nx * 7 + t * 1.6 + s * 0.55) * amp * 0.5 +
            Math.sin(nx * 3.1 - t * 1.05 + s * 0.9) * amp * 0.32;

          // Pointer repulsion — the cloth pushes away from the cursor.
          if (pointer.current.active) {
            const dx = x - pointer.current.x;
            const dy = baseY - pointer.current.y;
            const dist = Math.hypot(dx, dy);
            const reach = 190;
            if (dist < reach) {
              const push = Math.pow(1 - dist / reach, 2.1) * 62;
              y += (dy / (dist || 1)) * push;
            }
          }

          if (x === padX) g.moveTo(x, y);
          else g.lineTo(x, y);
        }

        // Centre strands are brighter and thicker, which reads as an
        // amplitude envelope across the whole weave.
        const centreness = 1 - Math.abs(p - 0.5) * 2;
        const alpha = 0.14 + centreness * 0.62 + bandV * 0.22;
        const grad = g.createLinearGradient(padX, 0, w - padX, 0);
        grad.addColorStop(0, `rgba(245,184,67,${alpha * 0.15})`);
        grad.addColorStop(0.35, `rgba(245,184,67,${alpha})`);
        grad.addColorStop(0.72, `rgba(111,227,196,${alpha * 0.8})`);
        grad.addColorStop(1, `rgba(111,227,196,${alpha * 0.12})`);

        g.strokeStyle = grad;
        g.lineWidth = 1 + centreness * 1.9;
        g.lineCap = "round";
        g.stroke();
      }

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className="block h-[340px] w-full cursor-crosshair sm:h-[420px]"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          pointer.current = {
            x: e.clientX - r.left,
            y: e.clientY - r.top,
            active: true,
          };
        }}
        onPointerLeave={() => (pointer.current.active = false)}
        aria-hidden
      />

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <button
          onClick={toggle}
          className="group flex items-center gap-2.5 rounded-full bg-signal px-5 py-2.5 text-[13.5px] font-medium text-black transition-transform hover:scale-[1.03] active:scale-[0.98]"
        >
          <span className="grid size-4 place-items-center">
            {playing ? (
              <svg width="9" height="10" viewBox="0 0 9 10">
                <rect width="3" height="10" rx="1" fill="currentColor" />
                <rect x="6" width="3" height="10" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="10" height="11" viewBox="0 0 10 11">
                <path d="M1 1v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 1 1Z" fill="currentColor" />
              </svg>
            )}
          </span>
          {playing ? "Stop the demo" : "Hear the engine"}
        </button>

        <div className="flex gap-0.5 rounded-full border border-line p-0.5">
          {(
            [
              ["clean", "Dry"],
              ["space", "Reverb"],
              ["grit", "Saturation"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPreset(k)}
              className="rounded-full px-3 py-1.5 text-[12px] transition-colors"
              style={{
                background: preset === k ? "var(--color-raised)" : "transparent",
                color: preset === k ? "var(--color-ink)" : "var(--color-ink-faint)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-3 text-center text-[11.5px] text-ink-faint">
        {playing
          ? "The weave is following the analyser output in real time."
          : "Move your pointer across the weave. Press play to drive it with live audio."}
      </p>
    </div>
  );
}
