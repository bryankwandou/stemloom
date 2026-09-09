"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Mark, Wordmark } from "@/components/brand/Logo";
import { LoomCanvas } from "@/components/landing/LoomCanvas";
import { EFFECTS } from "@/lib/audio/effects";

/** Fades a block in the first time it comes near the viewport. */
function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "-60px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(18px)",
        transition: `opacity .7s var(--ease-out-quint) ${delay}s, transform .7s var(--ease-out-quint) ${delay}s`,
      }}
    >
      {children}
    </div>
  );
}

const PILLARS = [
  {
    title: "Your files stay on your disk",
    body: "Decoding, editing, and rendering all run inside the tab. There is no upload step because there is no server to upload to. Open the network panel while you work and watch it stay empty.",
  },
  {
    title: "Nothing is held back",
    body: "Every effect, every bit depth, every sample rate is available from the first minute. No trial countdown, no export cap, no stamp burned into the file you just spent an hour on.",
  },
  {
    title: "Written from the sample up",
    body: "The WAV encoder, the peak cache, the waveform renderer, and the effect graph are all in this repository. Nothing here is a wrapper around somebody else's paid product.",
  },
  {
    title: "Works with the network off",
    body: "Load it once and it stays installed. On a plane, on hotel wifi, or on a train through a tunnel, the editor behaves exactly the same as it does at your desk.",
  },
];

const COMPARISON = [
  ["Runs with no account", "Stemloom", true],
  ["Works fully offline", "Stemloom", true],
  ["Export without a watermark", "Stemloom", true],
  ["Every effect unlocked", "Stemloom", true],
  ["Files never leave the device", "Stemloom", true],
  ["Source is readable and forkable", "Stemloom", true],
] as const;

export default function Home() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const groups = Array.from(new Set(EFFECTS.map((e) => e.group)));

  return (
    <main className="grain min-h-dvh bg-void">
      {/* ---- Nav ---- */}
      <nav
        className="fixed inset-x-0 top-0 z-50 transition-colors duration-300"
        style={{
          background: scrolled ? "rgba(8,9,10,0.82)" : "transparent",
          backdropFilter: scrolled ? "blur(14px)" : "none",
          borderBottom: scrolled ? "1px solid var(--color-line-soft)" : "1px solid transparent",
        }}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <Wordmark size={24} animate />
          <div className="flex items-center gap-1.5">
            <a
              href="#effects"
              className="hidden rounded-[6px] px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:text-ink sm:block"
            >
              Effects
            </a>
            <a
              href="#offline"
              className="hidden rounded-[6px] px-3 py-1.5 text-[13px] text-ink-dim transition-colors hover:text-ink sm:block"
            >
              How it works
            </a>
            <Link
              href="/studio"
              className="rounded-[6px] bg-signal px-3.5 py-1.5 text-[13px] font-medium text-black transition-transform hover:scale-[1.03] active:scale-[0.98]"
            >
              Open the editor
            </Link>
          </div>
        </div>
      </nav>

      {/* ---- Hero ---- */}
      <section className="relative overflow-hidden px-5 pt-32 pb-16">
        {/* A single soft light source behind the weave. Cheap, and it stops
            the hero reading as a flat rectangle. */}
        <div
          className="pointer-events-none absolute left-1/2 top-24 -z-10 size-[620px] -translate-x-1/2 rounded-full opacity-[0.13] blur-[110px] anim-drift"
          style={{
            background:
              "radial-gradient(circle, var(--color-signal) 0%, transparent 68%)",
          }}
        />

        <div className="mx-auto max-w-4xl text-center">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-3 py-1 text-[11.5px] text-ink-dim">
              <span className="size-1.5 rounded-full bg-live" />
              Runs in the browser. Installs for offline use.
            </span>
          </Reveal>

          <Reveal delay={0.08}>
            <h1 className="display mt-6 text-[clamp(2.6rem,7.5vw,4.75rem)] font-semibold">
              Audio editing that
              <br />
              never leaves
              <span className="text-signal"> your machine</span>
            </h1>
          </Reveal>

          <Reveal delay={0.16}>
            <p className="mx-auto mt-6 max-w-xl text-[15.5px] leading-relaxed text-ink-dim">
              A multitrack editor with a full effect rack, sample-accurate
              editing, and uncompressed export. Drop a file in and it is
              decoded locally — no sign-up, no upload, and no watermark on the
              way out.
            </p>
          </Reveal>

          <Reveal delay={0.24}>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/studio"
                className="rounded-[8px] bg-signal px-5 py-2.5 text-[14px] font-medium text-black transition-transform hover:scale-[1.03] active:scale-[0.98]"
              >
                Start editing
              </Link>
              <a
                href="#offline"
                className="rounded-[8px] border border-line px-5 py-2.5 text-[14px] text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
              >
                See how it works
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.3} className="mx-auto mt-12 max-w-5xl">
          <LoomCanvas />
        </Reveal>
      </section>

      {/* ---- Pillars ---- */}
      <section className="border-t border-line-soft px-5 py-20">
        <div className="mx-auto max-w-5xl">
          <Reveal>
            <h2 className="display text-[clamp(1.9rem,4.4vw,2.7rem)] font-semibold">
              Four things we refused to compromise on
            </h2>
          </Reveal>

          <div className="mt-10 grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2">
            {PILLARS.map((p, i) => (
              <Reveal key={p.title} delay={i * 0.07}>
                <div className="h-full bg-canvas p-6 transition-colors hover:bg-panel">
                  <div className="mb-3 tnum text-[11px] text-signal">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <h3 className="text-[16px] font-medium">{p.title}</h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-ink-dim">
                    {p.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Effects ---- */}
      <section id="effects" className="border-t border-line-soft px-5 py-20">
        <div className="mx-auto max-w-5xl">
          <Reveal>
            <h2 className="display text-[clamp(1.9rem,4.4vw,2.7rem)] font-semibold">
              The rack, in full
            </h2>
            <p className="mt-3 max-w-xl text-[14.5px] leading-relaxed text-ink-dim">
              {EFFECTS.length} processors, each built on the Web Audio graph and
              rendered offline when you export. Reverb impulses are synthesised
              at render time, which is why the whole application installs in
              well under a megabyte.
            </p>
          </Reveal>

          <div className="mt-10 space-y-8">
            {groups.map((group, gi) => (
              <Reveal key={group} delay={gi * 0.05}>
                <div className="mb-3 flex items-center gap-3">
                  <h3 className="text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                    {group}
                  </h3>
                  <div className="h-px flex-1 bg-line-soft" />
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {EFFECTS.filter((e) => e.group === group).map((e) => (
                    <div
                      key={e.id}
                      className="group rounded-[9px] border border-line bg-canvas p-4 transition-all hover:-translate-y-0.5 hover:border-signal/40 hover:bg-panel"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <h4 className="text-[14px] font-medium">{e.name}</h4>
                        <span className="tnum text-[10.5px] text-ink-faint">
                          {e.params.length}p
                        </span>
                      </div>
                      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-faint">
                        {e.blurb}
                      </p>
                    </div>
                  ))}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Offline ---- */}
      <section id="offline" className="border-t border-line-soft px-5 py-20">
        <div className="mx-auto grid max-w-5xl gap-12 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <h2 className="display text-[clamp(1.9rem,4.4vw,2.7rem)] font-semibold">
              Where the audio actually goes
            </h2>
            <p className="mt-4 text-[14.5px] leading-relaxed text-ink-dim">
              Most browser editors are a thin client in front of a render farm.
              Your file is uploaded, processed on somebody else&apos;s hardware,
              and handed back — often with a stamp on it and a queue in front of
              it.
            </p>
            <p className="mt-3 text-[14.5px] leading-relaxed text-ink-dim">
              Stemloom does none of that. The browser decodes the file into
              memory, the effect graph is built and rendered by an
              OfflineAudioContext on your own CPU, and the WAV is written byte
              by byte in JavaScript before the download is triggered. The audio
              has nowhere else to be.
            </p>

            <div className="mt-6 space-y-2">
              {COMPARISON.map(([label], i) => (
                <div key={label} className="flex items-center gap-2.5" style={{ animationDelay: `${i * 60}ms` }}>
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-live/15">
                    <svg width="9" height="7" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4l2.6 2.6L9 1.2" stroke="var(--color-live)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="text-[13.5px] text-ink-dim">{label}</span>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="overflow-hidden rounded-[12px] border border-line bg-canvas">
              <div className="flex items-center gap-1.5 border-b border-line px-3.5 py-2.5">
                <span className="size-2.5 rounded-full bg-[#3a3e47]" />
                <span className="size-2.5 rounded-full bg-[#3a3e47]" />
                <span className="size-2.5 rounded-full bg-[#3a3e47]" />
                <span className="ml-2 text-[11px] text-ink-faint">
                  Network — while exporting a four minute mix
                </span>
              </div>
              <div className="p-5">
                <div className="tnum space-y-2 text-[11.5px]">
                  {[
                    ["Requests sent", "0"],
                    ["Bytes uploaded", "0"],
                    ["Third-party origins", "0"],
                    ["Files rendered locally", "1"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-line-soft pb-2">
                      <span className="text-ink-faint">{k}</span>
                      <span className={v === "0" ? "text-live" : "text-signal"}>{v}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
                  Open DevTools and check it yourself. That is the only proof
                  worth offering.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---- Roadmap ---- */}
      <section className="border-t border-line-soft px-5 py-20">
        <div className="mx-auto max-w-5xl">
          <Reveal>
            <h2 className="display text-[clamp(1.9rem,4.4vw,2.7rem)] font-semibold">
              What is here, and what is not
            </h2>
            <p className="mt-3 max-w-xl text-[14.5px] leading-relaxed text-ink-dim">
              An honest list is more useful than a marketing one.
            </p>
          </Reveal>

          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            <Reveal>
              <div className="rounded-[12px] border border-line bg-canvas p-6">
                <h3 className="mb-4 text-[11px] uppercase tracking-[0.16em] text-live">
                  Working today
                </h3>
                <ul className="space-y-2.5 text-[13.5px] text-ink-dim">
                  {[
                    "Multitrack timeline with per-track gain, pan, mute, and solo",
                    "Sample-accurate selection with zero-crossing snapping",
                    "Cut, copy, paste, crop, silence, and repeat",
                    "Four fade curves including smoothstep",
                    "Peak normalisation, phase invert, DC offset repair",
                    "Silence trimming with attack padding",
                    `${EFFECTS.length} effects with live parameter control`,
                    "Time stretch and pitch shift that hold each other still",
                    "Microphone recording with arm, monitor, and roll",
                    "WAV export at 16, 24, or 32-bit float, plus AAC",
                    "44.1k, 48k, and 96k sample rates",
                    "Loudness measured to BS.1770 with true peak",
                    "Projects saved locally and reopened intact",
                    "Real-time level metering and log-scaled spectrum",
                    "Undo history sixty steps deep",
                  ].map((f) => (
                    <li key={f} className="flex gap-2.5">
                      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-live" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>

            <Reveal delay={0.08}>
              <div className="rounded-[12px] border border-line bg-canvas p-6">
                <h3 className="mb-4 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                  Not built yet
                </h3>
                <ul className="space-y-2.5 text-[13.5px] text-ink-faint">
                  {[
                    "MP3 and Ogg encoding on export",
                    "Spectral repair for clicks and hum",
                    "A spectrogram view over the waveform lanes",
                    "Automation lanes drawn over the timeline",
                    "MIDI, instruments, and anything that generates notes",
                    "An Android build",
                  ].map((f) => (
                    <li key={f} className="flex gap-2.5">
                      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-line" />
                      {f}
                    </li>
                  ))}
                </ul>
                <p className="mt-5 text-[12.5px] leading-relaxed text-ink-faint">
                  These are listed because they are missing, not because they
                  are coming next week.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---- CTA ---- */}
      <section className="border-t border-line-soft px-5 py-24">
        <Reveal className="mx-auto max-w-2xl text-center">
          <Mark size={40} animate className="mx-auto" />
          <h2 className="display mt-6 text-[clamp(2rem,5vw,3rem)] font-semibold">
            Open it and drop a file in
          </h2>
          <p className="mx-auto mt-4 max-w-md text-[14.5px] leading-relaxed text-ink-dim">
            There is no account to make and nothing to install first. The editor
            is one click away and it will still be there when your connection is
            not.
          </p>
          <Link
            href="/studio"
            className="mt-8 inline-block rounded-[8px] bg-signal px-6 py-3 text-[14.5px] font-medium text-black transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            Open the editor
          </Link>
        </Reveal>
      </section>

      {/* ---- Footer ---- */}
      <footer className="border-t border-line-soft px-5 py-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 sm:flex-row">
          <Wordmark size={20} />
          <p className="text-center text-[12px] text-ink-faint sm:text-right">
            Built with the Web Audio API. Not affiliated with, and not a copy
            of, any commercial audio suite.
          </p>
        </div>
      </footer>
    </main>
  );
}
