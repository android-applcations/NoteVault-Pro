// Self-contained Whisper ONNX inference & log-mel spectrogram computation (WASM-only, offline-safe).
import * as ort from "onnxruntime-web/wasm";
import { Tokenizer } from "@huggingface/tokenizers";
import type { AsrModelRecord } from "@/data/types";
import { cacheGetBytes } from "./modelManager";
import { localCacheKey, sha256Bytes } from "./models";
import type { RawChunkSegment } from "./chunkMerge";

export const WHISPER_N_FFT = 400;
export const WHISPER_HOP_LENGTH = 160;
export const WHISPER_N_SAMPLES = 480000; // 30s * 16kHz
export const WHISPER_N_FRAMES = 3000; // 480000 / 160
export const WHISPER_N_BINS = WHISPER_N_FFT / 2 + 1; // 201

// --- Pure Radix-2 FFT + Bluestein N=400 exact DFT ---
function radix2Fft(re: Float64Array, im: Float64Array, invert: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((invert ? 2 : -2) * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }
  if (invert) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }
}

interface BluesteinPlan {
  n: number;
  m: number;
  chirpRe: Float64Array;
  chirpIm: Float64Array;
  bFftRe: Float64Array;
  bFftIm: Float64Array;
  aRe: Float64Array;
  aIm: Float64Array;
}

function createBluesteinPlan(n: number): BluesteinPlan {
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);

  for (let k = 0; k < n; k++) {
    const angle = (Math.PI * ((k * k) % (2 * n))) / n;
    chirpRe[k] = Math.cos(angle);
    chirpIm[k] = Math.sin(angle);
    bRe[k] = chirpRe[k];
    bIm[k] = chirpIm[k];
    if (k > 0) {
      bRe[m - k] = chirpRe[k];
      bIm[m - k] = chirpIm[k];
    }
  }
  radix2Fft(bRe, bIm, false);
  return {
    n,
    m,
    chirpRe,
    chirpIm,
    bFftRe: bRe,
    bFftIm: bIm,
    aRe: new Float64Array(m),
    aIm: new Float64Array(m),
  };
}

function computePowerSpectrum(plan: BluesteinPlan, frame: Float64Array, outPower: Float32Array) {
  const { n, m, chirpRe, chirpIm, bFftRe, bFftIm, aRe, aIm } = plan;
  aRe.fill(0);
  aIm.fill(0);
  for (let k = 0; k < n; k++) {
    aRe[k] = frame[k] * chirpRe[k];
    aIm[k] = -frame[k] * chirpIm[k];
  }
  radix2Fft(aRe, aIm, false);
  for (let k = 0; k < m; k++) {
    const ar = aRe[k];
    const ai = aIm[k];
    const br = bFftRe[k];
    const bi = bFftIm[k];
    aRe[k] = ar * br - ai * bi;
    aIm[k] = ar * bi + ai * br;
  }
  radix2Fft(aRe, aIm, true);
  const bins = (n >> 1) + 1;
  for (let k = 0; k < bins; k++) {
    const re = aRe[k] * chirpRe[k] + aIm[k] * chirpIm[k];
    const im = aIm[k] * chirpRe[k] - aRe[k] * chirpIm[k];
    outPower[k] = re * re + im * im;
  }
}

// --- Slaney mel scale & Whisper mel filterbank (matches HuggingFace AudioFeatureExtractor / librosa slaney) ---
function hzToMelSlaney(freq: number): number {
  const minLogHz = 1000.0;
  const minLogMel = 15.0; // 1000 * 3 / 200
  const logStep = Math.log(6.4) / 27.0;
  if (freq >= minLogHz) {
    return minLogMel + Math.log(freq / minLogHz) / logStep;
  }
  return (3.0 * freq) / 200.0;
}

function melToHzSlaney(mel: number): number {
  const minLogHz = 1000.0;
  const minLogMel = 15.0;
  const logStep = Math.log(6.4) / 27.0;
  if (mel >= minLogMel) {
    return minLogHz * Math.exp(logStep * (mel - minLogMel));
  }
  return (200.0 * mel) / 3.0;
}

/** Computes Slaney-normalized mel filterbank of shape `[nMels][nFft/2 + 1]`. */
export function computeSlaneyMelFilterbank(
  nFft = WHISPER_N_FFT,
  nMels = 80,
  sampleRate = 16000
): Float32Array {
  const nBins = Math.floor(nFft / 2) + 1;
  const melMin = hzToMelSlaney(0);
  const melMax = hzToMelSlaney(sampleRate / 2);
  const melPoints = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melPoints[i] = melToHzSlaney(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }
  const fftFreqs = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) {
    fftFreqs[k] = (k * (sampleRate / 2)) / (nBins - 1);
  }
  const filters = new Float32Array(nMels * nBins);
  for (let m = 0; m < nMels; m++) {
    const fLeft = melPoints[m];
    const fCenter = melPoints[m + 1];
    const fRight = melPoints[m + 2];
    const enorm = 2.0 / (fRight - fLeft);
    for (let k = 0; k < nBins; k++) {
      const f = fftFreqs[k];
      const lower = (f - fLeft) / (fCenter - fLeft);
      const upper = (fRight - f) / (fRight - fCenter);
      const weight = Math.max(0, Math.min(lower, upper)) * enorm;
      filters[m * nBins + k] = weight;
    }
  }
  return filters;
}

/**
 * Computes Whisper log-mel features of shape `[1, featureSize, 3000]` matching
 * OpenAI Whisper & HuggingFace `WhisperFeatureExtractor`.
 */
export function computeWhisperMelFeatures(
  audioPcm: Float32Array,
  melFilters?: Float32Array,
  featureSize = 80
): Float32Array {
  const filters = melFilters ?? computeSlaneyMelFilterbank(WHISPER_N_FFT, featureSize, 16000);
  const nBins = WHISPER_N_BINS;

  // Pad or truncate waveform to exactly 30s (480,000 samples)
  const paddedWave = new Float32Array(WHISPER_N_SAMPLES);
  const copyLen = Math.min(audioPcm.length, WHISPER_N_SAMPLES);
  paddedWave.set(audioPcm.subarray(0, copyLen), 0);

  // Reflect-pad 200 samples on each side (center=True STFT with N_FFT=400 -> pad=200)
  const pad = WHISPER_N_FFT >> 1;
  const signal = new Float32Array(WHISPER_N_SAMPLES + 2 * pad);
  signal.set(paddedWave, pad);
  for (let i = 0; i < pad; i++) {
    signal[pad - 1 - i] = paddedWave[Math.min(i + 1, WHISPER_N_SAMPLES - 1)];
    signal[pad + WHISPER_N_SAMPLES + i] = paddedWave[Math.max(0, WHISPER_N_SAMPLES - 2 - i)];
  }

  // Periodic Hann window of length N_FFT=400
  const hann = new Float64Array(WHISPER_N_FFT);
  for (let n = 0; n < WHISPER_N_FFT; n++) {
    hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / WHISPER_N_FFT));
  }

  const plan = createBluesteinPlan(WHISPER_N_FFT);
  const frameBuf = new Float64Array(WHISPER_N_FFT);
  const power = new Float32Array(nBins);
  const melSpec = new Float32Array(featureSize * WHISPER_N_FRAMES);

  let maxLog = -Infinity;
  for (let frameIdx = 0; frameIdx < WHISPER_N_FRAMES; frameIdx++) {
    const start = frameIdx * WHISPER_HOP_LENGTH;
    for (let n = 0; n < WHISPER_N_FFT; n++) {
      frameBuf[n] = signal[start + n] * hann[n];
    }
    computePowerSpectrum(plan, frameBuf, power);
    for (let m = 0; m < featureSize; m++) {
      const fOff = m * nBins;
      let energy = 0;
      for (let k = 0; k < nBins; k++) {
        energy += filters[fOff + k] * power[k];
      }
      const val = Math.log10(Math.max(energy, 1e-10));
      melSpec[m * WHISPER_N_FRAMES + frameIdx] = val;
      if (val > maxLog) maxLog = val;
    }
  }

  const floorVal = maxLog - 8.0;
  for (let i = 0; i < melSpec.length; i++) {
    const clamped = melSpec[i] < floorVal ? floorVal : melSpec[i];
    melSpec[i] = (clamped + 4.0) / 4.0;
  }
  return melSpec;
}

function buildFlatFiltersFromConfig(preCfg: Record<string, unknown>, featureSize: number): Float32Array {
  const raw = preCfg.mel_filters;
  if (Array.isArray(raw) && raw.length === featureSize) {
    const out = new Float32Array(featureSize * WHISPER_N_BINS);
    let ok = true;
    for (let m = 0; m < featureSize; m++) {
      const row = raw[m];
      if (!Array.isArray(row) || row.length !== WHISPER_N_BINS) {
        ok = false;
        break;
      }
      for (let k = 0; k < WHISPER_N_BINS; k++) {
        out[m * WHISPER_N_BINS + k] = Number(row[k]) || 0;
      }
    }
    if (ok) return out;
  }
  return computeSlaneyMelFilterbank(WHISPER_N_FFT, featureSize, 16000);
}

function logSumExp(logits: Float32Array, start: number, end: number): number {
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    if (logits[i] > max) max = logits[i];
  }
  if (!Number.isFinite(max)) return -Infinity;
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += Math.exp(logits[i] - max);
  }
  return max + Math.log(sum);
}

function argmaxRange(arr: Float32Array, start: number, end: number): number {
  let bestIdx = start;
  let bestVal = -Infinity;
  for (let i = start; i < end; i++) {
    if (arr[i] > bestVal) {
      bestVal = arr[i];
      bestIdx = i;
    }
  }
  return bestIdx;
}

function toNumberArray(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data;
  if (ArrayBuffer.isView(data)) {
    const out = new Float32Array((data as unknown as ArrayLike<number>).length);
    for (let i = 0; i < out.length; i++) out[i] = Number((data as unknown as ArrayLike<number>)[i]);
    return out;
  }
  return new Float32Array(0);
}

export interface WhisperTranscribeOptions {
  language: "auto" | "ar" | "en";
  windowOffsetSec: number;
  windowDurationSec: number;
}

export class WhisperSession {
  readonly modelId: string;
  private encoder: ort.InferenceSession;
  private decoder: ort.InferenceSession;
  private tokenizer: Tokenizer;
  private featureSize: number;
  private melFilters: Float32Array;
  private numHiddenLayers: number;
  private numAttentionHeads: number;
  private headDim: number;
  private maxTargetPositions: number;
  private sotToken: number;
  private eosToken: number;
  private transcribeToken: number | null;
  private noTimestampsToken: number;
  private timestampBeginToken: number;
  private suppressTokens: Set<number>;
  private beginSuppressTokens: Set<number>;
  private langTokenIds: Map<string, number>;

  private constructor(params: {
    modelId: string;
    encoder: ort.InferenceSession;
    decoder: ort.InferenceSession;
    tokenizer: Tokenizer;
    featureSize: number;
    melFilters: Float32Array;
    numHiddenLayers: number;
    numAttentionHeads: number;
    headDim: number;
    maxTargetPositions: number;
    sotToken: number;
    eosToken: number;
    transcribeToken: number | null;
    noTimestampsToken: number;
    timestampBeginToken: number;
    suppressTokens: Set<number>;
    beginSuppressTokens: Set<number>;
    langTokenIds: Map<string, number>;
  }) {
    this.modelId = params.modelId;
    this.encoder = params.encoder;
    this.decoder = params.decoder;
    this.tokenizer = params.tokenizer;
    this.featureSize = params.featureSize;
    this.melFilters = params.melFilters;
    this.numHiddenLayers = params.numHiddenLayers;
    this.numAttentionHeads = params.numAttentionHeads;
    this.headDim = params.headDim;
    this.maxTargetPositions = params.maxTargetPositions;
    this.sotToken = params.sotToken;
    this.eosToken = params.eosToken;
    this.transcribeToken = params.transcribeToken;
    this.noTimestampsToken = params.noTimestampsToken;
    this.timestampBeginToken = params.timestampBeginToken;
    this.suppressTokens = params.suppressTokens;
    this.beginSuppressTokens = params.beginSuppressTokens;
    this.langTokenIds = params.langTokenIds;
  }

  /** Loads & SHA-256 verifies a cached Whisper ONNX model strictly from CacheStorage (zero network calls). */
  static async createFromCache(model: AsrModelRecord, wasmBaseUrl: string): Promise<WhisperSession> {
    ort.env.wasm.wasmPaths = wasmBaseUrl;
    ort.env.wasm.proxy = false;
    ort.env.wasm.numThreads =
      typeof self !== "undefined" && (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated
        ? Math.min(4, navigator.hardwareConcurrency || 2)
        : 1;

    const readVerified = async (filePath: string): Promise<Uint8Array> => {
      const info = model.fileHashes[filePath];
      const bytes = await cacheGetBytes(localCacheKey(model.id, filePath));
      if (!bytes) throw new Error(`MODEL_MISSING_FILE:${filePath}`);
      if (info?.sha256) {
        const digest = await sha256Bytes(bytes);
        if (digest !== info.sha256) {
          throw new Error(`MODEL_INTEGRITY_FAILED:${filePath}`);
        }
      }
      return bytes;
    };

    const [cfgBytes, genBytes, preBytes, tokBytes, tokCfgBytes, encBytes, decBytes] = await Promise.all([
      readVerified("config.json"),
      readVerified("generation_config.json"),
      readVerified("preprocessor_config.json"),
      readVerified("tokenizer.json"),
      cacheGetBytes(localCacheKey(model.id, "tokenizer_config.json")).then((b) => b ?? new Uint8Array(new TextEncoder().encode("{}"))),
      readVerified("onnx/encoder_model_quantized.onnx"),
      readVerified("onnx/decoder_model_merged_quantized.onnx"),
    ]);

    const decText = (b: Uint8Array) => JSON.parse(new TextDecoder("utf-8").decode(b)) as Record<string, unknown>;
    const cfg = decText(cfgBytes);
    const genCfg = decText(genBytes);
    const preCfg = decText(preBytes);
    const tokJson = decText(tokBytes);
    const tokCfg = decText(tokCfgBytes);

    const tokenizer = new Tokenizer(tokJson, tokCfg);
    const featureSize = Number(preCfg.feature_size ?? cfg.num_mel_bins ?? 80);
    const melFilters = buildFlatFiltersFromConfig(preCfg, featureSize);
    const numHiddenLayers = Number(cfg.decoder_layers ?? 4);
    const numAttentionHeads = Number(cfg.decoder_attention_heads ?? 6);
    const dModel = Number(cfg.d_model ?? 384);
    const headDim = Math.floor(dModel / numAttentionHeads);
    const maxTargetPositions = Math.min(448, Number(cfg.max_target_positions ?? 448));

    const sotToken = Number(genCfg.decoder_start_token_id ?? cfg.decoder_start_token_id ?? tokenizer.token_to_id("<|startoftranscript|>") ?? 50258);
    const eosToken = Number(genCfg.eos_token_id ?? cfg.eos_token_id ?? tokenizer.token_to_id("<|endoftext|>") ?? 50257);
    const noTimestampsToken = Number(genCfg.no_timestamps_token_id ?? tokenizer.token_to_id("<|notimestamps|>") ?? 50363);
    const transcribeToken = tokenizer.token_to_id("<|transcribe|>") ?? null;
    const timestampBeginToken = (tokenizer.token_to_id("<|0.00|>") ?? noTimestampsToken + 1);

    const suppressList = Array.isArray(genCfg.suppress_tokens) ? (genCfg.suppress_tokens as number[]) : [];
    const beginSuppressList = Array.isArray(genCfg.begin_suppress_tokens) ? (genCfg.begin_suppress_tokens as number[]) : [220, eosToken];

    const langTokenIds = new Map<string, number>();
    const rawLangMap = (genCfg.lang_to_id as Record<string, number> | undefined) ?? {};
    for (const [k, v] of Object.entries(rawLangMap)) {
      const code = k.replace(/^<\|/, "").replace(/\|>$/, "");
      langTokenIds.set(code, Number(v));
    }
    if (!langTokenIds.has("ar")) {
      const arId = tokenizer.token_to_id("<|ar|>");
      if (arId !== undefined) langTokenIds.set("ar", arId);
    }
    if (!langTokenIds.has("en")) {
      const enId = tokenizer.token_to_id("<|en|>");
      if (enId !== undefined) langTokenIds.set("en", enId);
    }

    const sessionOpts: ort.InferenceSession.SessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    };

    const [encoder, decoder] = await Promise.all([
      ort.InferenceSession.create(encBytes, sessionOpts),
      ort.InferenceSession.create(decBytes, sessionOpts),
    ]);

    return new WhisperSession({
      modelId: model.id,
      encoder,
      decoder,
      tokenizer,
      featureSize,
      melFilters,
      numHiddenLayers,
      numAttentionHeads,
      headDim,
      maxTargetPositions,
      sotToken,
      eosToken,
      transcribeToken,
      noTimestampsToken,
      timestampBeginToken,
      suppressTokens: new Set(suppressList),
      beginSuppressTokens: new Set(beginSuppressList),
      langTokenIds,
    });
  }

  async dispose() {
    await this.encoder.release().catch(() => undefined);
    await this.decoder.release().catch(() => undefined);
  }

  private emptyPastKeyValues(): Record<string, ort.Tensor> {
    const kv: Record<string, ort.Tensor> = {};
    const decEmpty = new Float32Array(0);
    const encEmpty = new Float32Array(0);
    for (let i = 0; i < this.numHiddenLayers; i++) {
      kv[`past_key_values.${i}.decoder.key`] = new ort.Tensor("float32", decEmpty, [1, this.numAttentionHeads, 0, this.headDim]);
      kv[`past_key_values.${i}.decoder.value`] = new ort.Tensor("float32", decEmpty, [1, this.numAttentionHeads, 0, this.headDim]);
      kv[`past_key_values.${i}.encoder.key`] = new ort.Tensor("float32", encEmpty, [1, this.numAttentionHeads, 0, this.headDim]);
      kv[`past_key_values.${i}.encoder.value`] = new ort.Tensor("float32", encEmpty, [1, this.numAttentionHeads, 0, this.headDim]);
    }
    return kv;
  }

  private async runDecoderStep(
    inputIds: number[],
    encoderHidden: ort.Tensor,
    pastKv: Record<string, ort.Tensor>,
    useCache: boolean
  ): Promise<{ logits: Float32Array; vocabSize: number; nextKv: Record<string, ort.Tensor> }> {
    const seqLen = inputIds.length;
    const idsBigInt = new BigInt64Array(seqLen);
    for (let i = 0; i < seqLen; i++) idsBigInt[i] = BigInt(inputIds[i]);

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", idsBigInt, [1, seqLen]),
      use_cache_branch: new ort.Tensor("bool", [useCache], [1]),
      ...pastKv,
    };
    if (this.decoder.inputNames.includes("encoder_hidden_states")) {
      feeds.encoder_hidden_states = encoderHidden;
    }

    const outputs = await this.decoder.run(feeds);
    const logitsTensor = outputs.logits;
    const vocabSize = logitsTensor.dims[logitsTensor.dims.length - 1];
    const allLogits = toNumberArray(logitsTensor.data);
    const lastOffset = (seqLen - 1) * vocabSize;
    const lastLogits = allLogits.subarray(lastOffset, lastOffset + vocabSize);

    const nextKv: Record<string, ort.Tensor> = {};
    for (let i = 0; i < this.numHiddenLayers; i++) {
      nextKv[`past_key_values.${i}.decoder.key`] = outputs[`present.${i}.decoder.key`] ?? pastKv[`past_key_values.${i}.decoder.key`];
      nextKv[`past_key_values.${i}.decoder.value`] = outputs[`present.${i}.decoder.value`] ?? pastKv[`past_key_values.${i}.decoder.value`];
      // Preserve encoder KV from first pass when decoder outputs zero-length encoder cache on cached branch
      if (!useCache && outputs[`present.${i}.encoder.key`]) {
        nextKv[`past_key_values.${i}.encoder.key`] = outputs[`present.${i}.encoder.key`];
        nextKv[`past_key_values.${i}.encoder.value`] = outputs[`present.${i}.encoder.value`];
      } else {
        nextKv[`past_key_values.${i}.encoder.key`] = pastKv[`past_key_values.${i}.encoder.key`];
        nextKv[`past_key_values.${i}.encoder.value`] = pastKv[`past_key_values.${i}.encoder.value`];
      }
    }

    return { logits: lastLogits, vocabSize, nextKv };
  }

  /** Applies Whisper timestamp & suppression logit rules in place and picks the next token greedily. */
  private pickNextToken(
    logits: Float32Array,
    vocabSize: number,
    generated: number[],
    promptLen: number,
    maxInitialTimestampIdx: number
  ): number {
    const scores = new Float32Array(logits);

    // Suppress forbidden special tokens & <|notimestamps|>
    for (const tid of this.suppressTokens) {
      if (tid < vocabSize) scores[tid] = -Infinity;
    }
    if (this.noTimestampsToken < vocabSize) {
      scores[this.noTimestampsToken] = -Infinity;
    }

    const sampleLen = generated.length - promptLen;
    if (sampleLen === 0) {
      for (const tid of this.beginSuppressTokens) {
        if (tid < vocabSize) scores[tid] = -Infinity;
      }
    }

    // WhisperTimeStampLogitsProcessor rules
    const lastWasTimestamp = generated.length > promptLen && generated[generated.length - 1] >= this.timestampBeginToken;
    const penultimateWasTimestamp =
      generated.length - 2 >= promptLen && generated[generated.length - 2] >= this.timestampBeginToken;

    if (sampleLen >= 2 && lastWasTimestamp) {
      if (penultimateWasTimestamp) {
        // Two timestamps in a row (END then START) -> next token MUST be non-timestamp (text or EOS)
        for (let t = this.timestampBeginToken; t < vocabSize; t++) scores[t] = -Infinity;
      } else {
        // Single END timestamp after text -> next token MUST be EOS or next segment's START timestamp
        for (let t = 0; t < this.eosToken; t++) {
          if (t < vocabSize) scores[t] = -Infinity;
        }
      }
    }

    // Timestamps must never go backwards; right after the opening START timestamp (sampleLen === 1),
    // allow advancing the start time or emitting text (never duplicate the exact same timestamp).
    let maxPrevTs = this.timestampBeginToken - 1;
    for (let i = promptLen; i < generated.length; i++) {
      if (generated[i] >= this.timestampBeginToken && generated[i] > maxPrevTs) {
        maxPrevTs = generated[i];
      }
    }
    const disallowUpTo = sampleLen >= 2 && lastWasTimestamp && !penultimateWasTimestamp ? maxPrevTs - 1 : maxPrevTs;
    for (let t = this.timestampBeginToken; t <= disallowUpTo && t < vocabSize; t++) {
      scores[t] = -Infinity;
    }

    // Force initial timestamp at step 0 <= maxInitialTimestamp (1.0s = idx 50)
    if (sampleLen === 0) {
      const cap = Math.min(vocabSize, this.timestampBeginToken + maxInitialTimestampIdx + 1);
      for (let t = 0; t < this.timestampBeginToken; t++) scores[t] = -Infinity;
      for (let t = cap; t < vocabSize; t++) scores[t] = -Infinity;
    } else if (sampleLen === 1) {
      // Opening start timestamp already emitted: allow speech tokens or advancing past opening silence
      const textLogProb = logSumExp(scores, 0, Math.min(vocabSize, this.timestampBeginToken));
      const tsLogProb = logSumExp(scores, this.timestampBeginToken, vocabSize);
      if (tsLogProb > textLogProb) {
        for (let t = 0; t < this.timestampBeginToken; t++) scores[t] = -Infinity;
      }
    } else {
      const textLogProb = logSumExp(scores, 0, Math.min(vocabSize, this.timestampBeginToken));
      const tsLogProb = logSumExp(scores, this.timestampBeginToken, vocabSize);
      if (tsLogProb > textLogProb) {
        for (let t = 0; t < this.timestampBeginToken; t++) scores[t] = -Infinity;
      }
    }

    return argmaxRange(scores, 0, vocabSize);
  }

  /** Converts timestamped generated tokens from a 0..30s window into clean offset segments. */
  private tokensToSegments(
    tokens: number[],
    windowOffsetSec: number,
    windowDurationSec: number
  ): RawChunkSegment[] {
    const segments: RawChunkSegment[] = [];
    let currentStart = 0;
    let currentTokens: number[] = [];

    const flush = (endRelSec: number) => {
      if (currentTokens.length === 0) return;
      const text = this.tokenizer.decode(currentTokens, { skip_special_tokens: true }).trim();
      if (text) {
        const clampedStart = Math.max(0, Math.min(windowDurationSec, currentStart));
        const clampedEnd = Math.max(clampedStart + 0.1, Math.min(windowDurationSec, endRelSec));
        segments.push({
          startSec: Number((windowOffsetSec + clampedStart).toFixed(2)),
          endSec: Number((windowOffsetSec + clampedEnd).toFixed(2)),
          text,
        });
      }
      currentTokens = [];
    };

    for (const tok of tokens) {
      if (tok >= this.timestampBeginToken) {
        const relSec = (tok - this.timestampBeginToken) * 0.02;
        if (currentTokens.length > 0) {
          flush(relSec);
        }
        currentStart = relSec;
      } else if (tok !== this.eosToken && tok < this.noTimestampsToken) {
        currentTokens.push(tok);
      }
    }
    flush(windowDurationSec);
    return segments;
  }

  async transcribeWindow(
    pcm: Float32Array,
    opts: WhisperTranscribeOptions,
    signal?: AbortSignal
  ): Promise<RawChunkSegment[]> {
    // Skip silent windows immediately (prevents hallucination on dead air)
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
    const rms = pcm.length > 0 ? Math.sqrt(sumSq / pcm.length) : 0;
    if (rms < 1e-4) return [];

    const mel = computeWhisperMelFeatures(pcm, this.melFilters, this.featureSize);
    const encOut = await this.encoder.run({
      input_features: new ort.Tensor("float32", mel, [1, this.featureSize, WHISPER_N_FRAMES]),
    });
    const encoderHidden = encOut.last_hidden_state;

    // Build decoder initial prompt tokens
    const prompt: number[] = [this.sotToken];
    let pastKv = this.emptyPastKeyValues();
    let useCache = false;

    if (this.transcribeToken !== null) {
      // Multilingual model
      let langTokenId: number | undefined;
      if (opts.language === "ar") {
        langTokenId = this.langTokenIds.get("ar");
        if (langTokenId === undefined) throw new Error("MODEL_LANGUAGE_UNSUPPORTED:ar");
      } else if (opts.language === "en") {
        langTokenId = this.langTokenIds.get("en");
      } else {
        // Auto-detect language via single SOT pass over language token probabilities
        const step = await this.runDecoderStep([this.sotToken], encoderHidden, pastKv, false);
        pastKv = step.nextKv;
        useCache = true;
        let bestId = this.langTokenIds.get("en") ?? this.langTokenIds.values().next().value;
        let bestScore = -Infinity;
        for (const tid of this.langTokenIds.values()) {
          if (tid < step.vocabSize && step.logits[tid] > bestScore) {
            bestScore = step.logits[tid];
            bestId = tid;
          }
        }
        langTokenId = bestId;
      }
      if (langTokenId !== undefined) prompt.push(langTokenId);
      prompt.push(this.transcribeToken);
    }

    const generated = [...prompt];
    const maxTokens = Math.min(256, this.maxTargetPositions - prompt.length);

    let lastLogits: Float32Array;
    let vocabSize: number;

    if (useCache) {
      // Auto-detect already evaluated [sotToken] -> feed remaining prompt [langToken, transcribeToken]
      const tail = prompt.slice(1);
      const step = await this.runDecoderStep(tail, encoderHidden, pastKv, true);
      pastKv = step.nextKv;
      lastLogits = step.logits;
      vocabSize = step.vocabSize;
    } else {
      const step = await this.runDecoderStep(prompt, encoderHidden, pastKv, false);
      pastKv = step.nextKv;
      lastLogits = step.logits;
      vocabSize = step.vocabSize;
    }

    for (let stepIdx = 0; stepIdx < maxTokens; stepIdx++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const nextTok = this.pickNextToken(lastLogits, vocabSize, generated, prompt.length, 50);
      if (nextTok === this.eosToken) break;
      generated.push(nextTok);

      const decStep = await this.runDecoderStep([nextTok], encoderHidden, pastKv, true);
      pastKv = decStep.nextKv;
      lastLogits = decStep.logits;
      vocabSize = decStep.vocabSize;
    }

    return this.tokensToSegments(generated.slice(prompt.length), opts.windowOffsetSec, opts.windowDurationSec);
  }
}
