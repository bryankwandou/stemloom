/**
 * Transport and live playback.
 *
 * The scheduling model is deliberately simple: when the user hits play we
 * build the entire graph, start every source at a precisely computed
 * offset, and let the audio clock run. Position is then derived from
 * `ctx.currentTime` rather than tracked by a timer, because a timer will
 * drift against the audio hardware and a derived value cannot.
 */

import type { EffectInstance } from "./effects";

export type Track = {
  id: string;
  name: string;
  buffer: AudioBuffer;
  /** Where this track starts on the timeline, in seconds. */
  offset: number;
  gainDb: number;
  /** -1 hard left, 0 centre, 1 hard right. */
  pan: number;
  muted: boolean;
  soloed: boolean;
  effects: EffectInstance[];
  color: string;
};

export type MeterReading = {
  peak: number;
  rms: number;
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

type TrackNodes = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
};

export class Engine {
  private ctx: AudioContext | null = null;
  private nodes = new Map<string, TrackNodes>();
  private masterGain: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;

  private startedAt = 0;
  private startOffset = 0;
  private playing = false;
  private meterBuf = new Float32Array(2048);

  /** Created lazily: browsers refuse to start a context without a gesture. */
  context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    return this.ctx;
  }

  get isPlaying() {
    return this.playing;
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** Current playhead position in seconds. */
  position(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startedAt);
  }

  async resume() {
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
  }

  async play(tracks: Track[], from: number, masterDb = 0) {
    await this.resume();
    this.stop(false);

    const ctx = this.context();
    const anySolo = tracks.some((t) => t.soloed);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = dbToGain(masterDb);
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);

    for (const t of tracks) {
      // Solo is exclusive: if anything is soloed, everything else is out.
      const audible = anySolo ? t.soloed && !t.muted : !t.muted;

      const source = ctx.createBufferSource();
      source.buffer = t.buffer;

      const gain = ctx.createGain();
      gain.gain.value = audible ? dbToGain(t.gainDb) : 0;

      const panner = ctx.createStereoPanner();
      panner.pan.value = t.pan;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;

      source.connect(gain).connect(panner).connect(analyser);
      analyser.connect(this.masterGain);

      // A track whose start lies ahead of the playhead is scheduled into
      // the future; one that starts behind it is played from part-way in.
      const local = from - t.offset;
      if (local >= t.buffer.duration) {
        // Entirely in the past. Nothing to hear.
      } else if (local >= 0) {
        source.start(ctx.currentTime, local);
      } else {
        source.start(ctx.currentTime - local);
      }

      this.nodes.set(t.id, { source, gain, panner, analyser });
    }

    this.startOffset = from;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  stop(resetPosition = true) {
    for (const n of this.nodes.values()) {
      try {
        n.source.stop();
      } catch {
        // Already stopped; the spec throws rather than no-oping.
      }
      n.source.disconnect();
    }
    this.nodes.clear();

    if (this.playing && !resetPosition) {
      this.startOffset = this.position();
    }
    if (resetPosition) this.startOffset = 0;
    this.playing = false;
  }

  pause() {
    const at = this.position();
    this.stop(false);
    this.startOffset = at;
  }

  seek(to: number) {
    this.startOffset = Math.max(0, to);
    if (this.ctx) this.startedAt = this.ctx.currentTime;
  }

  setTrackGain(id: string, db: number) {
    const n = this.nodes.get(id);
    if (!n || !this.ctx) return;
    // Ramp rather than jump: an instant gain change is a click.
    n.gain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  setTrackPan(id: string, pan: number) {
    const n = this.nodes.get(id);
    if (!n || !this.ctx) return;
    n.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.01);
  }

  setMasterGain(db: number) {
    if (!this.masterGain || !this.ctx) return;
    this.masterGain.gain.setTargetAtTime(
      dbToGain(db),
      this.ctx.currentTime,
      0.01,
    );
  }

  /** Peak and RMS for one track, for the channel strip meters. */
  trackMeter(id: string): MeterReading {
    const n = this.nodes.get(id);
    if (!n) return { peak: 0, rms: 0 };
    return readMeter(n.analyser, this.meterBuf);
  }

  masterMeter(): MeterReading {
    if (!this.masterAnalyser) return { peak: 0, rms: 0 };
    return readMeter(this.masterAnalyser, this.meterBuf);
  }

  /** Frequency magnitudes in dB, for the spectrum display. */
  spectrum(out: Uint8Array): boolean {
    if (!this.masterAnalyser) return false;
    this.masterAnalyser.getByteFrequencyData(
      out as Uint8Array<ArrayBuffer>,
    );
    return true;
  }

  dispose() {
    this.stop();
    this.ctx?.close();
    this.ctx = null;
  }
}

function readMeter(analyser: AnalyserNode, buf: Float32Array): MeterReading {
  analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sumSq += buf[i] * buf[i];
  }
  return { peak, rms: Math.sqrt(sumSq / buf.length) };
}

/**
 * Flatten a project down to a single buffer, applying every track's
 * effects, gain, pan, and offset. This is what export actually renders.
 */
export async function bounce(
  tracks: Track[],
  masterChain: EffectInstance[],
  masterDb: number,
  sampleRate: number,
): Promise<AudioBuffer> {
  const { renderChain } = await import("./effects");

  const audible = tracks.some((t) => t.soloed)
    ? tracks.filter((t) => t.soloed && !t.muted)
    : tracks.filter((t) => !t.muted);

  if (audible.length === 0) {
    return new OfflineAudioContext(2, sampleRate, sampleRate).createBuffer(
      2,
      sampleRate,
      sampleRate,
    );
  }

  // Per-track effects are rendered first so each chain gets its own clean
  // context; mixing them afterwards is then a simple sum.
  const processed = await Promise.all(
    audible.map(async (t) => ({
      track: t,
      buffer: await renderChain(t.buffer, t.effects),
    })),
  );

  const totalSec = Math.max(
    ...processed.map((p) => p.track.offset + p.buffer.duration),
  );
  const length = Math.ceil(totalSec * sampleRate);

  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const master = ctx.createGain();
  master.gain.value = dbToGain(masterDb);

  for (const { track, buffer } of processed) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = dbToGain(track.gainDb);
    const p = ctx.createStereoPanner();
    p.pan.value = track.pan;
    src.connect(g).connect(p).connect(master);
    src.start(track.offset);
  }

  master.connect(ctx.destination);
  const mixed = await ctx.startRendering();

  return masterChain.filter((e) => e.enabled).length
    ? renderChain(mixed, masterChain)
    : mixed;
}
