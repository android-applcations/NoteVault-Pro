import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const ASSETS = [
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "public/asr/ort-wasm-simd-threaded.mjs"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "public/asr/ort-wasm-simd-threaded.wasm"],
];

export function ensureAsrAssets() {
  const destDir = path.join(ROOT, "public/asr");
  mkdirSync(destDir, { recursive: true });
  for (const [srcRel, dstRel] of ASSETS) {
    const src = path.join(ROOT, srcRel);
    const dst = path.join(ROOT, dstRel);
    if (!existsSync(src)) {
      throw new Error(`Missing ASR runtime asset in node_modules: ${srcRel}`);
    }
    const needCopy = !existsSync(dst) || statSync(src).size !== statSync(dst).size;
    if (needCopy) {
      copyFileSync(src, dst);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  ensureAsrAssets();
  console.log("Copied offline ASR WASM runtime assets to public/asr/");
}
