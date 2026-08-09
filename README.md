# Stemloom

A multitrack audio editor that runs entirely inside a browser tab. Files are
decoded, edited, and rendered on your own machine. There is no account, no
upload, no watermark, and no locked feature.

The name is literal. *Stems* are the separate tracks that make up a mix, and a
*loom* is what weaves separate threads into one piece of cloth.

## Why this exists

Browser audio editors mostly fall into two groups. The polished ones —
Soundtrap, BandLab, Amped Studio — are thin clients in front of somebody
else's render farm: you need an account, your audio is uploaded, and the
useful export options sit behind a subscription. The independent ones, like
AudioMass and Wavacity, respect your privacy but stop at single-track editing.

Stemloom aims at the gap: multitrack, offline, and unrestricted.

## What works today

- Multitrack timeline with per-track gain, pan, mute, and solo
- Sample-accurate range selection with zero-crossing snapping
- Cut, copy, paste, crop, silence, repeat, and pad
- Fades in four curves: linear, exponential, logarithmic, and smoothstep
- Peak normalisation, gain in dB, reverse, phase inversion, DC offset repair
- Silence trimming with configurable threshold and attack padding
- Channel swap and mid/side stereo width
- Fourteen effects across dynamics, EQ, time, modulation, character, and space
- WAV export at 16, 24, or 32-bit float, at 44.1k / 48k / 96k, mono or stereo
- Triangular dither on fixed-point export
- Real-time peak and RMS metering, plus a log-scaled spectrum
- Sixty steps of undo
- Installs as a PWA and keeps working with the network off

## What is not built yet

Listing these honestly is more useful than hiding them.

- Microphone recording
- MP3 and Ogg encoding
- Time stretch that preserves pitch (the current pitch control is tape-style —
  speed and pitch move together)
- Spectral repair
- Automation lanes
- Project persistence to the origin private file system
- An Android build

## How it is put together

Everything in `src/lib/audio` is plain TypeScript with no audio dependencies.

| File | Responsibility |
| --- | --- |
| `wav.ts` | RIFF encoder written from scratch; bit depth, dither, channel shaping |
| `peaks.ts` | Multi-resolution min/max peak cache for waveform drawing |
| `edits.ts` | Pure sample-level edit operations; every function returns a new buffer |
| `effects.ts` | Effect registry and Web Audio graph construction |
| `engine.ts` | Transport, live playback, metering, and offline bounce |

A few decisions worth calling out:

**Peaks are cached at five zoom levels.** Reading 23 million samples to draw
1400 pixels is wasteful. Min and max are stored separately rather than a
single absolute value, so asymmetric material looks correct instead of
mirrored.

**Edits are pure.** No function mutates its input, which makes undo a stack of
snapshots that share AudioBuffers by reference. History costs almost nothing.

**Cuts snap to zero crossings** within a short window, and splices get a
64-sample raised-cosine crossfade. That is the difference between a clean edit
and an audible click.

**Reverb impulses are synthesised at render time** rather than shipped as
audio files, with progressive lowpassing through the tail so rooms sound like
rooms and not metal boxes. It keeps the installable payload small.

**Position comes from the audio clock**, derived from `ctx.currentTime`, not
from a `setInterval`. A timer drifts against the audio hardware; a derived
value cannot.

## Running locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## On the subject of other people's software

This is not a clone, a mod, or a crack of any commercial product, and it does
not reproduce anyone's interface. Where conventions are shared — a transport
bar, a channel strip, a timeline — it is because those conventions are how the
work gets done, not because they were copied from a particular vendor.

## Licence

MIT.
