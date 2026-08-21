import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { PrimaryButton, SectionCard, TextField } from "@/components/stock/SharedFormFields";
import { brl, parseAmount } from "@/lib/format";
import {
  createFicha,
  deactivateFicha,
  getFichaComponentes,
  listFichas,
  listProducoes,
  registrarProducao,
} from "@/lib/production.functions";
import { listItems, listUnidades } from "@/lib/stock-items.functions";

export const Route = createFileRoute("/caixa/producao")({
  head: () => ({
    meta: [
      { title: "Produção | Pop9 Fast" },
      {
        name: "description",
        content: "Fichas técnicas, porcionamento e mise en place.",
      },
    ],
  }),
  component: ProductionOverview,
});

type Tab = "produzir" | "fichas" | "historico";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "produzir", label: "Produzir" },
  { id: "fichas", label: "Fichas técnicas" },
  { id: "historico", label: "Histórico" },
];

function ProductionOverview() {
  const [tab, setTab] = useState<Tab>("produzir");

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Produção</p>
        <h1 className="mt-1 text-3xl font-bold">Mise en place</h1>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium ${
              tab === item.id
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "produzir" && <ProduzirTab />}
        {tab === "fichas" && <FichasTab />}
        {tab === "historico" && <HistoricoTab />}
      </div>
    </main>
  );
}

// ============================================================
// Aba: Produzir
// ============================================================

type Ficha = {
  id: string;
  rendimento_quantidade: number;
  modo_preparo: string | null;
  ativa: boolean;
  item_produzido: { id: string; nome: string; tipo: string; unidade_estoque_id: string } | null;
  rendimento_unidade: { codigo: string; nome: string } | null;
};

type Componente = {
  id: string;
  quantidade: number;
  item: { id: string; nome: string; estoque_atual: number; unidade_estoque_id: string } | null;
  unidade: { codigo: string; nome: string } | null;
};

function ProduzirTab() {
  const [fichas, setFichas] = useState<Ficha[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [componentes, setComponentes] = useState<Componente[]>([]);
  const [lotes, setLotes] = useState("1");
  const [validade, setValidade] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadFichas = useServerFn(listFichas);
  const loadComponentes = useServerFn(getFichaComponentes);
  const registrar = useServerFn(registrarProducao);

  useEffect(() => {
    loadFichas()
      .then((r) => setFichas(r.fichas as Ficha[]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setComponentes([]);
      return;
    }
    void loadComponentes({ data: { fichaId: selectedId } }).then((r) =>
      setComponentes(r.componentes as Componente[]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selected = fichas.find((f) => f.id === selectedId);
  const lotesNum = parseAmount(lotes) ?? 0;

  async function handleRegistrar() {
    if (!selectedId || lotesNum <= 0) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const result = await registrar({
      data: { fichaId: selectedId, lotes: lotesNum, validade: validade || undefined },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSuccess(
      `Produzido: ${result.quantidadeProduzida} ${selected?.rendimento_unidade?.codigo ?? ""} · custo ${brl(result.custoTotal)}.`,
    );
    setLotes("1");
    setValidade("");
    // Recarrega pra refletir o novo estoque do item produzido, se ele mesmo estiver na lista de
    // componentes de outra ficha visualizada em seguida.
    const { fichas: reloaded } = await loadFichas();
    setFichas(reloaded as Ficha[]);
  }

  if (loading) return <p className="text-sm text-muted-foreground">Carregando...</p>;

  if (fichas.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhuma ficha técnica ativa ainda. Crie uma na aba "Fichas técnicas" antes de produzir.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Ficha técnica</span>
        <select
          value={selectedId ?? ""}
          onChange={(e) => {
            setSelectedId(e.target.value || null);
            setSuccess(null);
            setError(null);
          }}
          className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
        >
          <option value="">Selecione...</option>
          {fichas.map((f) => (
            <option key={f.id} value={f.id}>
              {f.item_produzido?.nome} — rende {f.rendimento_quantidade} {f.rendimento_unidade?.codigo}
            </option>
          ))}
        </select>
      </label>

      {selected && (
        <SectionCard title="Componentes (por lote)">
          {componentes.length === 0 ? (
            <p className="text-xs text-muted-foreground">Carregando...</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {componentes.map((c) => (
                <li key={c.id} className="flex items-center justify-between">
                  <span>{c.item?.nome}</span>
                  <span className="text-muted-foreground">
                    {c.quantidade} {c.unidade?.codigo} · disponível {c.item?.estoque_atual}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {selected && (
        <div className="flex flex-wrap items-end gap-2">
          <TextField label="Lotes" value={lotes} onChange={setLotes} type="number" />
          <TextField label="Validade (opcional)" value={validade} onChange={setValidade} type="date" />
          <PrimaryButton onClick={() => void handleRegistrar()} disabled={busy || lotesNum <= 0}>
            {busy ? "Registrando..." : "Registrar produção"}
          </PrimaryButton>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-success">{success}</p>}
    </div>
  );
}

// ============================================================
// Aba: Fichas técnicas
// ============================================================

type ItemOption = { id: string; nome: string; tipo: string; unidade_estoque_id: string };
type Unidade = { id: string; codigo: string; nome: string; dimensao: string };
type ComponenteDraft = { itemId: string; quantidade: string; unidadeId: string };

function FichasTab() {
  const [fichas, setFichas] = useState<Ficha[]>([]);
  const [itens, setItens] = useState<ItemOption[]>([]);
  const [unidades, setUnidades] = useState<Unidade[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [itemProduzidoId, setItemProduzidoId] = useState("");
  const [rendimentoQuantidade, setRendimentoQuantidade] = useState("");
  const [rendimentoUnidadeId, setRendimentoUnidadeId] = useState("");
  const [modoPreparo, setModoPreparo] = useState("");
  const [componentesDraft, setComponentesDraft] = useState<ComponenteDraft[]>([
    { itemId: "", quantidade: "", unidadeId: "" },
  ]);

  const loadFichas = useServerFn(listFichas);
  const loadItens = useServerFn(listItems);
  const loadUnidades = useServerFn(listUnidades);
  const createFn = useServerFn(createFicha);
  const deactivateFn = useServerFn(deactivateFicha);

  async function reload() {
    const { fichas: rows } = await loadFichas();
    setFichas(rows as Ficha[]);
  }

  useEffect(() => {
    Promise.all([
      reload(),
      loadItens({ data: undefined }).then((r) => setItens(r.items as ItemOption[])),
      loadUnidades().then((r) => setUnidades(r.unidades)),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!rendimentoUnidadeId && unidades.length > 0) setRendimentoUnidadeId(unidades[0]!.id);
  }, [unidades, rendimentoUnidadeId]);

  function updateComponente(index: number, patch: Partial<ComponenteDraft>) {
    setComponentesDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  async function handleCreate() {
    setError(null);
    const rendimento = parseAmount(rendimentoQuantidade);
    if (!itemProduzidoId) {
      setError("Escolha o item produzido.");
      return;
    }
    if (!rendimento) {
      setError("Rendimento inválido.");
      return;
    }
    const componentes = [];
    for (const c of componentesDraft) {
      if (!c.itemId) continue;
      const qty = parseAmount(c.quantidade);
      if (!qty) {
        setError("Quantidade de componente inválida.");
        return;
      }
      componentes.push({ itemId: c.itemId, quantidade: qty, unidadeId: c.unidadeId });
    }
    if (componentes.length === 0) {
      setError("Adicione ao menos um componente.");
      return;
    }

    const result = await createFn({
      data: {
        itemProduzidoId,
        rendimentoQuantidade: rendimento,
        rendimentoUnidadeId,
        modoPreparo: modoPreparo || undefined,
        componentes,
      },
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setItemProduzidoId("");
    setRendimentoQuantidade("");
    setModoPreparo("");
    setComponentesDraft([{ itemId: "", quantidade: "", unidadeId: unidades[0]?.id ?? "" }]);
    setCreating(false);
    await reload();
  }

  if (loading) return <p className="text-sm text-muted-foreground">Carregando...</p>;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <PrimaryButton onClick={() => setCreating((v) => !v)}>
        {creating ? "Cancelar" : "+ Nova ficha técnica"}
      </PrimaryButton>

      {creating && (
        <SectionCard title="Nova ficha">
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Item produzido</span>
              <select
                value={itemProduzidoId}
                onChange={(e) => setItemProduzidoId(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
              >
                <option value="">Selecione...</option>
                {itens.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.nome} ({i.tipo})
                  </option>
                ))}
              </select>
            </label>

            <div className="flex gap-2">
              <TextField
                label="Rende quanto"
                value={rendimentoQuantidade}
                onChange={setRendimentoQuantidade}
                type="number"
              />
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">Unidade</span>
                <select
                  value={rendimentoUnidadeId}
                  onChange={(e) => setRendimentoUnidadeId(e.target.value)}
                  className="mt-1 h-11 rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                >
                  {unidades.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.codigo}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <TextField
              label="Modo de preparo (opcional)"
              value={modoPreparo}
              onChange={setModoPreparo}
            />

            <div>
              <p className="text-xs font-medium text-muted-foreground">Componentes</p>
              <div className="mt-2 space-y-2">
                {componentesDraft.map((c, index) => (
                  <div key={index} className="flex gap-2">
                    <select
                      value={c.itemId}
                      onChange={(e) => updateComponente(index, { itemId: e.target.value })}
                      className="h-11 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-ring"
                    >
                      <option value="">Item...</option>
                      {itens.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.nome}
                        </option>
                      ))}
                    </select>
                    <input
                      value={c.quantidade}
                      onChange={(e) => updateComponente(index, { quantidade: e.target.value })}
                      type="number"
                      placeholder="Qtd"
                      className="h-11 w-20 rounded-xl border border-border bg-background px-2 text-sm outline-none focus:border-ring"
                    />
                    <select
                      value={c.unidadeId}
                      onChange={(e) => updateComponente(index, { unidadeId: e.target.value })}
                      className="h-11 w-20 rounded-xl border border-border bg-background px-2 text-sm outline-none focus:border-ring"
                    >
                      {unidades.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.codigo}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <button
                onClick={() =>
                  setComponentesDraft((prev) => [
                    ...prev,
                    { itemId: "", quantidade: "", unidadeId: unidades[0]?.id ?? "" },
                  ])
                }
                className="mt-2 text-xs text-primary underline"
              >
                + Adicionar componente
              </button>
            </div>

            <PrimaryButton onClick={() => void handleCreate()}>Salvar ficha</PrimaryButton>
          </div>
        </SectionCard>
      )}

      {fichas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma ficha técnica ativa.</p>
      ) : (
        <ul className="space-y-2">
          {fichas.map((f) => (
            <li key={f.id} className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{f.item_produzido?.nome}</p>
                  <p className="text-xs text-muted-foreground">
                    Rende {f.rendimento_quantidade} {f.rendimento_unidade?.codigo}
                  </p>
                </div>
                <button
                  onClick={() => void deactivateFn({ data: { id: f.id } }).then(reload)}
                  className="shrink-0 text-xs text-destructive underline"
                >
                  Desativar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// Aba: Histórico
// ============================================================

type ProducaoRow = {
  id: string;
  quantidade_produzida: number;
  custo_total: number;
  observacao: string | null;
  created_at: string;
  item_produzido: { nome: string } | null;
  unidade: { codigo: string } | null;
};

function HistoricoTab() {
  const [producoes, setProducoes] = useState<ProducaoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useServerFn(listProducoes);

  useEffect(() => {
    load()
      .then((r) => setProducoes(r.producoes as ProducaoRow[]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Carregando...</p>;
  if (producoes.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma produção registrada ainda.</p>;
  }

  return (
    <ul className="space-y-2">
      {producoes.map((p) => (
        <li key={p.id} className="rounded-2xl border border-border bg-card p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{p.item_produzido?.nome}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(p.created_at).toLocaleString("pt-BR")}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {p.quantidade_produzida} {p.unidade?.codigo} · custo {brl(p.custo_total)}
            {p.observacao ? ` · ${p.observacao}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
