// Presentation layer – global UI services: toasts, confirm dialogs, quick capture, card editor.
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { CardSource, CardType } from "@/data/types";
import { Button, Modal } from "./kit";
import { useI18n } from "./i18n";

export interface CardPrefill {
  front?: string;
  back?: string;
  type?: CardType;
  source?: CardSource;
  subjectId?: string;
  imageId?: string;
}
interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "err" | "info";
  action?: { label: string; run: () => void };
}
interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}
interface AppCtx {
  toast: (msg: string, kind?: Toast["kind"], action?: Toast["action"]) => void;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  quickOpen: boolean;
  setQuickOpen: (v: boolean) => void;
  cardPrefill: CardPrefill | null;
  openCard: (p?: CardPrefill) => void;
  closeCard: () => void;
}
const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [cardPrefill, setCardPrefill] = useState<CardPrefill | null>(null);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const idRef = useRef(0);

  const toast = useCallback((msg: string, kind: Toast["kind"] = "ok", action?: Toast["action"]) => {
    const id = ++idRef.current;
    setToasts((c) => [...c.slice(-3), { id, msg, kind, action }]);
    setTimeout(() => setToasts((c) => c.filter((x) => x.id !== id)), action ? 9000 : kind === "err" ? 7000 : 3200);
  }, []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })), []);
  const value = useMemo<AppCtx>(
    () => ({ toast, confirm, quickOpen, setQuickOpen, cardPrefill, openCard: (p) => setCardPrefill(p ?? {}), closeCard: () => setCardPrefill(null) }),
    [toast, confirm, quickOpen, cardPrefill]
  );
  const done = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[120] flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite" role="status">
        <AnimatePresence>
          {toasts.map((x) => (
            <motion.div key={x.id} layout initial={{ opacity: 0, y: 20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
              className="pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm font-semibold shadow-xl">
              {x.kind === "ok" ? <CheckCircle2 className="shrink-0 text-success" size={18} /> : x.kind === "err" ? <AlertTriangle className="shrink-0 text-danger" size={18} /> : <Info className="shrink-0 text-accent" size={18} />}
              <span>{x.msg}</span>
              {x.action && <button className="ms-2 rounded-lg bg-primary px-3 py-1 text-xs font-bold text-primary-fg" onClick={() => { x.action!.run(); setToasts((c) => c.filter((y) => y.id !== x.id)); }}>{x.action.label}</button>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <Modal
        open={!!confirmState} onClose={() => done(false)} title={confirmState?.title ?? ""}
        footer={<>
          <Button onClick={() => done(false)}>{t("إلغاء", "Cancel")}</Button>
          <Button data-autofocus variant={confirmState?.danger ? "danger" : "primary"} onClick={() => done(true)}>{confirmState?.confirmLabel ?? t("تأكيد", "Confirm")}</Button>
        </>}
      >
        {confirmState?.message && <p className="text-sm text-muted">{confirmState.message}</p>}
      </Modal>
    </Ctx.Provider>
  );
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppProvider missing");
  return c;
}
