import { MoreVertical } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { useI18n } from "./i18n";
import { IconButton } from "./kit";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export function ActionMenu({ items, label }: { items: MenuItem[]; label?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <IconButton label={label ?? t("المزيد من الخيارات", "More options")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="h-9 w-9"><MoreVertical size={18} /></IconButton>
      {open && (
        <div role="menu" className="absolute end-0 top-full z-50 mt-1 min-w-44 overflow-hidden rounded-2xl border border-line bg-surface p-1 shadow-2xl">
          {items.map((i) => (
            <button key={i.label} role="menuitem" onClick={() => { setOpen(false); i.onClick(); }}
              className={cn("flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm font-semibold hover:bg-surface2", i.danger && "text-danger")}>
              {i.icon}{i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
