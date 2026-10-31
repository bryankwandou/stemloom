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
import {
  emptyAutomation,
  schedule,
  type Automation,
} from "./automation";

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
  /** Envelopes drawn over the track, in track-local seconds. */
  automation: Automation;
  color: string;
};

export type MeterReading = {
  peak: number;
  rms: number;
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

type TrackNodes = {
  source: AudioBufferSourceNode;
  /** Carries the gain envelope, so the fader can move on top of it. */
  env: GainNode;
  gain: GainNode;
  panner: StereoPannerNode;
  analyser: AnalyserNode;
  /** Context time at which this track's own clock read zero. */
  origin: number;
  /** A drawn pan line owns the knob; turning it would fight the ramps. */
  panAuto: boolean;
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
  /** LFOs started inside live effects, which have to be stopped by hand. */
  private liveSources: AudioScheduledSourceNode[] = [];
  /**
   * Tracks whose chain changes their length are rendered before playing,
   * exactly as export renders them. Keyed on the buffer and the chain, so
   * pressing play twice with nothing changed costs nothing the second time.
   */
  private rendered = new WeakMap<AudioBuffer, { key: string; out: AudioBuffer }>();

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

  async play(
    tracks: Track[],
    from: number,
    masterDb = 0,
    masterChain: EffectInstance[] = [],
  ) {
    await this.resume();
    this.stop(false);

    // Everything slow happens before the clock is read. Rendering a
    // stretched track can take a moment, and any await between reading
    // currentTime and starting sources would put the tracks out of step.
    const fx = await import("./effects");
    const needsRender = (t: Track) =>
      t.effects.some((e) => e.enabled && fx.OFFLINE_ONLY.has(e.id));
    const buffers = new Map<string, AudioBuffer>();
    for (const t of tracks) {
      if (!needsRender(t)) continue;
      const key = JSON.stringify(t.effects);
      const hit = this.rendered.get(t.buffer);
      if (hit && hit.key === key) {
        buffers.set(t.id, hit.out);
      } else {
        const out = await fx.renderChain(t.buffer, t.effects);
        this.rendered.set(t.buffer, { key, out });
        buffers.set(t.id, out);
      }
    }

    const ctx = this.context();
    const anySolo = tracks.some((t) => t.soloed);

    /** Run a chain live, returning its output, or the input if it is empty. */
    const chain = (input: AudioNode, effects: EffectInstance[]) => {
      let node = input;
      for (const inst of effects) {
        if (!inst.enabled || fx.OFFLINE_ONLY.has(inst.id)) continue;
        const built = fx.buildEffect(ctx, inst, this.liveSources);
        if (!built) continue;
        node.connect(built.input);
        node = built.output;
      }
      return node;
    };

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = dbToGain(masterDb);
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    // Master effects sit after the master fader, where export puts them.
    // Length-changing effects cannot run on a live stream and are left to
    // export; on the master bus they are rare enough not to pre-render.
    chain(this.masterGain, masterChain).connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);

    for (const t of tracks) {
      // Solo is exclusive: if anything is soloed, everything else is out.
      const audible = anySolo ? t.soloed && !t.muted : !t.muted;

      const played = buffers.get(t.id) ?? t.buffer;
      const source = ctx.createBufferSource();
      source.buffer = played;

      const auto = t.automation ?? emptyAutomation();
      const local = from - t.offset;
      // Context time at which this track's own clock reads zero. It sits in
      // the past for a track already playing, which is correct: the
      // envelope is anchored to the track, not to when playback started.
      const origin = ctx.currentTime - local;

      const env = ctx.createGain();
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();

      // The gain envelope is relative to the fader, in decibels. Keeping it
      // on its own node means a fader move during playback cannot cancel
      // ramps the envelope already scheduled on the same parameter.
      schedule(env.gain, auto.gain, origin, local, ctx.currentTime, 0, dbToGain);
      gain.gain.value = audible ? dbToGain(t.gainDb) : 0;
      schedule(panner.pan, auto.pan, origin, local, ctx.currentTime, t.pan);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;

      // Effects first, then the envelope and fader, the order export uses.
      // A pre-rendered track already carries its whole chain.
      chain(source, played === t.buffer ? t.effects : [])
        .connect(env)
        .connect(gain)
        .connect(panner)
        .connect(analyser);
      analyser.connect(this.masterGain);

      // A track whose start lies ahead of the playhead is scheduled into
      // the future; one that starts behind it is played from part-way in.
      if (local >= played.duration) {
        // Entirely in the past. Nothing to hear.
      } else if (local >= 0) {
        source.start(ctx.currentTime, local);
      } else {
        source.start(ctx.currentTime - local);
      }

      this.nodes.set(t.id, { source, env, gain, panner, analyser, origin, panAuto: auto.pan.length > 0 });
    }

    this.startOffset = from;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  stop(resetPosition = true) {
    for (const s of this.liveSources) {
      try {
        s.stop();
      } catch {
        // Never started or already stopped.
      }
      s.disconnect();
    }
    this.liveSources = [];
    this.masterGain?.disconnect();
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
    if (!n || !this.ctx || n.panAuto) return;
    n.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.01);
  }

  /**
   * Re-plan one track's envelopes mid-playback, after a point is added or
   * dragged. Only the parameters are rescheduled; the source keeps
   * playing, so editing a line while listening does not restart the take.
   */
  setAutomation(id: string, auto: Automation, pan: number) {
    const n = this.nodes.get(id);
    if (!n || !this.ctx) return;
    const now = this.ctx.currentTime;
    const local = now - n.origin;
    schedule(n.env.gain, auto.gain, n.origin, local, now, 0, dbToGain);
    schedule(n.panner.pan, auto.pan, n.origin, local, now, pan);
    n.panAuto = auto.pan.length > 0;
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
    const e = ctx.createGain();
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();

    // The same envelopes the transport plays, on the same helper. Export
    // and monitoring diverging is the classic way an editor loses a
    // listener's trust, and the only defence is one code path.
    const auto = track.automation ?? emptyAutomation();
    schedule(e.gain, auto.gain, track.offset, 0, 0, 0, dbToGain);
    g.gain.value = dbToGain(track.gainDb);
    schedule(p.pan, auto.pan, track.offset, 0, 0, track.pan);

    src.connect(e).connect(g).connect(p).connect(master);
    src.start(track.offset);
  }

  master.connect(ctx.destination);
  const mixed = await ctx.startRendering();

  return masterChain.filter((e) => e.enabled).length
    ? renderChain(mixed, masterChain)
    : mixed;
}
