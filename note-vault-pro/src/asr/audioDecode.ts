// Audio decoding to 16kHz mono Float32 PCM + bounded overlapping windowing for Whisper ASR.
export const TARGET_SAMPLE_RATE = 16000;
export const DEFAULT_WINDOW_SEC = 28;
export const DEFAULT_OVERLAP_SEC = 4;

export interface PcmWindow {
  index: number;
  startSec: number;
  endSec: number;
  pcm: Float32Array;
}

/** Downmixes multi-channel PCM and linearly resamples to 16 kHz mono Float32Array. */
export function resampleTo16kMono(
  channels: Float32Array[],
  inputSampleRate: number
): Float32Array {
  if (channels.length === 0 || channels[0].length === 0) return new Float32Array(0);
  const length = channels[0].length;
  const chCount = channels.length;

  // Mix to mono first
  const mono = new Float32Array(length);
  if (chCount === 1) {
    mono.set(channels[0]);
  } else {
    const inv = 1 / chCount;
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let c = 0; c < chCount; c++) sum += channels[c][i] ?? 0;
      mono[i] = sum * inv;
    }
  }

  if (inputSampleRate === TARGET_SAMPLE_RATE) return mono;

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.round(length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = mono[idx] ?? 0;
    const b = mono[Math.min(idx + 1, length - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Decodes any browser-supported audio Blob into 16 kHz mono PCM via Web Audio. */
export async function decodeBlobTo16kMono(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const Ctor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("WEB_AUDIO_UNAVAILABLE");

  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      channels.push(decoded.getChannelData(c));
    }

    // Prefer OfflineAudioContext when sample rate differs (better anti-aliased sinc resampling)
    if (decoded.sampleRate !== TARGET_SAMPLE_RATE && typeof OfflineAudioContext !== "undefined") {
      try {
        const targetFrames = Math.max(1, Math.ceil((decoded.length * TARGET_SAMPLE_RATE) / decoded.sampleRate));
        const offline = new OfflineAudioContext(1, targetFrames, TARGET_SAMPLE_RATE);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        return new Float32Array(rendered.getChannelData(0));
      } catch {
        // Fallback to linear resampler below
      }
    }

    return resampleTo16kMono(channels, decoded.sampleRate);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Splits long 16 kHz PCM into overlapping windows (`windowSec=28`, `overlapSec=4`, stride=24s)
 * so peak Whisper inference memory stays strictly bounded even on 2-hour lectures.
 */
export function buildPcmWindows(
  pcm: Float32Array,
  windowSec = DEFAULT_WINDOW_SEC,
  overlapSec = DEFAULT_OVERLAP_SEC,
  sampleRate = TARGET_SAMPLE_RATE
): PcmWindow[] {
  if (pcm.length === 0) return [];
  const winSamples = Math.max(sampleRate, Math.round(windowSec * sampleRate));
  const overlapSamples = Math.max(0, Math.min(winSamples - sampleRate, Math.round(overlapSec * sampleRate)));
  const stepSamples = Math.max(sampleRate, winSamples - overlapSamples);

  const windows: PcmWindow[] = [];
  let start = 0;
  let index = 0;
  while (start < pcm.length) {
    const end = Math.min(pcm.length, start + winSamples);
    const slice = pcm.subarray(start, end);
    // Avoid trailing near-empty sliver (< 0.25s) unless it is the only chunk
    if (index > 0 && slice.length < sampleRate * 0.25) break;
    windows.push({
      index,
      startSec: start / sampleRate,
      endSec: end / sampleRate,
      pcm: slice,
    });
    if (end >= pcm.length) break;
    start += stepSamples;
    index += 1;
  }
  return windows;
}
