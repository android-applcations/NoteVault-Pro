import katex from "katex";
import "katex/dist/katex.min.css";
import { useEffect, useRef } from "react";
import { cn } from "@/utils/cn";

const MAX_TEX_LENGTH = 2000;

export function FormulaView({
  tex,
  displayMode = false,
  className,
}: {
  tex: string;
  displayMode?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clean = (tex ?? "").trim().slice(0, MAX_TEX_LENGTH);
    if (!clean) {
      el.replaceChildren();
      return;
    }
    try {
      katex.render(clean, el, {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxExpand: 200,
        maxSize: 10,
      });
    } catch {
      el.textContent = clean;
    }
  }, [tex, displayMode]);

  return (
    <span
      ref={ref}
      dir="ltr"
      className={cn(
        "nv-selectable",
        displayMode ? "block max-w-full overflow-x-auto py-1 text-center" : "inline-block align-middle",
        className
      )}
    />
  );
}

const MATH_SPLIT_RE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;

export function FormulaText({ text, className }: { text: string; className?: string }) {
  const parts = (text ?? "").split(MATH_SPLIT_RE);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (part.startsWith("$$") && part.endsWith("$$") && part.length > 4) {
          return <FormulaView key={i} tex={part.slice(2, -2)} displayMode />;
        }
        if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
          return <FormulaView key={i} tex={part.slice(1, -1)} />;
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}
