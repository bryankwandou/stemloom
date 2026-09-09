/**
 * Microphone capture.
 *
 * Records uncompressed float samples through an AudioWorklet, so what
 * lands on the timeline is exactly what the interface produced. Browser
 * processing — echo cancellation, noise suppression, auto gain — is
 * switched off by default, because all three are tuned for voice calls
 * and all three will chew up a music take.
 */

export type RecorderOptions = {
  /** Leave off for music. Turn on for a quick voice memo in a noisy room. */
  cleanup?: boolean;
  deviceId?: string;
};

export type RecorderStatus = "idle" | "arming" | "recording" | "stopped";

export class Recorder {
  private ctx: AudioContext;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;

  /** Captured blocks, one array per channel. */
  private blocks: Float32Array[][] = [];
  private frames = 0;
  private meterBuf = new Float32Array(1024);

  status: RecorderStatus = "idle";

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** How long the current take has been running. */
  get duration(): number {
    return this.frames / this.ctx.sampleRate;
  }

  static async devices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput");
  }

  async arm(opts: RecorderOptions = {}) {
    if (this.status === "recording") return;
    this.status = "arming";

    const clean = opts.cleanup ?? false;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: clean,
        noiseSuppression: clean,
        autoGainControl: clean,
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      },
      video: false,
    });

    await this.ctx.audioWorklet.addModule("/worklets/recorder.js");

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "stemloom-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
    });

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;

    this.node.port.onmessage = (e: MessageEvent<Float32Array[]>) => {
      const block = e.data;
      if (!block?.length) return;
      this.blocks.push(block);
      this.frames += block[0].length;
    };

    this.source.connect(this.analyser);
    this.analyser.connect(this.node);

    // The worklet has an output but nothing should reach the speakers —
    // monitoring a live mic through them is how you get feedback. A
    // zero-gain sink keeps the graph pulling without making a sound.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);

    this.status = "stopped";
  }

  start() {
    if (!this.node) throw new Error("Arm the recorder before starting it.");
    this.blocks = [];
    this.frames = 0;
    this.node.port.postMessage("start");
    this.status = "recording";
  }

  /** Stop and hand back the take. Returns null if nothing was captured. */
  stop(): AudioBuffer | null {
    if (!this.node) return null;
    this.node.port.postMessage("stop");
    this.status = "stopped";

    if (this.frames === 0) return null;

    const channels = this.blocks[0]?.length ?? 1;
    const out = new OfflineAudioContext(
      channels,
      this.frames,
      this.ctx.sampleRate,
    ).createBuffer(channels, this.frames, this.ctx.sampleRate);

    for (let c = 0; c < channels; c++) {
      const dst = out.getChannelData(c);
      let pos = 0;
      for (const block of this.blocks) {
        const src = block[Math.min(c, block.length - 1)];
        dst.set(src, pos);
        pos += src.length;
      }
    }

    this.blocks = [];
    this.frames = 0;
    return out;
  }

  /** Input level, for the arming meter. */
  level(): { peak: number; rms: number } {
    if (!this.analyser) return { peak: 0, rms: 0 };
    this.analyser.getFloatTimeDomainData(
      this.meterBuf as Float32Array<ArrayBuffer>,
    );
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const a = Math.abs(this.meterBuf[i]);
      if (a > peak) peak = a;
      sumSq += this.meterBuf[i] * this.meterBuf[i];
    }
    return { peak, rms: Math.sqrt(sumSq / this.meterBuf.length) };
  }

  dispose() {
    try {
      this.node?.port.postMessage("stop");
      this.node?.disconnect();
      this.source?.disconnect();
      this.analyser?.disconnect();
      // Releasing the tracks is what actually turns the recording
      // indicator off in the browser chrome.
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* teardown is best effort */
    }
    this.node = null;
    this.source = null;
    this.analyser = null;
    this.stream = null;
    this.blocks = [];
    this.frames = 0;
    this.status = "idle";
  }
}
