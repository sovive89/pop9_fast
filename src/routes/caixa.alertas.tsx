import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { formatPhone } from "@/lib/format";
import { getStockReport } from "@/lib/base-drinks.functions";
import { getCrmAlerts } from "@/lib/customers.functions";
import { SEGMENT_LABEL, SEGMENT_STYLE, type LeadSegment } from "@/lib/crm";

export const Route = createFileRoute("/caixa/alertas")({
  head: () => ({
    meta: [{ title: "Alertas | Pop9 Fast" }],
  }),
  component: AlertsPage,
});

type StockAlerts = {
  lowStock: Array<{ id: string; name: string; unit: string; current: number; min: number; kind: string }>;
  outOfStockProducts: Array<{ id: string; name: string; category: string }>;
};

type CrmAlerts = {
  atRisk: Array<{ id: string; name: string; phone: string; segment: LeadSegment }>;
  birthdaysToday: Array<{ id: string; name: string; phone: string }>;
};

/**
 * Painel só de "o que precisa de atenção hoje" — cruza estoque (abaixo do mínimo, zerado) com CRM
 * (em risco/perdido, aniversariante do dia). Nenhum dado é recalculado aqui: reaproveita os mesmos
 * server functions do relatório de Estoque e do dashboard de CRM, só filtra pro que é acionável.
 */
function AlertsPage() {
  const [stock, setStock] = useState<StockAlerts | null>(null);
  const [crm, setCrm] = useState<CrmAlerts | null>(null);
  const loadStock = useServerFn(getStockReport);
  const loadCrm = useServerFn(getCrmAlerts);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const [stockResult, crmResult] = await Promise.all([loadStock(), loadCrm()]);
      if (!cancelled) {
        setStock(stockResult as StockAlerts);
        setCrm(crmResult as CrmAlerts);
      }
    }
    void run();
    const poll = setInterval(() => void run(), 20000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loading = !stock || !crm;
  const totalAlerts = loading
    ? 0
    : stock.lowStock.length +
      stock.outOfStockProducts.length +
      crm.atRisk.length +
      crm.birthdaysToday.length;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Alertas</p>
        <h1 className="mt-1 text-3xl font-bold">O que precisa de atenção</h1>
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-muted-foreground">Carregando alertas...</p>
      ) : totalAlerts === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          Nada pedindo atenção agora. 🎉
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          {crm.birthdaysToday.length > 0 && (
            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
              <p className="text-sm font-semibold">🎂 Aniversariantes de hoje</p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {crm.birthdaysToday.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="shrink-0 text-muted-foreground">{formatPhone(c.phone)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {stock.outOfStockProducts.length > 0 && (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-semibold">Produtos zerados</p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {stock.outOfStockProducts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{p.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{p.category}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {stock.lowStock.length > 0 && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm font-semibold">Estoque abaixo do mínimo</p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {stock.lowStock.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {item.name} <span className="text-muted-foreground">· {item.kind}</span>
                    </span>
                    <span className="shrink-0 font-semibold text-amber-500">
                      {item.current} / {item.min} {item.unit}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to="/caixa/estoque"
                className="mt-3 inline-block text-xs font-medium text-primary underline underline-offset-4"
              >
                Ir pro Estoque
              </Link>
            </div>
          )}

          {crm.atRisk.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-semibold">Clientes em risco ou perdidos</p>
              <ul className="mt-3 space-y-2">
                {crm.atRisk.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEGMENT_STYLE[c.segment]}`}
                    >
                      {SEGMENT_LABEL[c.segment]}
                    </span>
                  </li>
                ))}
              </ul>
              <Link
                to="/caixa/crm/clientes"
                className="mt-3 inline-block text-xs font-medium text-primary underline underline-offset-4"
              >
                Ir pro CRM
              </Link>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
