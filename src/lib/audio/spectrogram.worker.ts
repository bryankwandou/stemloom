/**
 * Spectrogram analysis, off the main thread.
 *
 * Measured on a sixty second file, a full-width lane costs a little over
 * six hundred milliseconds for two channels. Run inline that is a visible
 * stall on every scroll and every zoom step, multiplied by the number of
 * tracks. Run here it costs nothing the user can feel, and the lane keeps
 * showing its previous picture until the new one arrives.
 *
 * Samples arrive as a slice rather than the whole track. Sending an entire
 * decoded buffer for each redraw would move tens of megabytes to save one
 * copy of a few hundred kilobytes.
 */

import { analyse, paint } from "./spectrogram";

export type SpectrogramRequest = {
  id: number;
  /** One slice per channel, already trimmed to the window plus padding. */
  channels: ArrayBuffer[];
  /** Where the slice starts, relative to the requested window. */
  sliceOffset: number;
  columns: number;
  bands: number;
  sampleRate: number;
  windowSamples: number;
};

export type SpectrogramReply = {
  id: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
};

self.onmessage = (e: MessageEvent<SpectrogramRequest>) => {
  const req = e.data;
  const { columns, bands, sampleRate } = req;
  const height = bands * req.channels.length;
  const rgba = new Uint8ClampedArray(columns * height * 4);

  for (let c = 0; c < req.channels.length; c++) {
    const samples = new Float32Array(req.channels[c]);
    const frame = analyse(
      samples,
      req.sliceOffset,
      req.sliceOffset + req.windowSamples,
      columns,
      bands,
      sampleRate,
    );
    // paint() writes a whole image starting at row zero, so give it a
    // view onto this channel's band of the output rather than a separate
    // array that would then have to be copied in.
    const stride = columns * bands * 4;
    paint(frame, rgba.subarray(c * stride, (c + 1) * stride));
  }

  const reply: SpectrogramReply = {
    id: req.id,
    width: columns,
    height,
    pixels: rgba.buffer,
  };
  (self as unknown as Worker).postMessage(reply, [rgba.buffer]);
};
