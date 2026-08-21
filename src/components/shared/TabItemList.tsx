import { useState } from "react";
import { PasswordConfirm } from "@/components/shared/PasswordConfirm";
import { brl, hhmm } from "@/lib/format";
import type { BarTabItem } from "@/types/fastbar";

export function TabItemList({
  items,
  onRemove,
}: {
  items: BarTabItem[];
  onRemove?: (itemId: string, password: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
        Nenhum item lançado ainda.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
      {items.map((item) => (
        <li key={item.id} className="px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {item.quantity}× {item.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {hhmm(item.added_at)} · {brl(Number(item.unit_price))} un.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">
                {brl(Number(item.unit_price) * item.quantity)}
              </span>
              {onRemove && (
                <button
                  onClick={() => setConfirmingId(confirmingId === item.id ? null : item.id)}
                  aria-label={`Remover ${item.name}`}
                  className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-destructive"
                >
                  remover
                </button>
              )}
            </div>
          </div>

          {onRemove && confirmingId === item.id && (
            <div className="mt-2">
              <PasswordConfirm
                message={`Remover "${item.name}" do lançamento? Confirme com a senha da equipe.`}
                confirmLabel="Remover"
                onCancel={() => setConfirmingId(null)}
                onConfirm={async (password) => {
                  const result = await onRemove(item.id, password);
                  if (result.ok) setConfirmingId(null);
                  return result;
                }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
