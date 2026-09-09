/**
 * Raw capture worklet.
 *
 * MediaRecorder would be less code, but it hands back Opus in a WebM
 * container — already lossy before the first edit. An editor should never
 * introduce generation loss at the point of capture, so this pulls the
 * float samples straight off the audio thread instead and lets the main
 * thread assemble them.
 *
 * Blocks are copied before posting. The buffers the audio thread provides
 * are reused on the next render quantum, so passing them along without a
 * copy hands the main thread memory that is about to be overwritten.
 */

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;

    this.port.onmessage = (e) => {
      if (e.data === "start") this.recording = true;
      else if (e.data === "stop") this.recording = false;
    };
  }

  process(inputs) {
    const input = inputs[0];

    if (this.recording && input && input.length > 0 && input[0].length > 0) {
      const block = [];
      for (let c = 0; c < input.length; c++) {
        block.push(new Float32Array(input[c]));
      }
      // Transfer the underlying buffers rather than structured-cloning
      // them; capture runs for minutes and the copies add up.
      this.port.postMessage(
        block,
        block.map((b) => b.buffer),
      );
    }

    // Returning true keeps the node alive even while paused.
    return true;
  }
}

registerProcessor("stemloom-recorder", RecorderProcessor);
