import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TabItemList } from "@/components/shared/TabItemList";
import { ProductPicker } from "@/features/register/components/ProductPicker";
import { useLiveTab } from "@/hooks/use-live-tab";
import { brl, elapsed, formatPhone, hhmm } from "@/lib/format";
import {
  addTabItem,
  closeSession,
  confirmSession,
  registerPayment,
  removeTabItem,
  reopenSession,
  type PaymentMethod,
} from "@/lib/register.functions";
import { fetchProducts } from "@/services/supabase/products";
import { tabTotal, tabTotalWithDiscount } from "@/services/supabase/tabItems";
import type { BarProduct } from "@/types/fastbar";

export const Route = createFileRoute("/caixa/$sessionId")({
  head: () => ({
    meta: [
      { title: "Detalhe do lançamento | Caixa Pop9 Fast" },
      {
        name: "description",
        content: "Lance itens, feche o lançamento e registre o pagamento do cliente.",
      },
      { property: "og:title", content: "Detalhe do lançamento | Caixa Pop9 Fast" },
      {
        property: "og:description",
        content: "Lançamento de itens, fechamento e pagamento.",
      },
    ],
  }),
  component: RegisterTabDetail,
});

function RegisterTabDetail() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const { session, items, loading, now, reload } = useLiveTab(sessionId, "register");
  const [products, setProducts] = useState<BarProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("dinheiro");

  const add = useServerFn(addTabItem);
  const remove = useServerFn(removeTabItem);
  const close = useServerFn(closeSession);
  const pay = useServerFn(registerPayment);
  const reopen = useServerFn(reopenSession);
  const confirm = useServerFn(confirmSession);

  useEffect(() => {
    void fetchProducts().then(setProducts);
    // Sem isso, um produto criado depois que esse lançamento já estava aberto na tela nunca
    // aparecia pra lançar — a lista só carregava uma vez, no primeiro acesso à página.
    const poll = setInterval(() => void fetchProducts().then(setProducts), 15000);
    return () => clearInterval(poll);
  }, []);

  async function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.message ?? "Ação não concluída.");
    await reload();
    setBusy(false);
    return result.ok;
  }

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">Carregando lançamento...</p>;
  }

  if (!session) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold">Lançamento não encontrado</h1>
        <Link to="/caixa" className="mt-4 inline-block text-sm text-primary underline">
          Voltar aos lançamentos
        </Link>
      </main>
    );
  }

  const isOpen = session.status === "open";
  const isPending = session.status === "pending";

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <Link to="/caixa" className="text-sm text-muted-foreground underline underline-offset-4">
        ← Voltar aos lançamentos
      </Link>

      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{session.customer_name}</h1>
          <p className="text-xs text-muted-foreground">
            {formatPhone(session.phone)}
            {session.started_at ? ` · abertura ${hhmm(session.started_at)}` : ""} ·{" "}
            {elapsed(session.started_at, session.closed_at ?? session.paid_at, now)}
          </p>
        </div>
        <StatusBadge status={session.status} />
      </div>

      <div className="mt-5 rounded-2xl border border-border bg-card p-5">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Total do lançamento</p>
        {session.discount_percent ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground line-through">{brl(tabTotal(items))}</p>
            <p className="text-3xl font-bold">
              {brl(tabTotalWithDiscount(items, session.discount_percent))}
            </p>
            <p className="mt-1 text-xs font-medium text-success">
              {session.discount_percent}% de desconto de boas-vindas (cliente novo, cadastro completo)
            </p>
          </>
        ) : (
          <p className="mt-1 text-3xl font-bold">{brl(tabTotal(items))}</p>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

      {isOpen && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Lançamentos</h2>
          <div className="mt-3">
            <ProductPicker
              products={products}
              disabled={busy}
              onPick={(product) =>
                void run(() => add({ data: { sessionId: session.id, productId: product.id } }))
              }
            />
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Itens do lançamento</h2>
        <div className="mt-3">
          <TabItemList
            items={items}
            {...(isOpen
              ? {
                  onRemove: async (itemId: string, password: string) => {
                    const result = await remove({ data: { itemId, password } });
                    if (result.ok) await reload();
                    return result;
                  },
                }
              : {})}
          />
        </div>
      </section>

      <section className="mt-8 space-y-3">
        {isPending && (
          <button
            onClick={() => void run(() => confirm({ data: { sessionId: session.id } }))}
            disabled={busy}
            className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-soft disabled:opacity-60"
          >
            {busy ? "Confirmando..." : "Confirmar lançamento"}
          </button>
        )}

        {isOpen && (
          <button
            onClick={() => void run(() => close({ data: { sessionId: session.id } }))}
            disabled={busy}
            className="h-12 w-full rounded-xl border border-border text-base font-semibold disabled:opacity-60"
          >
            Fechar lançamento
          </button>
        )}

        {!isPending && session.status !== "paid" && (
          <>
            <div className="flex gap-2">
              {(
                [
                  ["dinheiro", "Dinheiro"],
                  ["cartao", "Cartão"],
                  ["pix", "Pix"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setPaymentMethod(value)}
                  disabled={busy}
                  className={`h-10 flex-1 rounded-xl text-sm font-medium disabled:opacity-60 ${
                    paymentMethod === value
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={async () => {
                const ok = await run(() =>
                  pay({ data: { sessionId: session.id, method: paymentMethod } }),
                );
                if (ok) await navigate({ to: "/caixa" });
              }}
              disabled={busy}
              className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-soft disabled:opacity-60"
            >
              Registrar pagamento
            </button>
          </>
        )}

        {!isPending && !isOpen && session.status !== "paid" && (
          <button
            onClick={() => void run(() => reopen({ data: { sessionId: session.id } }))}
            disabled={busy}
            className="h-12 w-full rounded-xl border border-border text-sm font-medium text-muted-foreground disabled:opacity-60"
          >
            Reabrir lançamento
          </button>
        )}
      </section>
    </main>
  );
}
