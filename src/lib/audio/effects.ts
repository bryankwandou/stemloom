/**
 * The effect rack.
 *
 * Every effect is described as data — id, parameters, ranges, units — and
 * builds its own node graph inside an OfflineAudioContext. Describing them
 * this way means the UI never hard-codes a single control: the inspector
 * reads the parameter list and renders whatever is there. Adding an effect
 * is one entry in this file and nothing else.
 *
 * Reverb impulse responses are synthesised at render time rather than
 * shipped as audio files. That keeps the whole app installable offline in
 * a few hundred kilobytes instead of tens of megabytes.
 */

export type ParamSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
  /** Sliders for frequency and time feel wrong when linear. */
  curve?: "linear" | "log";
};

export type EffectSpec = {
  id: string;
  name: string;
  group: "Dynamics" | "EQ & Filter" | "Time" | "Modulation" | "Character" | "Space";
  blurb: string;
  params: ParamSpec[];
};

export type EffectInstance = {
  uid: string;
  id: string;
  enabled: boolean;
  values: Record<string, number>;
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

/* ------------------------------------------------------------------ */
/* Impulse response synthesis                                          */
/* ------------------------------------------------------------------ */

/**
 * Build a decaying noise burst shaped like a room.
 *
 * Real rooms lose high frequencies faster than low ones, so the noise is
 * lowpassed progressively as the tail decays. Without that the result
 * sounds like a metal box rather than a space.
 */
function makeImpulse(
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  damping: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const ir = ctx.createBuffer(2, len, rate);

  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    // One-pole state for the running lowpass.
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      const noise = Math.random() * 2 - 1;
      // Coefficient drifts toward 1 (more damping) as the tail decays.
      const a = Math.min(0.995, damping + (1 - damping) * t);
      lp = lp * a + noise * (1 - a);
      d[i] = lp * env;
    }
  }

  // Early reflections: a few discrete taps give the tail a sense of size
  // that pure exponential noise never has.
  const taps = [0.011, 0.019, 0.031, 0.047, 0.063];
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    taps.forEach((tap, k) => {
      const idx = Math.floor(tap * rate * (1 + c * 0.08));
      if (idx < len) d[idx] += (0.5 - k * 0.08) * (Math.random() * 0.4 + 0.8);
    });
  }
  return ir;
}

/** Waveshaper transfer curve. `amount` 0..1 maps to gentle..savage. */
function makeDistortionCurve(
  amount: number,
  samples = 8192,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const k = amount * 100;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    // Classic arctan-style soft clip: smooth through zero, hard at the rails.
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/** Quantise the transfer curve to N bits for a bitcrush effect. */
function makeCrushCurve(
  bits: number,
  samples = 8192,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const levels = Math.pow(2, Math.max(1, bits));
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const EFFECTS: EffectSpec[] = [
  {
    id: "eq3",
    name: "Three-Band EQ",
    group: "EQ & Filter",
    blurb: "Shelving lows and highs with a sweepable midrange bell.",
    params: [
      { key: "low", label: "Low", min: -24, max: 24, step: 0.5, def: 0, unit: "dB" },
      { key: "lowFreq", label: "Low Freq", min: 40, max: 500, step: 1, def: 180, unit: "Hz", curve: "log" },
      { key: "mid", label: "Mid", min: -24, max: 24, step: 0.5, def: 0, unit: "dB" },
      { key: "midFreq", label: "Mid Freq", min: 200, max: 8000, step: 10, def: 1200, unit: "Hz", curve: "log" },
      { key: "midQ", label: "Mid Q", min: 0.2, max: 8, step: 0.1, def: 1, unit: "" },
      { key: "high", label: "High", min: -24, max: 24, step: 0.5, def: 0, unit: "dB" },
      { key: "highFreq", label: "High Freq", min: 2000, max: 16000, step: 50, def: 6000, unit: "Hz", curve: "log" },
    ],
  },
  {
    id: "filter",
    name: "Filter",
    group: "EQ & Filter",
    blurb: "Resonant low, high, and band pass with a steep option.",
    params: [
      { key: "type", label: "Type", min: 0, max: 2, step: 1, def: 0, unit: "" },
      { key: "freq", label: "Cutoff", min: 20, max: 20000, step: 1, def: 1000, unit: "Hz", curve: "log" },
      { key: "q", label: "Resonance", min: 0.1, max: 20, step: 0.1, def: 1, unit: "" },
      { key: "poles", label: "Slope", min: 1, max: 4, step: 1, def: 1, unit: "x12dB" },
    ],
  },
  {
    id: "compressor",
    name: "Compressor",
    group: "Dynamics",
    blurb: "Level control with makeup gain. Pull the threshold down until it moves.",
    params: [
      { key: "threshold", label: "Threshold", min: -60, max: 0, step: 0.5, def: -18, unit: "dB" },
      { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1, def: 4, unit: ":1" },
      { key: "attack", label: "Attack", min: 0, max: 200, step: 1, def: 8, unit: "ms" },
      { key: "release", label: "Release", min: 10, max: 1000, step: 5, def: 180, unit: "ms" },
      { key: "knee", label: "Knee", min: 0, max: 40, step: 1, def: 8, unit: "dB" },
      { key: "makeup", label: "Makeup", min: 0, max: 24, step: 0.5, def: 0, unit: "dB" },
    ],
  },
  {
    id: "limiter",
    name: "Limiter",
    group: "Dynamics",
    blurb: "A brick wall for the final stage. Set the ceiling and forget it.",
    params: [
      { key: "ceiling", label: "Ceiling", min: -12, max: 0, step: 0.1, def: -0.3, unit: "dB" },
      { key: "drive", label: "Drive", min: 0, max: 18, step: 0.5, def: 3, unit: "dB" },
      { key: "release", label: "Release", min: 10, max: 500, step: 5, def: 60, unit: "ms" },
    ],
  },
  {
    id: "gate",
    name: "Noise Gate",
    group: "Dynamics",
    blurb: "Shuts the door between phrases. Good on close-miked speech.",
    params: [
      { key: "threshold", label: "Threshold", min: -80, max: 0, step: 1, def: -45, unit: "dB" },
      { key: "attack", label: "Attack", min: 0, max: 100, step: 1, def: 2, unit: "ms" },
      { key: "hold", label: "Hold", min: 0, max: 500, step: 5, def: 60, unit: "ms" },
      { key: "release", label: "Release", min: 5, max: 1000, step: 5, def: 150, unit: "ms" },
    ],
  },
  {
    id: "reverb",
    name: "Reverb",
    group: "Space",
    blurb: "Synthesised room. Size sets the tail, damping sets how dark it gets.",
    params: [
      { key: "size", label: "Size", min: 0.1, max: 8, step: 0.1, def: 2.2, unit: "s" },
      { key: "decay", label: "Decay", min: 0.5, max: 8, step: 0.1, def: 2.4, unit: "" },
      { key: "damping", label: "Damping", min: 0, max: 0.95, step: 0.01, def: 0.35, unit: "" },
      { key: "predelay", label: "Pre-delay", min: 0, max: 200, step: 1, def: 20, unit: "ms" },
      { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 28, unit: "%" },
    ],
  },
  {
    id: "delay",
    name: "Delay",
    group: "Time",
    blurb: "Feedback echo with a damped repeat path so tails darken naturally.",
    params: [
      { key: "time", label: "Time", min: 1, max: 2000, step: 1, def: 320, unit: "ms", curve: "log" },
      { key: "feedback", label: "Feedback", min: 0, max: 95, step: 1, def: 38, unit: "%" },
      { key: "tone", label: "Tone", min: 200, max: 16000, step: 100, def: 4200, unit: "Hz", curve: "log" },
      { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 30, unit: "%" },
    ],
  },
  {
    id: "chorus",
    name: "Chorus",
    group: "Modulation",
    blurb: "Detuned doubling. Small depths thicken, large depths seasick.",
    params: [
      { key: "rate", label: "Rate", min: 0.05, max: 8, step: 0.05, def: 0.8, unit: "Hz" },
      { key: "depth", label: "Depth", min: 0, max: 12, step: 0.1, def: 3.2, unit: "ms" },
      { key: "delay", label: "Offset", min: 1, max: 40, step: 0.5, def: 14, unit: "ms" },
      { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 45, unit: "%" },
    ],
  },
  {
    id: "flanger",
    name: "Flanger",
    group: "Modulation",
    blurb: "Short modulated delay fed back on itself. The jet-plane sweep.",
    params: [
      { key: "rate", label: "Rate", min: 0.05, max: 5, step: 0.05, def: 0.3, unit: "Hz" },
      { key: "depth", label: "Depth", min: 0, max: 5, step: 0.05, def: 2, unit: "ms" },
      { key: "feedback", label: "Feedback", min: 0, max: 90, step: 1, def: 55, unit: "%" },
      { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 50, unit: "%" },
    ],
  },
  {
    id: "tremolo",
    name: "Tremolo",
    group: "Modulation",
    blurb: "Rhythmic level swell. Depth at 100 fully closes between cycles.",
    params: [
      { key: "rate", label: "Rate", min: 0.1, max: 20, step: 0.1, def: 5, unit: "Hz" },
      { key: "depth", label: "Depth", min: 0, max: 100, step: 1, def: 60, unit: "%" },
    ],
  },
  {
    id: "distortion",
    name: "Saturation",
    group: "Character",
    blurb: "Soft clipping through a shaped transfer curve, with tone control.",
    params: [
      { key: "drive", label: "Drive", min: 0, max: 100, step: 1, def: 25, unit: "%" },
      { key: "tone", label: "Tone", min: 500, max: 16000, step: 100, def: 8000, unit: "Hz", curve: "log" },
      { key: "output", label: "Output", min: -24, max: 6, step: 0.5, def: -3, unit: "dB" },
      { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 100, unit: "%" },
    ],
  },
  {
    id: "bitcrush",
    name: "Bitcrusher",
    group: "Character",
    blurb: "Quantises amplitude to fewer bits. Deliberate digital damage.",
    params: [
      { key: "bits", label: "Bit Depth", min: 1, max: 16, step: 1, def: 8, unit: "bit" },
      { key: "mix", label: "Mix", min: 0, max: 100, step: 1, def: 100, unit: "%" },
    ],
  },
  {
    id: "widener",
    name: "Stereo Width",
    group: "Space",
    blurb: "Mid/side balance. Below 100 narrows, above widens.",
    params: [
      { key: "width", label: "Width", min: 0, max: 200, step: 1, def: 130, unit: "%" },
    ],
  },
  {
    id: "pitch",
    name: "Speed & Pitch",
    group: "Character",
    blurb: "Resamples the whole clip. Length and pitch move together, like tape.",
    params: [
      { key: "semitones", label: "Pitch", min: -24, max: 24, step: 1, def: 0, unit: "st" },
    ],
  },
];

export const EFFECT_BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

export function defaultValues(id: string): Record<string, number> {
  const spec = EFFECT_BY_ID.get(id);
  if (!spec) return {};
  return Object.fromEntries(spec.params.map((p) => [p.key, p.def]));
}

/* ------------------------------------------------------------------ */
/* Graph construction                                                  */
/* ------------------------------------------------------------------ */

type Chain = { input: AudioNode; output: AudioNode };

/**
 * Build one effect as an input/output pair. Wet/dry is handled inside each
 * builder that needs it, so the caller can treat every effect identically
 * and just chain outputs into inputs.
 */
function buildEffect(
  ctx: BaseAudioContext,
  inst: EffectInstance,
): Chain | null {
  const v = inst.values;
  const input = ctx.createGain();

  const wetDry = (wet: AudioNode, mixPct: number): Chain => {
    const out = ctx.createGain();
    const wetGain = ctx.createGain();
    const dryGain = ctx.createGain();
    const mix = mixPct / 100;
    // Equal-power crossfade keeps perceived level steady across the knob.
    wetGain.gain.value = Math.sin((mix * Math.PI) / 2);
    dryGain.gain.value = Math.cos((mix * Math.PI) / 2);
    wet.connect(wetGain).connect(out);
    input.connect(dryGain).connect(out);
    return { input, output: out };
  };

  switch (inst.id) {
    case "eq3": {
      const low = ctx.createBiquadFilter();
      low.type = "lowshelf";
      low.frequency.value = v.lowFreq;
      low.gain.value = v.low;

      const mid = ctx.createBiquadFilter();
      mid.type = "peaking";
      mid.frequency.value = v.midFreq;
      mid.Q.value = v.midQ;
      mid.gain.value = v.mid;

      const high = ctx.createBiquadFilter();
      high.type = "highshelf";
      high.frequency.value = v.highFreq;
      high.gain.value = v.high;

      input.connect(low).connect(mid).connect(high);
      return { input, output: high };
    }

    case "filter": {
      const types: BiquadFilterType[] = ["lowpass", "highpass", "bandpass"];
      // Cascading identical biquads is how you get a steeper slope without
      // writing a custom filter: each stage adds 12dB/octave.
      const stages = Math.max(1, Math.round(v.poles));
      let node: AudioNode = input;
      let last: BiquadFilterNode | null = null;
      for (let i = 0; i < stages; i++) {
        const f = ctx.createBiquadFilter();
        f.type = types[Math.round(v.type)] ?? "lowpass";
        f.frequency.value = v.freq;
        // Only the first stage carries the resonance, otherwise the peak
        // stacks and screams.
        f.Q.value = i === 0 ? v.q : 0.707;
        node.connect(f);
        node = f;
        last = f;
      }
      return { input, output: last ?? input };
    }

    case "compressor": {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = v.threshold;
      comp.ratio.value = v.ratio;
      comp.attack.value = v.attack / 1000;
      comp.release.value = v.release / 1000;
      comp.knee.value = v.knee;

      const makeup = ctx.createGain();
      makeup.gain.value = dbToGain(v.makeup);
      input.connect(comp).connect(makeup);
      return { input, output: makeup };
    }

    case "limiter": {
      const drive = ctx.createGain();
      drive.gain.value = dbToGain(v.drive);

      const comp = ctx.createDynamicsCompressor();
      // A limiter is just a compressor with an extreme ratio, no knee, and
      // the fastest attack the platform allows.
      comp.threshold.value = v.ceiling;
      comp.ratio.value = 20;
      comp.attack.value = 0.001;
      comp.release.value = v.release / 1000;
      comp.knee.value = 0;

      const trim = ctx.createGain();
      trim.gain.value = dbToGain(-v.drive * 0.5);
      input.connect(drive).connect(comp).connect(trim);
      return { input, output: trim };
    }

    case "gate": {
      // The Web Audio graph has no gate, so this is an expander built by
      // running a compressor upside down through a heavily driven path.
      const pre = ctx.createGain();
      pre.gain.value = dbToGain(20);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = v.threshold + 20;
      comp.ratio.value = 20;
      comp.attack.value = v.attack / 1000;
      comp.release.value = v.release / 1000;
      comp.knee.value = 0;
      const post = ctx.createGain();
      post.gain.value = dbToGain(-20);
      input.connect(pre).connect(comp).connect(post);
      return { input, output: post };
    }

    case "reverb": {
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx, v.size, v.decay, v.damping);

      const pre = ctx.createDelay(1);
      pre.delayTime.value = v.predelay / 1000;
      input.connect(pre).connect(conv);
      return wetDry(conv, v.mix);
    }

    case "delay": {
      const d = ctx.createDelay(3);
      d.delayTime.value = Math.min(2.999, v.time / 1000);

      const fb = ctx.createGain();
      fb.gain.value = Math.min(0.95, v.feedback / 100);

      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = v.tone;

      // Filter inside the feedback loop so each repeat is darker than the
      // one before it, the way a tape echo behaves.
      input.connect(d);
      d.connect(tone).connect(fb).connect(d);
      return wetDry(d, v.mix);
    }

    case "chorus":
    case "flanger": {
      const isFlanger = inst.id === "flanger";
      const d = ctx.createDelay(0.2);
      d.delayTime.value = (isFlanger ? 3 : v.delay) / 1000;

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = v.rate;

      const depth = ctx.createGain();
      depth.gain.value = v.depth / 1000;
      lfo.connect(depth).connect(d.delayTime);
      lfo.start();

      input.connect(d);

      if (isFlanger) {
        const fb = ctx.createGain();
        fb.gain.value = Math.min(0.9, v.feedback / 100);
        d.connect(fb).connect(d);
      }
      return wetDry(d, v.mix);
    }

    case "tremolo": {
      const amp = ctx.createGain();
      const depth = v.depth / 100;
      // Centre the modulation so the average level stays roughly constant.
      amp.gain.value = 1 - depth / 2;

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = v.rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = depth / 2;
      lfo.connect(lfoGain).connect(amp.gain);
      lfo.start();

      input.connect(amp);
      return { input, output: amp };
    }

    case "distortion": {
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(v.drive / 100);
      shaper.oversample = "4x";

      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = v.tone;

      const out = ctx.createGain();
      out.gain.value = dbToGain(v.output);

      input.connect(shaper).connect(tone).connect(out);
      return wetDry(out, v.mix);
    }

    case "bitcrush": {
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeCrushCurve(v.bits);
      shaper.oversample = "none"; // oversampling would undo the damage
      input.connect(shaper);
      return wetDry(shaper, v.mix);
    }

    case "widener": {
      // Mid/side via gain matrix: split, sum and difference, recombine.
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const w = v.width / 100;

      const midL = ctx.createGain();
      const midR = ctx.createGain();
      const sideL = ctx.createGain();
      const sideR = ctx.createGain();
      midL.gain.value = 0.5;
      midR.gain.value = 0.5;
      sideL.gain.value = 0.5 * w;
      sideR.gain.value = -0.5 * w;

      input.connect(splitter);
      splitter.connect(midL, 0);
      splitter.connect(midR, 1);
      splitter.connect(sideL, 0);
      splitter.connect(sideR, 1);

      midL.connect(merger, 0, 0);
      midR.connect(merger, 0, 0);
      sideL.connect(merger, 0, 0);
      sideR.connect(merger, 0, 0);

      midL.connect(merger, 0, 1);
      midR.connect(merger, 0, 1);
      const negL = ctx.createGain();
      negL.gain.value = -0.5 * w;
      const negR = ctx.createGain();
      negR.gain.value = 0.5 * w;
      splitter.connect(negL, 0);
      splitter.connect(negR, 1);
      negL.connect(merger, 0, 1);
      negR.connect(merger, 0, 1);

      return { input, output: merger };
    }

    default:
      return null;
  }
}

/**
 * Render a buffer through a chain of effects.
 *
 * Pitch is handled outside the graph because it changes the output length,
 * which has to be known before the OfflineAudioContext is constructed.
 */
export async function renderChain(
  source: AudioBuffer,
  chain: EffectInstance[],
): Promise<AudioBuffer> {
  const active = chain.filter((e) => e.enabled);
  if (active.length === 0) return source;

  const pitch = active.find((e) => e.id === "pitch");
  const graphEffects = active.filter((e) => e.id !== "pitch");

  const rate = pitch ? Math.pow(2, (pitch.values.semitones ?? 0) / 12) : 1;
  const outLength = Math.ceil(source.length / rate);

  const ctx = new OfflineAudioContext(
    Math.max(2, source.numberOfChannels),
    Math.max(1, outLength),
    source.sampleRate,
  );

  const src = ctx.createBufferSource();
  src.buffer = source;
  src.playbackRate.value = rate;

  let node: AudioNode = src;
  for (const inst of graphEffects) {
    const built = buildEffect(ctx, inst);
    if (!built) continue;
    node.connect(built.input);
    node = built.output;
  }

  node.connect(ctx.destination);
  src.start(0);

  return ctx.startRendering();
}

/** Preview a single effect on a short excerpt so auditioning stays instant. */
export async function renderPreview(
  source: AudioBuffer,
  chain: EffectInstance[],
  fromSample: number,
  seconds = 4,
): Promise<AudioBuffer> {
  const len = Math.min(
    source.length - fromSample,
    Math.floor(seconds * source.sampleRate),
  );
  if (len <= 0) return source;

  const slice = new OfflineAudioContext(
    source.numberOfChannels,
    len,
    source.sampleRate,
  ).createBuffer(source.numberOfChannels, len, source.sampleRate);

  for (let c = 0; c < source.numberOfChannels; c++) {
    slice.copyToChannel(
      source.getChannelData(c).subarray(fromSample, fromSample + len),
      c,
    );
  }
  return renderChain(slice, chain);
}
