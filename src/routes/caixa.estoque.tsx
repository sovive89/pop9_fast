import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { PasswordConfirm } from "@/components/shared/PasswordConfirm";
import { PrimaryButton, SectionCard, TextField } from "@/components/stock/SharedFormFields";
import { brl, parseAmount } from "@/lib/format";
import {
  addBaseDrinkEntry,
  addBaseDrinkLoss,
  addIngredientEntry,
  addIngredientLoss,
  createBaseDrink,
  createIngredient,
  createSupplier,
  deleteBaseDrink,
  deleteIngredient,
  getRecipeItems,
  getBaseDrinksOverview,
  getStockReport,
  listAllProducts,
  listSuppliers,
  setRecipeItems,
  updateBaseDrinkPackaging,
  updateIngredientPackaging,
} from "@/lib/base-drinks.functions";

export const Route = createFileRoute("/caixa/estoque")({
  head: () => ({
    meta: [
      { title: "Estoque | Pop9 Fast" },
      {
        name: "description",
        content: "Bebidas base, ingredientes, fornecedores e fichas técnicas.",
      },
    ],
  }),
  component: StockOverview,
});

type Tab = "bebidas" | "ingredientes" | "fornecedores" | "fichas" | "relatorios";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "bebidas", label: "Bebidas base" },
  { id: "ingredientes", label: "Ingredientes" },
  { id: "fornecedores", label: "Fornecedores" },
  { id: "fichas", label: "Ficha técnica (Receitas)" },
  { id: "relatorios", label: "Relatórios" },
];

function StockOverview() {
  const [tab, setTab] = useState<Tab>("bebidas");

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Estoque</p>
        <h1 className="mt-1 text-3xl font-bold">Gestão do bar</h1>
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
        {tab === "bebidas" && <BebidasBaseTab />}
        {tab === "ingredientes" && <IngredientesTab />}
        {tab === "fornecedores" && <FornecedoresTab />}
        {tab === "fichas" && <FichasTecnicasTab />}
        {tab === "relatorios" && <RelatoriosTab />}
      </div>
    </main>
  );
}

// ============================================================
// Abas: Bebidas base / Ingredientes (mesmo padrão, unidades diferentes)
// ============================================================

type StockComponent = {
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  min_stock: number;
  average_cost: number;
  purchase_unit: string | null;
  units_per_pack: number;
  content_amount: number;
  doses: Array<{ productName: string; doses: number }>;
};

type Supplier = { id: string; name: string; document: string | null; phone: string | null; active: boolean };

function ComponentStockTab(props: {
  kind: "base_drink" | "ingredient";
  title: string;
  units: string[];
  createFn: (input: {
    data: {
      name: string;
      unit: string;
      minStock?: number | undefined;
      purchaseUnit?: string | undefined;
      unitsPerPack?: number | undefined;
      contentAmount?: number | undefined;
    };
  }) => Promise<{ ok: boolean; message?: string; id?: string }>;
  entryFn: (input: {
    data: {
      id: string;
      packs: number;
      purchaseCost?: number | undefined;
      supplierId?: string | undefined;
      note?: string | undefined;
    };
  }) => Promise<{ ok: boolean; message?: string }>;
  updatePackagingFn: (input: {
    data: {
      id: string;
      purchaseUnit?: string | undefined;
      unitsPerPack?: number | undefined;
      contentAmount?: number | undefined;
    };
  }) => Promise<{ ok: boolean; message?: string }>;
  deleteFn: (input: {
    data: { id: string; password: string };
  }) => Promise<{ ok: boolean; message?: string }>;
  lossFn: (input: {
    data: { id: string; quantity: number; note?: string | undefined };
  }) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [items, setItems] = useState<StockComponent[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState(props.units[0]);
  const [minStock, setMinStock] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("");
  const [unitsPerPack, setUnitsPerPack] = useState("1");
  // Vazio de propósito, não "1": um padrão de "1" parece já preenchido corretamente e passa
  // despercebido — foi assim que uma garrafa de 1L ficou registrada como "1ml" na prática.
  const [contentAmount, setContentAmount] = useState("");
  // Quantidade e valor da primeira compra: o cadastro e a entrada acontecem no mesmo gesto, que é
  // como a coisa acontece no bar — chega a mercadoria e se registra o que chegou.
  const [newPacks, setNewPacks] = useState("");
  const [newPurchaseCost, setNewPurchaseCost] = useState("");
  const [newSupplierId, setNewSupplierId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [entryPacks, setEntryPacks] = useState("");
  const [entryPurchaseCost, setEntryPurchaseCost] = useState("");
  const [entrySupplierId, setEntrySupplierId] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entryBusy, setEntryBusy] = useState(false);

  const [openLossId, setOpenLossId] = useState<string | null>(null);
  const [lossQuantity, setLossQuantity] = useState("");
  const [lossNote, setLossNote] = useState("");
  const [lossError, setLossError] = useState<string | null>(null);
  const [lossBusy, setLossBusy] = useState(false);

  const [openPackagingId, setOpenPackagingId] = useState<string | null>(null);
  const [editPurchaseUnit, setEditPurchaseUnit] = useState("");
  const [editUnitsPerPack, setEditUnitsPerPack] = useState("1");
  const [editContentAmount, setEditContentAmount] = useState("1");
  const [packagingError, setPackagingError] = useState<string | null>(null);
  const [packagingBusy, setPackagingBusy] = useState(false);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const overview = useServerFn(getBaseDrinksOverview);
  const listSup = useServerFn(listSuppliers);

  async function load() {
    const [overviewResult, suppliersResult] = await Promise.all([overview(), listSup()]);
    const list =
      props.kind === "base_drink" ? overviewResult.baseDrinks : overviewResult.ingredients;
    setItems((list ?? []) as StockComponent[]);
    setSuppliers(suppliersResult.suppliers as Supplier[]);
  }

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 15000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitNew() {
    setError(null);
    if (name.trim().length < 2) return setError("Digite o nome.");

    const packsPerPackValue = unitsPerPack ? parseAmount(unitsPerPack) : 1;
    if (packsPerPackValue === null || !Number.isInteger(packsPerPackValue) || packsPerPackValue <= 0) {
      return setError("Itens por embalagem deve ser um número inteiro maior que zero.");
    }
    // Sem valor padrão aqui, de propósito: "1" parece já preenchido corretamente e passa
    // despercebido — foi assim que uma garrafa de 1L virou "1ml" de conteúdo na prática.
    const contentValue = contentAmount ? parseAmount(contentAmount) : null;
    if (contentValue === null || contentValue <= 0) {
      return setError(`Preencha o conteúdo por item em ${unit} (ex.: garrafa de 1L → 1000).`);
    }

    // Quantidade é opcional: dá para cadastrar o insumo sem entrada, se a mercadoria ainda não
    // chegou. Mas se veio preenchida, precisa ser válida antes de cadastrar qualquer coisa.
    let packs: number | undefined;
    if (newPacks.trim()) {
      const parsed = parseAmount(newPacks);
      if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) {
        return setError(
          purchaseUnit.trim()
            ? "Informe um número inteiro de embalagens."
            : "Informe uma quantidade inteira maior que zero.",
        );
      }
      packs = parsed;
    }
    let purchaseCost: number | undefined;
    if (newPurchaseCost.trim()) {
      const parsed = parseAmount(newPurchaseCost);
      if (parsed === null || parsed < 0) return setError("Valor pago inválido.");
      purchaseCost = parsed;
    }

    // Valor pago ou fornecedor sem quantidade significa entrada esquecida pela metade. Salvar
    // assim descartaria o que foi digitado sem avisar ninguém.
    if (packs === undefined && (purchaseCost !== undefined || newSupplierId)) {
      return setError("Informe a quantidade que chegou, ou limpe o valor pago e o fornecedor.");
    }

    setSaving(true);
    const result = await props.createFn({
      data: {
        name,
        unit,
        minStock: minStock ? Number(minStock) : undefined,
        purchaseUnit: purchaseUnit || undefined,
        unitsPerPack: packsPerPackValue,
        contentAmount: contentValue,
      },
    });
    if (!result.ok) {
      setSaving(false);
      return setError(result.message ?? "Não foi possível salvar.");
    }

    // O cadastro já foi gravado. Se a entrada falhar aqui, o insumo continua criado e a equipe
    // pode dar a entrada pelo botão da linha — por isso a mensagem diz exatamente onde parou, em
    // vez de sugerir que nada foi salvo.
    if (packs !== undefined && result.id) {
      const entry = await props.entryFn({
        data: {
          id: result.id,
          packs,
          purchaseCost,
          supplierId: newSupplierId || undefined,
        },
      });
      if (!entry.ok) {
        setSaving(false);
        await load();
        return setError(
          `${props.title} cadastrada, mas a entrada não foi registrada: ${entry.message ?? "tente pelo botão Entrada da linha."}`,
        );
      }
    }

    setSaving(false);
    setName("");
    setMinStock("");
    setPurchaseUnit("");
    setUnitsPerPack("1");
    setContentAmount("");
    setNewPacks("");
    setNewPurchaseCost("");
    setNewSupplierId("");
    setShowForm(false);
    await load();
  }

  async function submitEntry(item: StockComponent) {
    setEntryError(null);
    const packs = parseAmount(entryPacks);
    if (packs === null || !Number.isInteger(packs) || packs <= 0) {
      return setEntryError("Informe um número inteiro de embalagens.");
    }

    let purchaseCost: number | undefined;
    if (entryPurchaseCost.trim()) {
      const parsed = parseAmount(entryPurchaseCost);
      if (parsed === null || parsed < 0) return setEntryError("Valor pago inválido.");
      purchaseCost = parsed;
    }

    setEntryBusy(true);
    const result = await props.entryFn({
      data: {
        id: item.id,
        packs,
        purchaseCost,
        supplierId: entrySupplierId || undefined,
      },
    });
    setEntryBusy(false);
    if (!result.ok) return setEntryError(result.message ?? "Não foi possível registrar a entrada.");
    setOpenEntryId(null);
    setEntryPacks("");
    setEntryPurchaseCost("");
    setEntrySupplierId("");
    await load();
  }

  async function submitLoss(item: StockComponent) {
    setLossError(null);
    const quantity = parseAmount(lossQuantity);
    if (quantity === null || quantity <= 0) {
      return setLossError(`Informe uma quantidade perdida em ${item.unit}.`);
    }
    if (quantity > item.current_stock) {
      return setLossError(`Maior do que o estoque atual (${item.current_stock} ${item.unit}).`);
    }

    setLossBusy(true);
    const result = await props.lossFn({
      data: { id: item.id, quantity, note: lossNote.trim() || undefined },
    });
    setLossBusy(false);
    if (!result.ok) return setLossError(result.message ?? "Não foi possível registrar a perda.");
    setOpenLossId(null);
    setLossQuantity("");
    setLossNote("");
    await load();
  }

  function openPackagingEditor(item: StockComponent) {
    setOpenPackagingId(item.id);
    setOpenEntryId(null);
    setDeletingId(null);
    setOpenLossId(null);
    setPackagingError(null);
    setEditPurchaseUnit(item.purchase_unit ?? "");
    setEditUnitsPerPack(String(item.units_per_pack));
    setEditContentAmount(String(item.content_amount));
  }

  async function submitPackaging(item: StockComponent) {
    setPackagingError(null);
    const perPack = parseAmount(editUnitsPerPack);
    if (perPack === null || !Number.isInteger(perPack) || perPack <= 0) {
      return setPackagingError("Itens por embalagem deve ser um número inteiro maior que zero.");
    }
    const content = parseAmount(editContentAmount);
    if (content === null || content <= 0) {
      return setPackagingError("Conteúdo por item deve ser maior que zero.");
    }

    setPackagingBusy(true);
    const result = await props.updatePackagingFn({
      data: {
        id: item.id,
        purchaseUnit: editPurchaseUnit || undefined,
        unitsPerPack: perPack,
        contentAmount: content,
      },
    });
    setPackagingBusy(false);
    if (!result.ok) return setPackagingError(result.message ?? "Não foi possível salvar.");
    setOpenPackagingId(null);
    await load();
  }

  async function confirmDeleteStockItem(id: string, password: string) {
    const result = await props.deleteFn({ data: { id, password } });
    if (result.ok) {
      setDeletingId(null);
      await load();
    }
    return result;
  }

  return (
    <div className="space-y-5">
      <button
        onClick={() => setShowForm((value) => !value)}
        className="w-full rounded-xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {showForm ? "Cancelar" : "+ Entrada"}
      </button>

      {showForm && (
        <SectionCard title={`Entrada de ${props.title.toLowerCase()}`}>
          <div className="space-y-3">
            <TextField label="Nome" value={name} onChange={setName} placeholder="Vodka Smirnoff 1L" />
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Unidade</span>
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
              >
                {props.units.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <TextField
              label="Estoque mínimo (alerta)"
              value={minStock}
              onChange={setMinStock}
              placeholder="0"
              type="number"
            />
            <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-3">
              <p className="text-xs font-semibold">Como você compra</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                O custo por {unit} é calculado a partir daqui — você nunca digita ele na mão.
              </p>
              <p className="mt-1.5 text-xs font-medium text-primary">
                Ex.: caixa com 12 latas de 350 ml → 12 itens por embalagem, 350 de conteúdo cada.
                Garrafa de 1L → 1 item por embalagem, 1000 de conteúdo (não deixe em 1).
              </p>
              <div className="mt-3 space-y-3">
                <TextField
                  label="Unidade de compra"
                  value={purchaseUnit}
                  onChange={setPurchaseUnit}
                  placeholder="garrafa, caixa, fardo..."
                />
                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    label="Itens por embalagem"
                    value={unitsPerPack}
                    onChange={setUnitsPerPack}
                    placeholder="1"
                    type="number"
                  />
                  <TextField
                    label={`Conteúdo por item (${unit}) — obrigatório`}
                    value={contentAmount}
                    onChange={setContentAmount}
                    placeholder={unit === "ml" || unit === "g" ? "ex.: 1000" : "ex.: 1"}
                    type="number"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border p-3">
              <p className="text-xs font-medium">O que chegou agora</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pode deixar em branco se a mercadoria ainda não chegou — dá para lançar depois pelo
                botão Entrada da linha.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <TextField
                  // Sem unidade de compra definida, a embalagem é 1×1 e o número digitado é a
                  // própria quantidade — pedir "embalagens" aqui faria a equipe informar outra coisa.
                  label={
                    purchaseUnit.trim() ? `Quantas ${purchaseUnit.trim()}` : `Quantidade (${unit})`
                  }
                  value={newPacks}
                  onChange={setNewPacks}
                  placeholder="0"
                  type="number"
                />
                <TextField
                  label="Total pago (R$)"
                  value={newPurchaseCost}
                  onChange={setNewPurchaseCost}
                  placeholder="0,00"
                />
              </div>
              {/* A prévia lê os campos com parseAmount, o mesmo que o salvamento usa: com Number,
                  digitar "1.000" mostrava um total aqui e gravava outro no estoque. */}
              {(() => {
                // A prévia só descreve entradas que o salvamento aceitaria: quantidade inteira e
                // embalagem positiva. Descrever um total que vai ser recusado é pior que não
                // mostrar nada.
                const packs = parseAmount(newPacks);
                if (packs === null || !Number.isInteger(packs) || packs <= 0) return null;
                const perPack = parseAmount(unitsPerPack);
                const content = parseAmount(contentAmount);
                if (perPack === null || perPack <= 0 || content === null || content <= 0) {
                  return null;
                }
                const total = packs * perPack * content;
                const cost = newPurchaseCost.trim() ? parseAmount(newPurchaseCost) : null;
                return (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Entra {total} {unit} no estoque
                    {cost !== null && cost > 0 && total > 0
                      ? ` · ${brl(cost / total)} por ${unit}`
                      : ""}
                  </p>
                );
              })()}
              <select
                value={newSupplierId}
                onChange={(event) => setNewSupplierId(event.target.value)}
                className="mt-3 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-ring"
              >
                <option value="">Fornecedor (opcional)</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            <PrimaryButton onClick={submitNew} disabled={saving}>
              {saving ? "Salvando..." : "Salvar"}
            </PrimaryButton>
          </div>
        </SectionCard>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          Nada cadastrado ainda.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const low = item.current_stock < item.min_stock;
            const isOpen = openEntryId === item.id;
            const isPackagingOpen = openPackagingId === item.id;
            const isDeleting = deletingId === item.id;
            return (
              <li key={item.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Custo médio: {brl(item.average_cost)} / {item.unit}
                      {item.purchase_unit
                        ? ` · comprado em ${item.purchase_unit} (${item.units_per_pack} × ${item.content_amount}${item.unit})`
                        : ""}
                    </p>
                    {item.doses.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.doses.map((d) => `${d.productName}: ${d.doses} doses`).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className={`text-sm font-bold ${low ? "text-destructive" : ""}`}>
                      {item.current_stock} {item.unit}
                    </span>
                    <button
                      onClick={() =>
                        isPackagingOpen ? setOpenPackagingId(null) : openPackagingEditor(item)
                      }
                      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {isPackagingOpen ? "Cancelar" : "Embalagem"}
                    </button>
                    <button
                      onClick={() => {
                        setOpenEntryId(isOpen ? null : item.id);
                        setOpenPackagingId(null);
                        setDeletingId(null);
                        setOpenLossId(null);
                        setEntryPacks("");
                        setEntryPurchaseCost("");
                        setEntrySupplierId("");
                        setEntryError(null);
                      }}
                      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {isOpen ? "Cancelar" : "+ Entrada"}
                    </button>
                    <button
                      onClick={() => {
                        const isLossOpen = openLossId === item.id;
                        setOpenLossId(isLossOpen ? null : item.id);
                        setOpenEntryId(null);
                        setOpenPackagingId(null);
                        setDeletingId(null);
                        setLossQuantity("");
                        setLossNote("");
                        setLossError(null);
                      }}
                      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-amber-500"
                    >
                      {openLossId === item.id ? "Cancelar" : "− Perda"}
                    </button>
                    <button
                      onClick={() => {
                        setDeletingId(isDeleting ? null : item.id);
                        setOpenEntryId(null);
                        setOpenPackagingId(null);
                        setOpenLossId(null);
                      }}
                      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                    >
                      {isDeleting ? "Cancelar" : "Apagar"}
                    </button>
                  </div>
                </div>

                {isDeleting && (
                  <div className="mt-3">
                    <PasswordConfirm
                      message={`Apagar "${item.name}" de vez? Só funciona se ele nunca foi usado numa ficha técnica nem saiu por venda — não dá pra desfazer. Confirme com a senha da equipe.`}
                      confirmLabel="Apagar de vez"
                      onCancel={() => setDeletingId(null)}
                      onConfirm={(password) => confirmDeleteStockItem(item.id, password)}
                    />
                  </div>
                )}

                {!item.purchase_unit && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Embalagem de compra não configurada — a entrada é feita direto em {item.unit}.
                  </p>
                )}

                {isPackagingOpen && (
                  <div className="mt-3 space-y-3 rounded-xl border border-border p-3">
                    <TextField
                      label="Unidade de compra"
                      value={editPurchaseUnit}
                      onChange={setEditPurchaseUnit}
                      placeholder="garrafa, caixa, fardo..."
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <TextField
                        label="Itens por embalagem"
                        value={editUnitsPerPack}
                        onChange={setEditUnitsPerPack}
                        placeholder="1"
                        type="number"
                      />
                      <TextField
                        label={`Conteúdo por item (${item.unit})`}
                        value={editContentAmount}
                        onChange={setEditContentAmount}
                        placeholder="1"
                        type="number"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Vale para as próximas entradas. O estoque e o custo médio atuais não mudam.
                    </p>
                    {packagingError && <p className="text-xs text-destructive">{packagingError}</p>}
                    <button
                      onClick={() => submitPackaging(item)}
                      disabled={packagingBusy}
                      className="h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-60"
                    >
                      {packagingBusy ? "Salvando..." : "Salvar embalagem"}
                    </button>
                  </div>
                )}

                {isOpen && (
                  <div className="mt-3 space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="number"
                        inputMode="numeric"
                        step={1}
                        min={1}
                        value={entryPacks}
                        onChange={(event) => setEntryPacks(event.target.value)}
                        placeholder={
                          item.purchase_unit
                            ? `Quantas ${item.purchase_unit}`
                            : `Quantidade (${item.unit})`
                        }
                        autoFocus
                        className="h-11 flex-1 rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        value={entryPurchaseCost}
                        onChange={(event) => setEntryPurchaseCost(event.target.value)}
                        placeholder="Total pago (R$)"
                        className="h-11 flex-1 rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
                      />
                    </div>
                    {(() => {
                      const packs = parseAmount(entryPacks);
                      if (packs === null || packs <= 0) return null;
                      const quantity = packs * item.units_per_pack * Number(item.content_amount);
                      const cost = entryPurchaseCost.trim() ? parseAmount(entryPurchaseCost) : null;
                      return (
                        <p className="text-xs text-muted-foreground">
                          Entra {quantity} {item.unit} no estoque
                          {cost !== null && cost > 0 && quantity > 0
                            ? ` · ${brl(cost / quantity)} por ${item.unit}`
                            : ""}
                        </p>
                      );
                    })()}
                    {entryError && <p className="text-xs text-destructive">{entryError}</p>}
                    <select
                      value={entrySupplierId}
                      onChange={(event) => setEntrySupplierId(event.target.value)}
                      className="h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                    >
                      <option value="">Sem fornecedor</option>
                      {suppliers.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => submitEntry(item)}
                      disabled={entryBusy || !entryPacks}
                      className="h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-60"
                    >
                      {entryBusy ? "Salvando..." : "Confirmar entrada"}
                    </button>
                  </div>
                )}

                {openLossId === item.id && (
                  <div className="mt-3 space-y-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min={0}
                      value={lossQuantity}
                      onChange={(event) => setLossQuantity(event.target.value)}
                      placeholder={`Quantidade perdida (${item.unit})`}
                      autoFocus
                      className="h-11 w-full rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
                    />
                    <input
                      type="text"
                      value={lossNote}
                      onChange={(event) => setLossNote(event.target.value)}
                      placeholder="Motivo (opcional): quebrou, venceu, derramou..."
                      className="h-11 w-full rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
                    />
                    {lossError && <p className="text-xs text-destructive">{lossError}</p>}
                    <button
                      onClick={() => submitLoss(item)}
                      disabled={lossBusy || !lossQuantity}
                      className="h-11 w-full rounded-xl bg-amber-500 text-sm font-semibold text-black disabled:opacity-60"
                    >
                      {lossBusy ? "Salvando..." : "Confirmar perda"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BebidasBaseTab() {
  const createFn = useServerFn(createBaseDrink);
  const entryFn = useServerFn(addBaseDrinkEntry);
  const updatePackagingFn = useServerFn(updateBaseDrinkPackaging);
  const deleteFn = useServerFn(deleteBaseDrink);
  const lossFn = useServerFn(addBaseDrinkLoss);
  return (
    <ComponentStockTab
      kind="base_drink"
      title="Bebida base"
      units={["ml", "un"]}
      createFn={(input) =>
        createFn({
          data: {
            name: input.data.name,
            unit: input.data.unit as "ml" | "un",
            minStock: input.data.minStock,
            purchaseUnit: input.data.purchaseUnit,
            unitsPerPack: input.data.unitsPerPack,
            contentAmount: input.data.contentAmount,
          },
        })
      }
      entryFn={(input) =>
        entryFn({
          data: {
            baseDrinkId: input.data.id,
            packs: input.data.packs,
            purchaseCost: input.data.purchaseCost,
            supplierId: input.data.supplierId,
            note: input.data.note,
          },
        })
      }
      updatePackagingFn={(input) =>
        updatePackagingFn({
          data: {
            baseDrinkId: input.data.id,
            purchaseUnit: input.data.purchaseUnit,
            unitsPerPack: input.data.unitsPerPack,
            contentAmount: input.data.contentAmount,
          },
        })
      }
      deleteFn={(input) => deleteFn({ data: input.data })}
      lossFn={(input) =>
        lossFn({ data: { baseDrinkId: input.data.id, quantity: input.data.quantity, note: input.data.note } })
      }
    />
  );
}

function IngredientesTab() {
  const createFn = useServerFn(createIngredient);
  const entryFn = useServerFn(addIngredientEntry);
  const updatePackagingFn = useServerFn(updateIngredientPackaging);
  const deleteFn = useServerFn(deleteIngredient);
  const lossFn = useServerFn(addIngredientLoss);
  return (
    <ComponentStockTab
      kind="ingredient"
      title="Ingrediente"
      units={["ml", "un", "g"]}
      createFn={(input) =>
        createFn({
          data: {
            name: input.data.name,
            unit: input.data.unit as "ml" | "un" | "g",
            minStock: input.data.minStock,
            purchaseUnit: input.data.purchaseUnit,
            unitsPerPack: input.data.unitsPerPack,
            contentAmount: input.data.contentAmount,
          },
        })
      }
      entryFn={(input) =>
        entryFn({
          data: {
            ingredientId: input.data.id,
            packs: input.data.packs,
            purchaseCost: input.data.purchaseCost,
            supplierId: input.data.supplierId,
            note: input.data.note,
          },
        })
      }
      updatePackagingFn={(input) =>
        updatePackagingFn({
          data: {
            ingredientId: input.data.id,
            purchaseUnit: input.data.purchaseUnit,
            unitsPerPack: input.data.unitsPerPack,
            contentAmount: input.data.contentAmount,
          },
        })
      }
      deleteFn={(input) => deleteFn({ data: input.data })}
      lossFn={(input) =>
        lossFn({ data: { ingredientId: input.data.id, quantity: input.data.quantity, note: input.data.note } })
      }
    />
  );
}

// ============================================================
// Aba: Relatórios
// ============================================================

type StockReport = {
  totalValue: number;
  valueByKind: Record<string, number>;
  lowStock: Array<{
    id: string;
    name: string;
    unit: string;
    current: number;
    min: number;
    kind: "Bebida base" | "Ingrediente";
  }>;
  outOfStockProducts: Array<{ id: string; name: string; category: string }>;
  waste: {
    totalValue: number;
    byItem: Array<{ name: string; quantity: number; value: number }>;
    byMonth: Array<{ month: string; value: number }>;
  };
};

function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year!, month! - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
}

function RelatoriosTab() {
  const [report, setReport] = useState<StockReport | null>(null);
  const load = useServerFn(getStockReport);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const result = await load();
      if (!cancelled) setReport(result as StockReport);
    }
    void run();
    const poll = setInterval(() => void run(), 20000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!report) {
    return <p className="text-sm text-muted-foreground">Carregando relatório...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">Valor total parado em estoque</p>
        <p className="mt-1 text-2xl font-bold">{brl(report.totalValue)}</p>
        <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
          {Object.entries(report.valueByKind).map(([kind, value]) => (
            <div key={kind} className="flex items-center justify-between">
              <span className="text-muted-foreground">{kind}</span>
              <span className="font-medium">{brl(value)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-semibold">Abaixo do mínimo</p>
        {report.lowStock.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Tudo dentro do mínimo cadastrado.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {report.lowStock.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {item.name} <span className="text-muted-foreground">· {item.kind}</span>
                </span>
                <span className="shrink-0 font-semibold text-amber-500">
                  {item.current} / {item.min} {item.unit}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-semibold">Produtos zerados</p>
        {report.outOfStockProducts.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nenhum produto de revenda zerado.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {report.outOfStockProducts.map((product) => (
              <li key={product.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{product.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{product.category}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Desperdício: existe desde que a ação "− Perda" foi criada nesta versão — meses antes
          disso aparecem vazios porque não tinha como registrar, não porque não teve perda. */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-semibold">Desperdício</p>
        <p className="mt-1 text-2xl font-bold text-amber-500">{brl(report.waste.totalValue)}</p>
        <p className="text-xs text-muted-foreground">perdido no total, desde que passou a ser registrado</p>

        {report.waste.byMonth.length > 1 && (
          <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
            {report.waste.byMonth.map((row) => (
              <div key={row.month} className="flex items-center justify-between">
                <span className="capitalize text-muted-foreground">{monthLabel(row.month)}</span>
                <span className="font-medium">{brl(row.value)}</span>
              </div>
            ))}
          </div>
        )}

        {report.waste.byItem.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhuma perda registrada ainda. Use o botão "− Perda" nas abas de Bebidas base e
            Ingredientes pra registrar quebra, vencimento ou derrame.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 border-t border-border pt-3">
            {report.waste.byItem.map((item) => (
              <li key={item.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {item.name} <span className="text-muted-foreground">· {item.quantity}</span>
                </span>
                <span className="shrink-0 font-semibold text-amber-500">{brl(item.value)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Aba: Fornecedores
// ============================================================

function FornecedoresTab() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [document_, setDocument] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const listSup = useServerFn(listSuppliers);
  const create = useServerFn(createSupplier);

  async function load() {
    const result = await listSup();
    setSuppliers(result.suppliers as Supplier[]);
  }

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 15000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setError(null);
    if (name.trim().length < 2) return setError("Digite o nome do fornecedor.");
    setSaving(true);
    const result = await create({ data: { name, document: document_, phone } });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setName("");
    setDocument("");
    setPhone("");
    setShowForm(false);
    await load();
  }

  return (
    <div className="space-y-5">
      <button
        onClick={() => setShowForm((value) => !value)}
        className="w-full rounded-xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {showForm ? "Cancelar" : "+ Novo fornecedor"}
      </button>

      {showForm && (
        <SectionCard title="Novo fornecedor">
          <div className="space-y-3">
            <TextField label="Nome" value={name} onChange={setName} placeholder="Distribuidora ABC" />
            <TextField label="CNPJ/CPF (opcional)" value={document_} onChange={setDocument} />
            <TextField label="Telefone (opcional)" value={phone} onChange={setPhone} />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <PrimaryButton onClick={submit} disabled={saving}>
              {saving ? "Salvando..." : "Salvar fornecedor"}
            </PrimaryButton>
          </div>
        </SectionCard>
      )}

      {suppliers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          Nenhum fornecedor cadastrado ainda.
        </p>
      ) : (
        <ul className="space-y-3">
          {suppliers.map((supplier) => (
            <li key={supplier.id} className="rounded-2xl border border-border bg-card p-4">
              <p className="font-semibold">{supplier.name}</p>
              {(supplier.document || supplier.phone) && (
                <p className="text-xs text-muted-foreground">
                  {[supplier.document, supplier.phone].filter(Boolean).join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// Aba: Fichas técnicas
// ============================================================

type ProductOption = { id: string; name: string; category: string; is_active: boolean };
type RecipeRow = {
  id: string;
  base_drink_id: string | null;
  ingredient_id: string | null;
  quantity: number;
  base_drink: { name: string; unit: string } | null;
  ingredient: { name: string; unit: string } | null;
};

function FichasTecnicasTab() {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [baseDrinks, setBaseDrinks] = useState<StockComponent[]>([]);
  const [ingredients, setIngredients] = useState<StockComponent[]>([]);
  const [selectedProduct, setSelectedProduct] = useState("");
  const [recipe, setRecipe] = useState<RecipeRow[]>([]);
  const [loadingRecipe, setLoadingRecipe] = useState(false);

  const [newType, setNewType] = useState<"base_drink" | "ingredient">("base_drink");
  const [newComponentId, setNewComponentId] = useState("");
  const [newQuantity, setNewQuantity] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const listProducts = useServerFn(listAllProducts);
  const overview = useServerFn(getBaseDrinksOverview);
  const getItems = useServerFn(getRecipeItems);
  const saveItems = useServerFn(setRecipeItems);

  useEffect(() => {
    async function loadReferenceData() {
      const [productsResult, overviewResult] = await Promise.all([listProducts(), overview()]);
      setProducts(productsResult.products as ProductOption[]);
      setBaseDrinks((overviewResult.baseDrinks ?? []) as StockComponent[]);
      setIngredients((overviewResult.ingredients ?? []) as StockComponent[]);
    }
    void loadReferenceData();
    // só atualiza as listas de referência (produtos/bebidas base/ingredientes) — nunca mexe na
    // receita que o usuário está montando na tela, então é seguro rodar em segundo plano.
    const poll = setInterval(() => void loadReferenceData(), 15000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadRecipe(productId: string) {
    setSelectedProduct(productId);
    setMessage(null);
    if (!productId) {
      setRecipe([]);
      return;
    }
    setLoadingRecipe(true);
    const result = await getItems({ data: { productId } });
    setRecipe(result.items as RecipeRow[]);
    setLoadingRecipe(false);
  }

  function addComponentToRecipe() {
    if (!newComponentId || !newQuantity) return;
    const quantity = Number(newQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return;

    const source = newType === "base_drink" ? baseDrinks : ingredients;
    const component = source.find((item) => item.id === newComponentId);
    if (!component) return;

    setRecipe((current) => [
      ...current.filter((row) => {
        const rowComponentId = newType === "base_drink" ? row.base_drink_id : row.ingredient_id;
        return rowComponentId !== newComponentId;
      }),
      {
        id: `local-${newComponentId}`,
        base_drink_id: newType === "base_drink" ? newComponentId : null,
        ingredient_id: newType === "ingredient" ? newComponentId : null,
        quantity,
        base_drink:
          newType === "base_drink" ? { name: component.name, unit: component.unit } : null,
        ingredient:
          newType === "ingredient" ? { name: component.name, unit: component.unit } : null,
      },
    ]);
    setNewComponentId("");
    setNewQuantity("");
  }

  function removeRow(row: RecipeRow) {
    setRecipe((current) => current.filter((item) => item !== row));
  }

  async function save() {
    if (!selectedProduct) return;
    setSaving(true);
    setMessage(null);
    const result = await saveItems({
      data: {
        productId: selectedProduct,
        items: recipe.map((row) =>
          row.base_drink_id
            ? {
                type: "base_drink" as const,
                baseDrinkId: row.base_drink_id,
                quantity: row.quantity,
              }
            : {
                type: "ingredient" as const,
                ingredientId: row.ingredient_id as string,
                quantity: row.quantity,
              },
        ),
      },
    });
    setSaving(false);
    setMessage(result.ok ? "Ficha técnica salva." : result.message ?? "Erro ao salvar.");
  }

  const componentOptions = newType === "base_drink" ? baseDrinks : ingredients;

  return (
    <div className="space-y-5">
      {/* Ficha técnica é sempre de um produto que já existe — criar produto novo (com ficha ou
          não) acontece no Cardápio, que já tem esse formulário. Reaproveita em vez de duplicar. */}
      <Link
        to="/caixa/cardapio"
        className="block w-full rounded-xl border border-dashed border-border py-3 text-center text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        + Criar produto novo com ficha técnica
      </Link>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">
          Ou edite a ficha de um produto já cadastrado
        </span>
        <select
          value={selectedProduct}
          onChange={(event) => void loadRecipe(event.target.value)}
          className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
        >
          <option value="">Selecione um produto</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.category} — {product.name}
            </option>
          ))}
        </select>
      </label>

      {selectedProduct && (
        <SectionCard title="Ficha técnica">
          {loadingRecipe ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : (
            <>
              {recipe.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sem ficha técnica — esse produto não desconta nada automaticamente ao ser
                  vendido (ex.: cerveja lata fechada).
                </p>
              ) : (
                <ul className="space-y-2">
                  {recipe.map((row) => {
                    const componentName =
                      row.base_drink?.name ?? row.ingredient?.name ?? "—";
                    const unit =
                      row.base_drink?.unit ?? row.ingredient?.unit ?? "";
                    return (
                      <li
                        key={row.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-2.5"
                      >
                        <span className="text-sm">
                          {componentName}{" "}
                          <span className="text-muted-foreground">
                            — {row.quantity} {unit}
                          </span>
                        </span>
                        <button
                          onClick={() => removeRow(row)}
                          className="text-xs font-medium text-destructive"
                        >
                          Remover
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="mt-4 space-y-2 border-t border-border pt-4">
                <p className="text-xs font-medium text-muted-foreground">Adicionar componente</p>
                <select
                  value={newType}
                  onChange={(event) => {
                    setNewType(event.target.value as "base_drink" | "ingredient");
                    setNewComponentId("");
                  }}
                  className="h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                >
                  <option value="base_drink">Bebida base</option>
                  <option value="ingredient">Ingrediente</option>
                </select>
                <select
                  value={newComponentId}
                  onChange={(event) => setNewComponentId(event.target.value)}
                  className="h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                >
                  <option value="">Selecione</option>
                  {componentOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.unit})
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={newQuantity}
                    onChange={(event) => setNewQuantity(event.target.value)}
                    placeholder="Quantidade consumida por venda"
                    className="h-11 flex-1 rounded-xl border border-border bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
                  />
                  <button
                    onClick={addComponentToRecipe}
                    disabled={!newComponentId || !newQuantity}
                    className="h-11 rounded-xl bg-secondary px-4 text-sm font-medium text-secondary-foreground disabled:opacity-60"
                  >
                    Adicionar
                  </button>
                </div>
              </div>

              {message && <p className="mt-3 text-xs text-muted-foreground">{message}</p>}
              <PrimaryButton onClick={save} disabled={saving}>
                {saving ? "Salvando..." : "Salvar ficha técnica"}
              </PrimaryButton>
            </>
          )}
        </SectionCard>
      )}
    </div>
  );
}
