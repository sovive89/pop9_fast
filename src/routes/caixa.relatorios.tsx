import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { brl } from "@/lib/format";
import { getReportsOverview } from "@/lib/reports.functions";

// Ver o comentário em caixa.crm.clientes.tsx: import estático desse componente nas duas rotas
// gerava chunks circulares no servidor e derrubava a produção inteira.
const SegmentDistributionChart = lazy(() =>
  import("@/components/shared/SegmentDistributionChart").then((m) => ({
    default: m.SegmentDistributionChart,
  })),
);

export const Route = createFileRoute("/caixa/relatorios")({
  head: () => ({
    meta: [
      { title: "Relatórios Vendas | Pop9 Fast" },
      {
        name: "description",
        content: "Faturamento, ticket médio, produtos mais vendidos e formas de pagamento.",
      },
    ],
  }),
  component: Reports,
});

type Overview = {
  totalRevenue: number;
  paidSessionsCount: number;
  averageTicket: number;
  crmDiscountTotal: number;
  crmDiscountSessions: number;
  totalCost: number;
  grossProfit: number;
  cmvPercent: number;
  marginPercent: number;
  revenueWithoutCost: number;
  missingCostProducts: string[];
  revenueByDay: { date: string; revenue: number }[];
  revenueByMethod: { method: string; revenue: number }[];
  revenueByCategory: { category: string; revenue: number; cost: number; profit: number }[];
  revenueByHour: { hour: number; revenue: number }[];
  topProducts: {
    name: string;
    quantity: number;
    revenue: number;
    cost: number;
    profit: number;
    marginPercent: number;
  }[];
  customerMix: {
    newRevenue: number;
    returningRevenue: number;
    walkInRevenue: number;
    newCount: number;
    returningCount: number;
  };
  segmentCounts: Record<string, number>;
  revenueBySegment: Record<string, number>;
};

const PERIODS = [
  { id: "today", label: "Hoje", days: 1 },
  { id: "7d", label: "7 dias", days: 7 },
  { id: "30d", label: "30 dias", days: 30 },
] as const;

const PAYMENT_LABEL: Record<string, string> = {
  dinheiro: "Dinheiro",
  cartao: "Cartão",
  pix: "Pix",
};

function formatDayLabel(date: string) {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

function rangeFor(days: number) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

function Reports() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("7d");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useServerFn(getReportsOverview);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      const days = PERIODS.find((p) => p.id === period)?.days ?? 7;
      const result = await load({ data: rangeFor(days) });
      if (!cancelled) {
        setOverview(result as Overview);
        setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [period, load]);

  const chartData = useMemo(
    () =>
      (overview?.revenueByDay ?? []).map((row) => ({
        ...row,
        label: formatDayLabel(row.date),
      })),
    [overview],
  );

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          Relatórios Vendas
        </p>
        <h1 className="mt-1 text-3xl font-bold">Faturamento</h1>
      </div>

      <div className="mt-5 flex gap-2">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${
              period === p.id
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading || !overview ? (
        <p className="mt-6 text-sm text-muted-foreground">Carregando relatório...</p>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Faturamento</p>
              <p className="mt-1 text-lg font-bold">{brl(overview.totalRevenue)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Lançamentos pagos</p>
              <p className="mt-1 text-lg font-bold">{overview.paidSessionsCount}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Ticket médio</p>
              <p className="mt-1 text-lg font-bold">{brl(overview.averageTicket)}</p>
            </div>
          </div>

          {/* CMV e margem: o que sobra depois de pagar a mercadoria. Sem isso, faturamento alto
              com margem ruim passa despercebido. */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold">CMV e margem</p>
              <span className="text-xs text-muted-foreground">
                custo da mercadoria vendida
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">CMV</p>
                <p className="mt-0.5 text-lg font-bold">{brl(overview.totalCost)}</p>
                <p className="text-xs text-muted-foreground">
                  {overview.cmvPercent.toFixed(1)}% da venda
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Lucro bruto</p>
                <p
                  className={`mt-0.5 text-lg font-bold ${overview.grossProfit < 0 ? "text-destructive" : "text-emerald-500"}`}
                >
                  {brl(overview.grossProfit)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {overview.marginPercent.toFixed(1)}% de margem
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Faturamento</p>
                <p className="mt-0.5 text-lg font-bold">{brl(overview.totalRevenue)}</p>
              </div>
            </div>
            {overview.revenueWithoutCost > 0 && (
              <p className="mt-3 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-500">
                ⚠ {brl(overview.revenueWithoutCost)} vendidos sem custo cadastrado — o CMV real é
                maior e a margem, menor. Registre o custo na entrada de estoque de:{" "}
                {overview.missingCostProducts.join(", ")}.
              </p>
            )}
            {overview.crmDiscountTotal > 0 && (
              <p className="mt-3 rounded-lg border border-dashed border-primary/30 bg-primary/5 p-2.5 text-xs text-muted-foreground">
                🎁 {brl(overview.crmDiscountTotal)} em desconto de boas-vindas do CRM, em{" "}
                {overview.crmDiscountSessions}{" "}
                {overview.crmDiscountSessions === 1 ? "lançamento" : "lançamentos"} — já saiu do dinheiro
                que entrou no caixa, mas não mexe no CMV/margem acima (é custo de aquisição de
                cliente, não do produto).
              </p>
            )}
          </div>

          {/* Novo x recorrente: diz se o faturamento vem de gente nova (que exige tráfego pago
              todo mês) ou de quem já volta sozinho. */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold">De onde veio o faturamento</p>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>
                  Clientes novos{" "}
                  <span className="text-muted-foreground">
                    · {overview.customerMix.newCount}
                  </span>
                </span>
                <span className="shrink-0 font-semibold">{brl(overview.customerMix.newRevenue)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>
                  Clientes que voltaram{" "}
                  <span className="text-muted-foreground">
                    · {overview.customerMix.returningCount}
                  </span>
                </span>
                <span className="shrink-0 font-semibold">
                  {brl(overview.customerMix.returningRevenue)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>
                  Balcão <span className="text-muted-foreground">· sem cadastro</span>
                </span>
                <span className="shrink-0 font-semibold">
                  {brl(overview.customerMix.walkInRevenue)}
                </span>
              </div>
            </div>
          </div>

          {/* Distribuição de segmentos: mesma cor por segmento do CRM, pra quem olha os dois
              lugares reconhecer o padrão sem reler a legenda. */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold">Base de clientes por segmento</p>
            <Suspense fallback={<div className="mt-3 h-24" />}>
              <SegmentDistributionChart
                values={overview.segmentCounts}
                emptyLabel="Sem clientes classificados ainda."
              />
            </Suspense>
          </div>

          {/* Cruza segmento com dinheiro: "quantos clientes" já tava acima, isso mostra quem
              sustenta o caixa em R$ — cliente novo pode ser maioria em contagem e minoria em
              faturamento, ou o contrário. Lançamento de balcão não entra, não tem cliente pra somar. */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold">Faturamento por segmento</p>
            <Suspense fallback={<div className="mt-3 h-24" />}>
              <SegmentDistributionChart
                values={overview.revenueBySegment}
                formatValue={brl}
                emptyLabel="Sem lançamentos de cliente cadastrado nesse período."
              />
            </Suspense>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold">Faturamento por dia</p>
            {chartData.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Nenhum lançamento pago nesse período.
              </p>
            ) : (
              <div className="mt-3 h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip
                      formatter={(value: number) => brl(value)}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="revenue" fill="var(--primary)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="text-sm font-semibold">Produtos mais vendidos</p>
            {overview.topProducts.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Sem vendas nesse período.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {overview.topProducts.map((product) => (
                  <li key={product.name} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {product.name}{" "}
                      <span className="text-muted-foreground">· {product.quantity}x</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="font-semibold">{brl(product.revenue)}</span>
                      {product.cost > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          lucro {brl(product.profit)} · {product.marginPercent.toFixed(0)}%
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-semibold">Por categoria</p>
              {overview.revenueByCategory.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">Sem dados.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {overview.revenueByCategory.map((row) => (
                    <li key={row.category} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">{row.category}</span>
                      <span className="shrink-0 text-right">
                        <span className="font-semibold">{brl(row.revenue)}</span>
                        {row.cost > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            lucro {brl(row.profit)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-semibold">Por pagamento</p>
              {overview.revenueByMethod.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">Sem dados.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {overview.revenueByMethod.map((row) => (
                    <li key={row.method} className="flex items-center justify-between text-sm">
                      <span className="truncate">{PAYMENT_LABEL[row.method] ?? row.method}</span>
                      <span className="shrink-0 font-semibold">{brl(row.revenue)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Horário de pico: onde concentrar equipe, e em que faixa vale anunciar promoção. */}
          {overview.revenueByHour.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-sm font-semibold">Movimento por hora</p>
              <div className="mt-3 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={overview.revenueByHour.map((row) => ({
                      ...row,
                      label: `${String(row.hour).padStart(2, "0")}h`,
                    }))}
                    margin={{ left: -20 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip
                      formatter={(value: number) => brl(value)}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="revenue" fill="var(--primary)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
