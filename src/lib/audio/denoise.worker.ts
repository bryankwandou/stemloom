/**
 * Noise reduction, off the main thread.
 *
 * Every sample of the track goes through a forward and an inverse
 * transform, four times over at a quarter-window hop. On a five-minute
 * stereo song that is seconds of work, and done inline it freezes the page
 * for all of them. Here the page keeps drawing and the status line can say
 * what is happening.
 */

import { reduceNoise, type DenoiseOptions } from "./denoise";

export type DenoiseRequest = {
  kind: "denoise";
  channels: ArrayBuffer[];
  /** One learned spectrum per channel of the profile. */
  noise: ArrayBuffer[];
  opts: DenoiseOptions;
};

export type DenoiseReply =
  | { kind: "denoise"; channels: ArrayBuffer[] }
  | { kind: "denoise"; error: string };

// Listens for its own kind only; see spectrogram.worker.ts for why.
self.addEventListener("message", (e: MessageEvent<DenoiseRequest>) => {
  if (e.data?.kind !== "denoise") return;
  try {
    const { channels, noise, opts } = e.data;
    const out = channels.map((raw, c) => {
      // A mono profile applied to a stereo track uses the one spectrum for
      // both sides, rather than refusing.
      const n = new Float32Array(noise[Math.min(c, noise.length - 1)]);
      return reduceNoise(new Float32Array(raw), n, opts).buffer;
    });
    (self as unknown as Worker).postMessage({ kind: "denoise", channels: out } satisfies DenoiseReply, out);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      kind: "denoise",
      error: err instanceof Error ? err.message : String(err),
    } satisfies DenoiseReply);
  }
});
