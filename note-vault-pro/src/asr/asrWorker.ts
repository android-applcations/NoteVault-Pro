// Dedicated Web Worker for local Whisper ONNX inference (zero network requests).
import type { AsrModelRecord } from "@/data/types";
import type { RawChunkSegment } from "./chunkMerge";
import { WhisperSession } from "./whisperInference";

export type AsrWorkerRequest =
  | {
      type: "init";
      id: number;
      model: AsrModelRecord;
      wasmBaseUrl: string;
    }
  | {
      type: "transcribe-window";
      id: number;
      pcm: Float32Array;
      language: "auto" | "ar" | "en";
      windowOffsetSec: number;
      windowDurationSec: number;
    }
  | {
      type: "dispose";
      id: number;
    };

export type AsrWorkerResponse =
  | { id: number; ok: true; segments?: RawChunkSegment[] }
  | { id: number; ok: false; error: string };

let session: WhisperSession | null = null;
let loadedModelKey = "";

self.onmessage = async (event: MessageEvent<AsrWorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      const nextKey = `${msg.model.id}:${msg.model.updatedAt}`;
      if (!session || loadedModelKey !== nextKey) {
        if (session) await session.dispose();
        session = await WhisperSession.createFromCache(msg.model, msg.wasmBaseUrl);
        loadedModelKey = nextKey;
      }
      self.postMessage({ id: msg.id, ok: true } satisfies AsrWorkerResponse);
      return;
    }

    if (msg.type === "transcribe-window") {
      if (!session) throw new Error("ASR_WORKER_NOT_INITIALIZED");
      const segments = await session.transcribeWindow(msg.pcm, {
        language: msg.language,
        windowOffsetSec: msg.windowOffsetSec,
        windowDurationSec: msg.windowDurationSec,
      });
      self.postMessage({ id: msg.id, ok: true, segments } satisfies AsrWorkerResponse);
      return;
    }

    if (msg.type === "dispose") {
      if (session) {
        await session.dispose();
        session = null;
        loadedModelKey = "";
      }
      self.postMessage({ id: msg.id, ok: true } satisfies AsrWorkerResponse);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ id: msg.id, ok: false, error: message } satisfies AsrWorkerResponse);
  }
};
