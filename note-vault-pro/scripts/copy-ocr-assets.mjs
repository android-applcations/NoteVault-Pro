import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const ASSETS = [
  ["node_modules/tesseract.js/dist/worker.min.js", "public/ocr/worker.min.js"],
  ["node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "public/ocr/tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "public/ocr/tesseract-core-simd-lstm.wasm.js"],
  ["node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", "public/ocr/tesseract-core-lstm.wasm.js"],
  ["node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "public/ocr/eng.traineddata.gz"],
  ["node_modules/@tesseract.js-data/ara/4.0.0_best_int/ara.traineddata.gz", "public/ocr/ara.traineddata.gz"],
];

export function ensureOcrAssets() {
  const destDir = path.join(ROOT, "public/ocr");
  mkdirSync(destDir, { recursive: true });
  for (const [srcRel, dstRel] of ASSETS) {
    const src = path.join(ROOT, srcRel);
    const dst = path.join(ROOT, dstRel);
    if (!existsSync(src)) {
      throw new Error(`Missing OCR asset in node_modules: ${srcRel}`);
    }
    const needCopy = !existsSync(dst) || statSync(src).size !== statSync(dst).size;
    if (needCopy) {
      copyFileSync(src, dst);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  ensureOcrAssets();
  console.log("Copied offline OCR assets to public/ocr/");
}
