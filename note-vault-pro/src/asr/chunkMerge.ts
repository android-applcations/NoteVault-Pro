// Overlap deduplication & cleanup for chunked Whisper ASR segments.

export interface RawChunkSegment {
  startSec: number;
  endSec: number;
  text: string;
}

const ARABIC_DIACRITICS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

function normalizeTokenForMatch(word: string): string {
  return word
    .toLowerCase()
    .replace(ARABIC_DIACRITICS_RE, "")
    .replace(/[\u0622\u0623\u0625]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/[.,!?;:"'()[\]{}\u060C\u061B\u061F]/g, "")
    .trim();
}

/** Collapses degenerate Whisper n-gram hallucinations (e.g., repeating same 1-4 words >= 4 times). */
export function collapseWhisperRepetitions(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return words.join(" ");

  for (let gram = 1; gram <= 4; gram++) {
    if (words.length < gram * 4) continue;
    const out: string[] = [];
    let i = 0;
    while (i < words.length) {
      if (i + gram <= words.length) {
        const pattern = words.slice(i, i + gram).map(normalizeTokenForMatch).join(" ");
        let repeats = 1;
        while (
          pattern.length > 0 &&
          i + (repeats + 1) * gram <= words.length &&
          words
            .slice(i + repeats * gram, i + (repeats + 1) * gram)
            .map(normalizeTokenForMatch)
            .join(" ") === pattern
        ) {
          repeats += 1;
        }
        if (repeats >= 4) {
          out.push(...words.slice(i, i + gram));
          i += repeats * gram;
          continue;
        }
      }
      out.push(words[i]);
      i += 1;
    }
    words.splice(0, words.length, ...out);
  }
  return words.join(" ").trim();
}

/** Strips overlapping suffix/prefix words between consecutive ASR segments. */
export function deduplicateOverlapText(prevText: string, nextText: string, maxOverlapWords = 14): string {
  const cleanPrev = prevText.trim();
  const cleanNext = nextText.trim();
  if (!cleanPrev || !cleanNext) return cleanNext;

  const prevWords = cleanPrev.split(/\s+/);
  const nextWords = cleanNext.split(/\s+/);
  const prevNorm = prevWords.map(normalizeTokenForMatch);
  const nextNorm = nextWords.map(normalizeTokenForMatch);

  const maxCheck = Math.min(maxOverlapWords, prevNorm.length, nextNorm.length);
  for (let len = maxCheck; len >= 2; len--) {
    let matched = true;
    for (let k = 0; k < len; k++) {
      if (!prevNorm[prevNorm.length - len + k] || prevNorm[prevNorm.length - len + k] !== nextNorm[k]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return nextWords.slice(len).join(" ").trim();
    }
  }
  return cleanNext;
}

/**
 * Merges segments produced across overlapping PCM windows into clean, chronological segments.
 * Discards duplicate prefix text and clamps start times strictly >= previous end where overlapped.
 */
export function mergeWindowSegments(
  windows: Array<{ windowIndex: number; segments: RawChunkSegment[] }>
): RawChunkSegment[] {
  const merged: RawChunkSegment[] = [];
  for (const w of windows) {
    for (const seg of w.segments) {
      const cleaned = collapseWhisperRepetitions(seg.text);
      if (!cleaned) continue;
      if (merged.length === 0) {
        merged.push({
          startSec: Math.max(0, Number(seg.startSec.toFixed(2))),
          endSec: Math.max(seg.startSec + 0.1, Number(seg.endSec.toFixed(2))),
          text: cleaned,
        });
        continue;
      }
      const prev = merged[merged.length - 1];
      // Skip segments whose timestamp lies strictly inside the previous segment's non-overlap tail
      if (seg.endSec <= prev.endSec - 0.15) {
        continue;
      }
      const deduped = deduplicateOverlapText(prev.text, cleaned);
      if (!deduped) continue;

      const startSec = Math.max(prev.endSec, seg.startSec);
      const endSec = Math.max(startSec + 0.1, seg.endSec);
      merged.push({
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
        text: deduped,
      });
    }
  }
  return merged;
}
