"use client";

/**
 * Effect rack.
 *
 * Renders itself entirely from the parameter descriptions in effects.ts,
 * so no control here knows what a compressor is. Frequency and time
 * parameters get a logarithmic slider because linear frequency sliders
 * put every useful value in the last fifth of the travel.
 */

import { useState } from "react";
import {
  EFFECTS,
  EFFECT_BY_ID,
  defaultValues,
  type EffectInstance,
  type ParamSpec,
} from "@/lib/audio/effects";
import { addEffect, removeEffect, updateEffect } from "@/lib/store";

const FILTER_TYPES = ["Low Pass", "High Pass", "Band Pass"];

function format(p: ParamSpec, v: number) {
  if (p.key === "type") return FILTER_TYPES[Math.round(v)] ?? "—";
  const decimals = p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0;
  const shown = v >= 1000 && p.unit === "Hz" ? (v / 1000).toFixed(2) : v.toFixed(decimals);
  const unit = v >= 1000 && p.unit === "Hz" ? "kHz" : p.unit ?? "";
  return `${shown}${unit ? ` ${unit}` : ""}`;
}

// Log sliders operate on the exponent, then map back to the real value.
const toSlider = (p: ParamSpec, v: number) =>
  p.curve === "log"
    ? (Math.log(v / p.min) / Math.log(p.max / p.min)) * 1000
    : v;

const fromSlider = (p: ParamSpec, s: number) =>
  p.curve === "log" ? p.min * Math.pow(p.max / p.min, s / 1000) : s;

function ParamRow({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="group py-1.5">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[11px] text-ink-dim">{spec.label}</span>
        <span className="tnum text-[11px] text-ink tabular-nums">
          {format(spec, value)}
        </span>
      </div>
      <input
        type="range"
        className="w-full"
        min={spec.curve === "log" ? 0 : spec.min}
        max={spec.curve === "log" ? 1000 : spec.max}
        step={spec.curve === "log" ? 1 : spec.step}
        value={toSlider(spec, value)}
        onChange={(e) => onChange(fromSlider(spec, Number(e.target.value)))}
        aria-label={spec.label}
      />
    </div>
  );
}

function EffectCard({
  target,
  inst,
}: {
  target: "master" | string;
  inst: EffectInstance;
}) {
  const spec = EFFECT_BY_ID.get(inst.id);
  const [open, setOpen] = useState(true);
  if (!spec) return null;

  return (
    <div className="overflow-hidden rounded-[8px] border border-line bg-panel">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          onClick={() => updateEffect(target, inst.uid, { enabled: !inst.enabled })}
          className="size-2.5 shrink-0 rounded-full transition-colors"
          style={{
            background: inst.enabled ? "var(--color-live)" : "var(--color-line)",
          }}
          aria-label={inst.enabled ? "Bypass" : "Enable"}
          title={inst.enabled ? "Bypass" : "Enable"}
        />
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex-1 text-left text-[12px] font-medium text-ink"
        >
          {spec.name}
        </button>
        <button
          onClick={() => removeEffect(target, inst.uid)}
          className="text-ink-faint transition-colors hover:text-alert"
          aria-label={`Remove ${spec.name}`}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          className="border-t border-line-soft px-2.5 pb-2.5 pt-1"
          style={{ opacity: inst.enabled ? 1 : 0.4 }}
        >
          {spec.params.map((p) => (
            <ParamRow
              key={p.key}
              spec={p}
              value={inst.values[p.key] ?? p.def}
              onChange={(v) =>
                updateEffect(target, inst.uid, {
                  values: { ...inst.values, [p.key]: v },
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FxRack({
  target,
  chain,
  title,
}: {
  target: "master" | string;
  chain: EffectInstance[];
  title: string;
}) {
  const [picking, setPicking] = useState(false);

  const groups = Array.from(new Set(EFFECTS.map((e) => e.group)));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.13em] text-ink-faint">
          {title}
        </h2>
        <button
          onClick={() => setPicking((p) => !p)}
          className="rounded-[5px] border border-line px-2 py-0.5 text-[11px] text-ink-dim transition-colors hover:border-signal hover:text-signal"
        >
          {picking ? "Close" : "Add"}
        </button>
      </div>

      {picking && (
        <div className="mx-3 mb-2 max-h-72 overflow-y-auto rounded-[8px] border border-line bg-canvas p-1.5 anim-weave">
          {groups.map((g) => (
            <div key={g} className="mb-1.5 last:mb-0">
              <div className="px-1.5 py-1 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                {g}
              </div>
              {EFFECTS.filter((e) => e.group === g).map((e) => (
                <button
                  key={e.id}
                  onClick={() => {
                    addEffect(target, e.id, defaultValues(e.id));
                    setPicking(false);
                  }}
                  className="block w-full rounded-[5px] px-1.5 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <div className="text-[12px] text-ink">{e.name}</div>
                  <div className="text-[10.5px] leading-snug text-ink-faint">
                    {e.blurb}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {chain.length === 0 && !picking && (
          <p className="px-1 py-6 text-center text-[11.5px] leading-relaxed text-ink-faint">
            No effects yet.
            <br />
            Everything renders offline, on this machine.
          </p>
        )}
        {chain.map((inst) => (
          <EffectCard key={inst.uid} target={target} inst={inst} />
        ))}
      </div>
    </div>
  );
}
