import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { ensureOcrAssets } from "./scripts/copy-ocr-assets.mjs";
import { generateIcons } from "./scripts/make-icons.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function walkFiles(rootDir: string, rel = ""): string[] {
  const full = path.join(rootDir, rel);
  const out: string[] = [];
  for (const name of readdirSync(full).sort()) {
    const childRel = rel ? `${rel}/${name}` : name;
    const childFull = path.join(rootDir, childRel);
    const st = statSync(childFull);
    if (st.isDirectory()) {
      out.push(...walkFiles(rootDir, childRel));
    } else if (st.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

function pwaManifestAndPrecachePlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "nv-pwa-precache",
    configResolved(cfg) {
      outDir = cfg.build.outDir || "dist";
    },
    buildStart() {
      generateIcons();
      ensureOcrAssets();
    },
    closeBundle() {
      const distDir = path.resolve(__dirname, outDir);
      const swPath = path.join(distDir, "sw.js");
      const manifestPath = path.join(distDir, "manifest.webmanifest");
      const indexPath = path.join(distDir, "index.html");
      if (!existsSync(swPath) || !existsSync(manifestPath) || !existsSync(indexPath)) return;

      // Verify manifest icons exist on disk
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        icons?: Array<{ src: string }>;
      };
      for (const ic of manifest.icons ?? []) {
        const clean = ic.src.replace(/^\.\//, "");
        if (!existsSync(path.join(distDir, clean))) {
          throw new Error(`PWA verification failed: manifest icon missing in dist: ${ic.src}`);
        }
      }

      // Collect all built files for precaching (exclude sw.js, source maps, and optional lazy ocr/* runtime packs)
      const files = walkFiles(distDir).filter(
        (rel) => rel !== "sw.js" && !rel.endsWith(".map") && !rel.startsWith("ocr/")
      );
      const hash = createHash("sha256");
      for (const rel of files) {
        hash.update(rel);
        hash.update(readFileSync(path.join(distDir, rel)));
      }
      const version = `nv-${hash.digest("hex").slice(0, 12)}`;
      const precache = ["./", ...files.map((rel) => `./${rel}`)];

      // Verify every precache entry resolves to a real file (except "./" -> index.html)
      for (const entry of precache) {
        if (entry === "./") continue;
        const target = path.join(distDir, entry.replace(/^\.\//, ""));
        if (!existsSync(target)) {
          throw new Error(`PWA verification failed: precache entry missing in dist: ${entry}`);
        }
      }

      let sw = readFileSync(swPath, "utf8");
      sw = sw.replace("__NV_SW_VERSION__", version);
      sw = sw.replace(
        /\/\* __NV_PRECACHE_BEGIN__ \*\/[\s\S]*?\/\* __NV_PRECACHE_END__ \*\//,
        JSON.stringify(precache, null, 2)
      );
      writeFileSync(swPath, sw, "utf8");
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), pwaManifestAndPrecachePlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
