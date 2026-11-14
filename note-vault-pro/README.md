# NoteVault Pro — الخزنة الذكية للملاحظات والمعرفة الجامعية
Offline-first academic vault: React 19, Vite, strict TypeScript, Tailwind 4, Dexie/IndexedDB, Tiptap, PDF.js, MiniSearch, FSRS. Data never leaves the device (no account, server, analytics or CDN).

`npm run dev` · `npm run build` (→ `dist/index.html` single file + `public/` assets) · `npm test` (22 Vitest tests) · `npx playwright test` (needs `npx playwright install chromium`).

Layers: presentation (`src/pages`, `src/ui`, `src/editor`) · services (`src/services`) · domain (`src/domain`) · data (`src/data`) · file processing (`src/files`) · search (`src/services/search.ts`) · security (`src/domain/sanitize.ts`, `src/files/validate.ts`, backup validator, CSP meta) · PWA (`public/sw.js`, manifest, `src/pwa.ts`).
Docs: `docs/*.md`.
