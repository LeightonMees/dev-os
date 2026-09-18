import { useStore } from "../lib/store.tsx";

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)} role="status">
          {t.text}
        </div>
      ))}
    </div>
  );
}
