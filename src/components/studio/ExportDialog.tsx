"use client";

/**
 * Export.
 *
 * The dialog renders the mix once for analysis before you commit, so the
 * numbers on screen describe the file you are actually about to save
 * rather than an estimate. Loudness is the useful figure here: streaming
 * platforms normalise to LUFS and will quietly turn a hot master down,
 * so knowing the integrated value before export is the difference between
 * delivering on purpose and delivering by accident.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { bounce, type Track } from "@/lib/audio/engine";
import type { EffectInstance } from "@/lib/audio/effects";
import { encodeWav, type BitDepth } from "@/lib/audio/wav";
import {
  canEncodeAac,
  encodeAac,
  FORMAT_INFO,
  type ExportFormat,
} from "@/lib/audio/encode";
import {
  LOUDNESS_TARGETS,
  measureLoudness,
  type LoudnessReport,
} from "@/lib/audio/loudness";

type Props = {
  tracks: Track[];
  masterChain: EffectInstance[];
  masterDb: number;
  onClose: () => void;
  onStatus: (msg: string) => void;
};

const RATES = [44100, 48000, 96000];
const BITRATES = [128000, 192000, 256000, 320000];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-[0.1em] text-ink-faint">
        {label}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { v: T; l: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-[6px] border border-line p-0.5">
      {options.map((o) => (
        <button
          key={String(o.v)}
          onClick={() => onChange(o.v)}
          className="flex-1 rounded-[4px] py-1 text-[11.5px] transition-colors"
          style={{
            background: value === o.v ? "var(--color-signal)" : "transparent",
            color: value === o.v ? "#000" : "var(--color-ink-dim)",
          }}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function ExportDialog({
  tracks,
  masterChain,
  masterDb,
  onClose,
  onStatus,
}: Props) {
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [depth, setDepth] = useState<BitDepth>(24);
  const [rate, setRate] = useState(48000);
  const [chans, setChans] = useState<1 | 2>(2);
  const [bitrate, setBitrate] = useState(192000);

  const [report, setReport] = useState<LoudnessReport | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  const aacAvailable = useRef(false);
  useEffect(() => {
    aacAvailable.current = canEncodeAac();
    if (!aacAvailable.current && format === "aac") setFormat("wav");
  }, [format]);

  /** Render once and measure. Deliberately manual — it is not cheap. */
  const analyse = useCallback(async () => {
    if (!tracks.length) return;
    setAnalysing(true);
    try {
      const mix = await bounce(tracks, masterChain, masterDb, rate);
      setReport(await measureLoudness(mix));
    } catch {
      onStatus("Analysis failed on this mix.");
    } finally {
      setAnalysing(false);
    }
  }, [tracks, masterChain, masterDb, rate, onStatus]);

  const run = async () => {
    if (!tracks.length) return;
    setWorking("Rendering the mix");
    try {
      const mix = await bounce(tracks, masterChain, masterDb, rate);

      let blob: Blob;
      if (format === "aac") {
        setWorking("Encoding AAC");
        blob = await encodeAac(mix, { bitrate, channels: chans });
      } else {
        setWorking("Writing WAV");
        blob = encodeWav(mix, { bitDepth: depth, channels: chans });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stemloom-mix-${Date.now()}.${FORMAT_INFO[format].ext}`;
      a.click();
      // Give the download a tick to start before the handle is dropped.
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      const mb = (blob.size / 1048576).toFixed(1);
      onStatus(`Exported ${FORMAT_INFO[format].label}, ${mb} MB.`);
      onClose();
    } catch (e) {
      onStatus(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setWorking(null);
    }
  };

  const lufs = report?.integrated ?? null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[12px] border border-line bg-panel p-5 anim-weave"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold">Export mixdown</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
          Rendered on this machine and saved straight to your downloads.
          Nothing is uploaded and nothing is stamped.
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Format">
            <Segmented
              options={[
                { v: "wav" as ExportFormat, l: "WAV" },
                { v: "aac" as ExportFormat, l: "AAC" },
              ]}
              value={format}
              onChange={(v) => {
                if (v === "aac" && !aacAvailable.current) {
                  onStatus("This browser has no AAC encoder. WAV still works.");
                  return;
                }
                setFormat(v);
              }}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              {FORMAT_INFO[format].note}
            </p>
          </Field>

          {format === "wav" ? (
            <Field label="Bit depth">
              <Segmented
                options={[
                  { v: 16 as BitDepth, l: "16-bit" },
                  { v: 24 as BitDepth, l: "24-bit" },
                  { v: 32 as BitDepth, l: "32-bit float" },
                ]}
                value={depth}
                onChange={setDepth}
              />
            </Field>
          ) : (
            <Field label="Bitrate">
              <Segmented
                options={BITRATES.map((b) => ({ v: b, l: `${b / 1000}k` }))}
                value={bitrate}
                onChange={setBitrate}
              />
            </Field>
          )}

          <Field label="Sample rate">
            <Segmented
              options={RATES.map((r) => ({
                v: r,
                l: r === 44100 ? "44.1k" : `${r / 1000}k`,
              }))}
              value={rate}
              onChange={(v) => {
                setRate(v);
                // The old measurement described a different render.
                setReport(null);
              }}
            />
          </Field>

          <Field label="Channels">
            <Segmented
              options={[
                { v: 1 as 1 | 2, l: "Mono" },
                { v: 2 as 1 | 2, l: "Stereo" },
              ]}
              value={chans}
              onChange={setChans}
            />
          </Field>
        </div>

        {/* ---- Loudness ---- */}
        <div className="mt-4 rounded-[8px] border border-line bg-canvas p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.1em] text-ink-faint">
              Loudness
            </span>
            <button
              onClick={analyse}
              disabled={analysing || !tracks.length}
              className="rounded-[5px] border border-line px-2 py-0.5 text-[11px] text-ink-dim transition-colors hover:border-signal hover:text-signal disabled:opacity-40"
            >
              {analysing ? "Measuring…" : report ? "Re-measure" : "Measure"}
            </button>
          </div>

          {!report && !analysing && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Renders the mix and measures it to ITU-R BS.1770 before you
              commit. Worth doing if this is going anywhere public.
            </p>
          )}

          {report && (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  ["Integrated", `${report.integrated.toFixed(1)}`, "LUFS"],
                  ["True peak", `${report.truePeakDb.toFixed(1)}`, "dBTP"],
                  ["Range", `${report.range.toFixed(1)}`, "LU"],
                ].map(([label, value, unit]) => (
                  <div key={label}>
                    <div className="text-[10px] text-ink-faint">{label}</div>
                    <div className="tnum text-[15px] text-ink">
                      {value}
                      <span className="ml-1 text-[9.5px] text-ink-faint">
                        {unit}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {report.truePeakDb > -0.1 && (
                <p className="mt-2.5 rounded-[5px] bg-alert/10 px-2 py-1.5 text-[11px] leading-relaxed text-alert">
                  Peaks are running into the ceiling. A limiter on the master
                  chain will stop this distorting once it is encoded.
                </p>
              )}

              <div className="mt-3 space-y-1 border-t border-line-soft pt-2.5">
                {LOUDNESS_TARGETS.map((t) => {
                  const delta = lufs === null ? 0 : t.lufs - lufs;
                  const close = Math.abs(delta) < 1;
                  return (
                    <div
                      key={t.name}
                      className="flex items-baseline justify-between gap-2 text-[11px]"
                    >
                      <span className="text-ink-faint">{t.name}</span>
                      <span
                        className="tnum"
                        style={{
                          color: close
                            ? "var(--color-live)"
                            : "var(--color-ink-dim)",
                        }}
                      >
                        {close
                          ? "on target"
                          : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} LU`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-[6px] border border-line py-2 text-[12.5px] text-ink-dim transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={run}
            disabled={!!working || !tracks.length}
            className="flex-1 rounded-[6px] bg-signal py-2 text-[12.5px] font-medium text-black transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {working ?? `Render ${FORMAT_INFO[format].label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
