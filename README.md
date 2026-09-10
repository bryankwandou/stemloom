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
- Twenty-two effects across dynamics, EQ, time, modulation, character, and space
- Time stretch and pitch shift by WSOLA, independent of one another, alongside
  a tape-style control where speed and pitch move together
- Microphone recording in two stages: arm and monitor, then roll
- A spectrogram view per lane, analysed in a worker so scrolling stays smooth
- Spectral repair: drag a box around a noise on the spectrogram and either
  rebuild that patch from the sound either side of it or pull it down 40 dB,
  leaving everything above and below the box alone
- WAV export at 16, 24, or 32-bit float, at 44.1k / 48k / 96k, mono or stereo
- AAC export through WebCodecs with hand-written ADTS framing
- Triangular dither on fixed-point export
- Loudness measurement to ITU-R BS.1770-4: integrated LUFS, loudness range,
  and inter-sample true peak, against Spotify, Apple, EBU R128, and CD targets
- Projects saved to IndexedDB as raw float samples, so reopening costs nothing
  in quality
- Real-time peak and RMS metering, plus a log-scaled spectrum
- Sixty steps of undo
- Installs as a PWA and keeps working with the network off

## What is not built yet

Listing these honestly is more useful than hiding them.

- MP3 and Ogg encoding
- Automation lanes
- MIDI, instruments, or anything that generates notes rather than editing them
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
| `timestretch.ts` | WSOLA time stretch, pitch shift, and sample-rate conversion |
| `loudness.ts` | BS.1770-4 K-weighting, gated LUFS, loudness range, true peak |
| `encode.ts` | WebCodecs AAC encoding with ADTS headers written by hand |
| `recorder.ts` | Input capture through an AudioWorklet |
| `spectrogram.ts` | Radix-2 FFT, short-time transform, and the display ramp |
| `spectral.ts` | The same transform run backwards, for repairing a band over a range |

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

**Stretching reads from an ideal position, not the last one.** WSOLA finds the
best splice point within a search window, but if the read head then advances
from wherever it landed, the small corrections accumulate and the output drifts
away from the requested length. Advancing by the nominal hop from the ideal
position instead keeps the error bounded.

**Repair reads its reference from two windows out.** Healing a band fills
it by interpolating from the frames either side of the selection, but a
frame whose centre sits just outside the selection still overlaps it by
half a window, so it holds a good part of whatever is being removed. Read
from there and the gap fills with a quieter copy of the problem — measured
at 12 dB of attenuation instead of the 62 dB the same edit gives once the
reference frames are taken from beyond the overlap.

**Recording defaults to no cleanup.** Echo cancellation, noise suppression, and
automatic gain are all off unless asked for. They exist for calls and they
destroy a music take.

**Position comes from the audio clock**, derived from `ctx.currentTime`, not
from a `setInterval`. A timer drifts against the audio hardware; a derived
value cannot.

## Running locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Verification

A green TypeScript build says nothing about whether a microphone opens, an
encoder emits a valid bitstream, or a canvas has any pixels on it. Two
suites cover that, and both are meant to be run by hand.

`scripts/browser-check.mjs` drives the real page in real Chromium and reads
the bytes that come out: the exported WAV is parsed back and checked for a
RIFF header whose declared length matches the file and for sample data that
is not silence, the AAC file is walked frame by frame to confirm the ADTS
sync words chain correctly, and recording is exercised against the
synthetic input device Chrome offers behind its fake-media flags. It also
confirms the editor still loads with the network switched off.

Playwright is deliberately not a dependency — it is a large download for
something that runs occasionally — so point the script at an installation
you already have:

```bash
PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/browser-check.mjs
BASE=http://localhost:3000 node scripts/browser-check.mjs
```

`scripts/spectrogram-check.mjs` covers the transform numerically, since a
spectrogram that draws something is not the same as one that is correct,
and a wrong one has you chasing a hum that was never there. Synthesised
tones from 50 Hz to 12 kHz have to land within a semitone, two tones an
octave apart have to resolve as two peaks with a real trough between them,
level has to rise monotonically with amplitude, silence has to floor, and
windows running off the end of the buffer have to stay finite.

```bash
npx tsc src/lib/audio/spectrogram.ts --target es2020 --module es2020   --types --skipLibCheck --outDir .tmp-check
node scripts/spectrogram-check.mjs .tmp-check/spectrogram.js
```

`scripts/spectral-check.mjs` holds repair to the property it depends on:
an edit that changes nothing has to return the samples it was given. It
does, to within 138 dB of the original, which is below the noise floor of
any format you could export to. The rest of the suite measures a real
edit — a tone confined to the selection drops 62 dB while a tone outside
the band moves by a hundredth of one, a tone running through the
selection is put back at the level it went in, and samples outside the
selected time are byte for byte unchanged.

```bash
npx tsc src/lib/audio/spectral.ts src/lib/audio/spectrogram.ts   --target es2020 --module es2020 --skipLibCheck --outDir .tmp-check
node scripts/fix-esm.mjs .tmp-check
node scripts/spectral-check.mjs
```

## On the subject of other people's software

This is not a clone, a mod, or a crack of any commercial product, and it does
not reproduce anyone's interface. Where conventions are shared — a transport
bar, a channel strip, a timeline — it is because those conventions are how the
work gets done, not because they were copied from a particular vendor.

## Licence

MIT.
