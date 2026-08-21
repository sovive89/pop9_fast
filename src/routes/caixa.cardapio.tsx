import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { PasswordConfirm } from "@/components/shared/PasswordConfirm";
import { PrimaryButton, SectionCard, TextField } from "@/components/stock/SharedFormFields";
import { brl } from "@/lib/format";
import { addProductEntry, getStockOverview } from "@/lib/stock.functions";
import { deactivateProduct, deleteProduct as deleteProductFn } from "@/lib/register.functions";
import {
  createProduct,
  createProductCategory,
  deleteProductCategory,
  getBaseDrinksOverview,
  listProductCategories,
  setRecipeItems,
  updateProduct as updateProductFn,
  updateProductCategory,
  uploadProductPhoto,
  PRODUCT_UNITS,
  PRODUCT_PACKAGE_TYPES,
} from "@/lib/base-drinks.functions";

export const Route = createFileRoute("/caixa/cardapio")({
  head: () => ({
    meta: [
      { title: "Cardápio | Pop9 Fast" },
      {
        name: "description",
        content: "Produtos do cardápio: nome, preço, categoria, foto e disponibilidade.",
      },
    ],
  }),
  component: CardapioPage,
});

type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  unit: string;
  package_type: string | null;
  is_active: boolean;
  stock_quantity: number;
  image_url: string | null;
  purchase_unit: string | null;
  units_per_pack: number;
  content_amount: number;
  average_cost: number;
};

const LOW_STOCK_THRESHOLD = 20;

/** Insumo do estoque disponível para compor um item do cardápio. */
type StockOption = {
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  kind: "base_drink" | "ingredient";
};

/** Uma linha da ficha técnica sendo montada junto com o produto. */
type ComponentRow = { key: string; stockId: string; quantity: string };

/**
 * Reduz a foto pro tamanho de upload (server functions em serverless têm limite de payload,
 * ~4.5MB no Vercel — uma foto de celular sem compressão passa disso fácil). Redimensiona pro
 * lado maior no máximo 1280px e converte pra JPEG a 82% de qualidade, o que normalmente fica
 * bem abaixo de 1MB. `imageOrientation: "from-image"` corrige fotos de iPhone que aparecem
 * de lado (o EXIF guarda a rotação separado dos pixels).
 */
async function compressImageForUpload(
  file: File,
  maxDimension = 1280,
  quality = 0.82,
): Promise<{ base64: string; contentType: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas não suportado neste navegador.");
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Falha ao comprimir a foto."))),
      "image/jpeg",
      quality,
    );
  });

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const [, base64] = dataUrl.split(",");
  return { base64, contentType: "image/jpeg" };
}

function CardapioPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [recipeProductIds, setRecipeProductIds] = useState<Set<string>>(new Set());
  const [pendingProductIds, setPendingProductIds] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [openRestockId, setOpenRestockId] = useState<string | null>(null);
  const [restockAmount, setRestockAmount] = useState("");
  const [restockCost, setRestockCost] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restockError, setRestockError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState<(typeof PRODUCT_UNITS)[number]>("un");
  const [packageType, setPackageType] = useState<(typeof PRODUCT_PACKAGE_TYPES)[number]>("Lata");
  const [stockQuantity, setStockQuantity] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Sugestão de item já existente enquanto digita o nome — evita cadastrar de novo algo que já
  // está no estoque ou no cardápio. "Ignorar"/"+ Puxar como insumo" guardam os ids que já
  // apareceram, não um booleano: assim, digitar mais letras do mesmo nome (que continua batendo
  // com os mesmos itens) não faz o aviso reaparecer a cada tecla — só quando surge um item novo.
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set());

  // Insumos do estoque disponíveis para compor o item, e a ficha sendo montada aqui mesmo — sem
  // isso, montar o cardápio exigia digitar o nome do zero e depois ir a outra aba fazer a ligação.
  const [stockOptions, setStockOptions] = useState<StockOption[]>([]);
  const [components, setComponents] = useState<ComponentRow[]>([]);

  // Categoria é uma divisão do menu, não um produto — cadastro próprio, separado do formulário
  // de produto, pra "criar categoria" nunca virar "criar um produto vazio só pra registrar o nome".
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState("");
  const [editCategorySaving, setEditCategorySaving] = useState(false);
  const [editCategoryError, setEditCategoryError] = useState<string | null>(null);

  // Edição de um produto já cadastrado — campos próprios, separados dos de "Novo produto", pra
  // abrir um não pisar no outro se os dois ficarem abertos ao mesmo tempo.
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editProductName, setEditProductName] = useState("");
  const [editProductCategory, setEditProductCategory] = useState("");
  const [editProductPrice, setEditProductPrice] = useState("");
  const [editProductUnit, setEditProductUnit] = useState<(typeof PRODUCT_UNITS)[number]>("un");
  const [editProductPackageType, setEditProductPackageType] =
    useState<(typeof PRODUCT_PACKAGE_TYPES)[number]>("Lata");
  const [editProductPhotoFile, setEditProductPhotoFile] = useState<File | null>(null);
  const [editProductSaving, setEditProductSaving] = useState(false);
  const [editProductCompressing, setEditProductCompressing] = useState(false);
  const [editProductError, setEditProductError] = useState<string | null>(null);

  const loadOverview = useServerFn(getStockOverview);
  const loadStock = useServerFn(getBaseDrinksOverview);
  const loadCategories = useServerFn(listProductCategories);
  const createCategory = useServerFn(createProductCategory);
  const deleteCategory = useServerFn(deleteProductCategory);
  const renameCategory = useServerFn(updateProductCategory);
  const productEntry = useServerFn(addProductEntry);
  const removeProduct = useServerFn(deactivateProduct);
  const deleteProduct = useServerFn(deleteProductFn);
  const uploadPhoto = useServerFn(uploadProductPhoto);
  const create = useServerFn(createProduct);
  const update = useServerFn(updateProductFn);
  const saveRecipe = useServerFn(setRecipeItems);

  async function load() {
    const [result, stock, categoriesResult] = await Promise.all([
      loadOverview(),
      loadStock(),
      loadCategories(),
    ]);
    setLoadError(null);
    setProducts(result.products as Product[]);
    setRecipeProductIds(new Set(result.recipeProductIds));
    setPendingProductIds(new Set(result.pendingProductIds));
    setStockOptions([
      ...((stock.baseDrinks ?? []) as Array<Omit<StockOption, "kind">>).map((item) => ({
        ...item,
        kind: "base_drink" as const,
      })),
      ...((stock.ingredients ?? []) as Array<Omit<StockOption, "kind">>).map((item) => ({
        ...item,
        kind: "ingredient" as const,
      })),
    ]);
    setCategories(categoriesResult.categories);
    // Primeiro carregamento: começa com a primeira categoria já selecionada, pra não deixar o
    // formulário de produto abrir sem nenhuma escolhida.
    setCategory((current) => current || categoriesResult.categories[0]?.name || "");
  }

  async function submitNewCategory() {
    // Guarda contra duplo-envio: sem isso, apertar Enter de novo durante o pedido em andamento
    // dispara uma segunda criação e volta um "já existe" falso pra quem só apertou duas vezes.
    if (categorySaving) return;
    setCategoryError(null);
    setCategorySaving(true);
    try {
      const result = await createCategory({ data: { name: newCategoryName } });
      if (!result.ok) return setCategoryError(result.message ?? "Não foi possível criar.");
      setNewCategoryName("");
      setShowCategoryForm(false);
      // Categoria já foi criada nesse ponto — se o load() que só atualiza a tela falhar, isso não
      // pode virar "não foi possível criar" no catch de fora, que atribuiria a falha errada.
      try {
        await load();
      } catch {
        setCategoryError("Categoria criada, mas a lista não atualizou — recarregue a página.");
      }
    } catch {
      setCategoryError("Não foi possível criar — tente de novo.");
    } finally {
      setCategorySaving(false);
    }
  }

  async function confirmDeleteCategory(id: string, password: string) {
    const result = await deleteCategory({ data: { id, password } });
    if (result.ok) {
      setDeletingCategoryId(null);
      // Se a categoria apagada era a selecionada no formulário de produto, o select ficaria
      // apontando pra um nome que não existe mais — limpa pra load() escolher outra válida.
      if (categories.some((item) => item.id === id && item.name === category)) {
        setCategory("");
      }
      await load();
    }
    return result;
  }

  function openEditCategory(cat: { id: string; name: string }) {
    setEditingCategoryId(cat.id);
    setEditCategoryName(cat.name);
    setEditCategoryError(null);
    setDeletingCategoryId(null);
  }

  async function submitEditCategory() {
    if (!editingCategoryId) return;
    setEditCategoryError(null);
    setEditCategorySaving(true);
    try {
      const result = await renameCategory({
        data: { id: editingCategoryId, name: editCategoryName },
      });
      if (!result.ok) return setEditCategoryError(result.message ?? "Não foi possível salvar.");
      // Se a categoria renomeada é a selecionada no formulário de "Novo produto" ou no de editar
      // um produto já existente, acompanha o novo nome — senão o select ficaria com um valor que
      // não existe mais nas opções e a próxima tentativa de salvar falharia sem explicação.
      const renamedFrom = categories.find((item) => item.id === editingCategoryId)?.name;
      const newName = editCategoryName.trim();
      if (renamedFrom === category) setCategory(newName);
      if (renamedFrom === editProductCategory) setEditProductCategory(newName);
      setEditingCategoryId(null);
      await load();
    } catch {
      setEditCategoryError("Não foi possível salvar — tente de novo.");
    } finally {
      setEditCategorySaving(false);
    }
  }

  useEffect(() => {
    // listProductCategories agora lança em vez de virar lista vazia silenciosa quando a leitura
    // falha — mas isso significa que o carregamento em segundo plano, sem clique de ninguém pra
    // pegar o erro, precisa de um .catch explícito aqui. Sem isso, a tela não avisa nada e outros
    // dados carregados (produtos, insumos) também ficam desatualizados sem sinal nenhum.
    const safeLoad = () =>
      void load().catch(() => setLoadError("Não foi possível atualizar o cardápio."));
    safeLoad();
    const poll = setInterval(safeLoad, 15000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmRestock(productId: string) {
    setRestockError(null);
    const packs = Number(restockAmount);
    if (!Number.isFinite(packs) || !Number.isInteger(packs) || packs <= 0) {
      return setRestockError("Informe uma quantidade inteira maior que zero.");
    }
    let purchaseCost: number | undefined;
    if (restockCost.trim()) {
      const parsed = Number(restockCost.replace(",", "."));
      if (!Number.isFinite(parsed) || parsed < 0) return setRestockError("Valor pago inválido.");
      purchaseCost = parsed;
    }
    setBusyId(productId);
    const result = await productEntry({ data: { productId, packs, purchaseCost } });
    setBusyId(null);
    // Falha silenciosa aqui faria a equipe achar que deu entrada quando não deu.
    if (!result.ok) return setRestockError(result.message ?? "Não foi possível registrar a entrada.");
    setOpenRestockId(null);
    setRestockAmount("");
    setRestockCost("");
    await load();
  }

  async function confirmDelete(productId: string, password: string) {
    const result = await removeProduct({ data: { productId, password } });
    if (result.ok) {
      setDeletingId(null);
      await load();
    }
    return result;
  }

  async function confirmDeletePermanently(productId: string, password: string) {
    const result = await deleteProduct({ data: { productId, password } });
    if (result.ok) {
      setDeletingId(null);
      await load();
    }
    return result;
  }

  function openEditProduct(product: Product) {
    setEditingProductId(product.id);
    setEditProductName(product.name);
    setEditProductCategory(product.category);
    setEditProductPrice(String(product.price).replace(".", ","));
    setEditProductUnit(
      PRODUCT_UNITS.includes(product.unit as (typeof PRODUCT_UNITS)[number])
        ? (product.unit as (typeof PRODUCT_UNITS)[number])
        : "un",
    );
    setEditProductPackageType(
      PRODUCT_PACKAGE_TYPES.includes(product.package_type as (typeof PRODUCT_PACKAGE_TYPES)[number])
        ? (product.package_type as (typeof PRODUCT_PACKAGE_TYPES)[number])
        : "Outro",
    );
    setEditProductPhotoFile(null);
    setEditProductError(null);
    // Só um painel por produto — abrir editar fecha remover/entrada, e vice-versa (nos handlers
    // deles), senão os formulários se misturam na mesma linha.
    setDeletingId(null);
    setOpenRestockId(null);
  }

  async function submitEditProduct() {
    if (!editingProductId) return;
    setEditProductError(null);
    const priceNumber = Number(editProductPrice.replace(",", "."));
    if (editProductName.trim().length < 2) return setEditProductError("Digite o nome do produto.");
    if (!Number.isFinite(priceNumber) || priceNumber < 0) {
      return setEditProductError("Preço inválido.");
    }
    if (!editProductCategory) return setEditProductError("Escolha uma categoria.");

    setEditProductSaving(true);
    try {
      let imageUrl: string | undefined;
      if (editProductPhotoFile) {
        setEditProductCompressing(true);
        let compressed: { base64: string; contentType: string };
        try {
          compressed = await compressImageForUpload(editProductPhotoFile);
        } catch {
          return setEditProductError("Não foi possível processar a foto. Tente outra imagem.");
        } finally {
          setEditProductCompressing(false);
        }

        const jpgFileName = editProductPhotoFile.name.replace(/\.\w+$/, "") + ".jpg";
        const uploadResult = await uploadPhoto({
          data: { fileName: jpgFileName, base64: compressed.base64, contentType: compressed.contentType },
        });
        if (!uploadResult.ok) return setEditProductError(uploadResult.message);
        imageUrl = uploadResult.url;
      }

      const result = await update({
        data: {
          productId: editingProductId,
          name: editProductName,
          price: priceNumber,
          category: editProductCategory,
          unit: editProductUnit,
          packageType: editProductPackageType,
          ...(imageUrl !== undefined ? { imageUrl } : {}),
        },
      });
      if (!result.ok) return setEditProductError(result.message);
      setEditingProductId(null);
      await load();
    } catch {
      setEditProductError("Não foi possível salvar — tente de novo.");
    } finally {
      setEditProductSaving(false);
    }
  }

  async function submitNewProduct() {
    setError(null);
    const priceNumber = Number(price.replace(",", "."));
    if (name.trim().length < 2) return setError("Digite o nome do produto.");
    if (!Number.isFinite(priceNumber) || priceNumber < 0) return setError("Preço inválido.");
    if (!category) return setError("Escolha uma categoria.");

    // Valida a ficha antes de criar o produto: melhor recusar agora do que deixar um produto
    // gravado com a receita pela metade.
    const recipe: Array<
      | { type: "base_drink"; baseDrinkId: string; quantity: number }
      | { type: "ingredient"; ingredientId: string; quantity: number }
    > = [];
    for (const row of components) {
      if (!row.stockId) return setError("Escolha o insumo em todas as linhas, ou remova a linha.");
      const quantity = Number(row.quantity.replace(",", "."));
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return setError("Informe uma quantidade maior que zero para cada insumo.");
      }
      const option = stockOptions.find((item) => item.id === row.stockId);
      if (!option) return setError("Insumo não encontrado — recarregue a página.");
      recipe.push(
        option.kind === "base_drink"
          ? { type: "base_drink", baseDrinkId: option.id, quantity }
          : { type: "ingredient", ingredientId: option.id, quantity },
      );
    }

    setSaving(true);
    let imageUrl: string | undefined;
    if (photoFile) {
      setCompressing(true);
      let compressed: { base64: string; contentType: string };
      try {
        compressed = await compressImageForUpload(photoFile);
      } catch {
        setCompressing(false);
        setSaving(false);
        return setError("Não foi possível processar a foto. Tente outra imagem.");
      }
      setCompressing(false);

      const jpgFileName = photoFile.name.replace(/\.\w+$/, "") + ".jpg";
      const uploadResult = await uploadPhoto({
        data: { fileName: jpgFileName, base64: compressed.base64, contentType: compressed.contentType },
      });
      if (!uploadResult.ok) {
        setSaving(false);
        return setError(uploadResult.message);
      }
      imageUrl = uploadResult.url;
    }

    const result = await create({
      data: {
        name,
        category,
        price: priceNumber,
        unit,
        packageType,
        imageUrl,
        // Produto com ficha técnica não tem estoque próprio: quem controla é o dos insumos.
        stockQuantity: recipe.length > 0 ? undefined : stockQuantity ? Number(stockQuantity) : undefined,
      },
    });
    if (!result.ok) {
      setSaving(false);
      return setError(result.message);
    }

    // O produto já foi gravado. Se a ficha falhar, ele existe sem receita — a mensagem diz onde
    // parou, para a equipe completar em Estoque → Fichas técnicas, em vez de recadastrar tudo.
    if (recipe.length > 0 && result.productId) {
      const saved = await saveRecipe({ data: { productId: result.productId, items: recipe } });
      if (!saved.ok) {
        setSaving(false);
        await load();
        return setError(
          `Produto criado, mas a ficha técnica não foi salva: ${saved.message ?? "complete em Estoque → Fichas técnicas."}`,
        );
      }
    }

    setSaving(false);
    setComponents([]);
    setName("");
    setPrice("");
    setUnit("un");
    setPackageType("Lata");
    setStockQuantity("");
    setPhotoFile(null);
    setShowForm(false);
    setDismissedSuggestionIds(new Set());
    await load();
  }

  const nameMatches = useMemo(() => {
    const query = name.trim().toLowerCase();
    if (query.length < 2) return { products: [], stock: [] };
    return {
      products: products
        .filter((item) => item.name.toLowerCase().includes(query))
        .filter((item) => !dismissedSuggestionIds.has(item.id))
        .slice(0, 5),
      stock: stockOptions
        .filter((item) => item.name.toLowerCase().includes(query))
        .filter((item) => !dismissedSuggestionIds.has(item.id))
        .slice(0, 5),
    };
  }, [name, products, stockOptions, dismissedSuggestionIds]);

  function dismissNameSuggestions() {
    // Ignora TODOS os itens que batem com a busca, não só os 5 exibidos — senão "Ignorar" some
    // o bloco por um instante e ele reaparece na hora com o próximo lote de itens escondidos.
    const query = name.trim().toLowerCase();
    setDismissedSuggestionIds(
      (current) =>
        new Set([
          ...current,
          ...products.filter((item) => item.name.toLowerCase().includes(query)).map((item) => item.id),
          ...stockOptions
            .filter((item) => item.name.toLowerCase().includes(query))
            .map((item) => item.id),
        ]),
    );
  }

  function addComponentFromStock(stockId: string) {
    setComponents((current) => [
      ...current,
      { key: `c-${Date.now()}-${current.length}`, stockId, quantity: "" },
    ]);
    setDismissedSuggestionIds((current) => new Set([...current, stockId]));
  }

  const grouped = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const product of products) {
      const list = map.get(product.category) ?? [];
      list.push(product);
      map.set(product.category, list);
    }
    return Array.from(map.entries());
  }, [products]);


  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Cardápio</p>
          <h1 className="mt-1 text-3xl font-bold">Produtos</h1>
        </div>
        <button
          onClick={() => setShowPreview((value) => !value)}
          className="shrink-0 rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {showPreview ? "Voltar à edição" : "Ver como fica pro cliente"}
        </button>
      </div>

      {loadError && <p className="mt-3 text-sm text-destructive">{loadError}</p>}

      {showPreview ? (
        <CustomerMenuPreview grouped={grouped} recipeProductIds={recipeProductIds} />
      ) : (
        <div className="mt-5 space-y-5">
          {/* Categoria é só a divisão do menu — cadastro próprio, que pede apenas nome. Fica fora
              e antes do formulário de produto de propósito, pra não parecerem a mesma ação. */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">Categorias</p>
              <button
                onClick={() => {
                  setShowCategoryForm((value) => !value);
                  setCategoryError(null);
                  setNewCategoryName("");
                }}
                className="shrink-0 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {showCategoryForm ? "Cancelar" : "+ Nova categoria"}
              </button>
            </div>

            {categories.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">Nenhuma categoria ainda.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {categories.map((cat) =>
                  editingCategoryId === cat.id ? (
                    <span
                      key={cat.id}
                      className="inline-flex items-center gap-1 rounded-full bg-secondary py-1 pl-2 pr-1.5"
                    >
                      <input
                        value={editCategoryName}
                        onChange={(event) => setEditCategoryName(event.target.value)}
                        autoFocus
                        onKeyDown={(event) => event.key === "Enter" && void submitEditCategory()}
                        className="h-7 w-28 rounded-full border border-border bg-background px-2 text-xs outline-none focus:border-ring"
                      />
                      <button
                        onClick={() => void submitEditCategory()}
                        disabled={editCategorySaving}
                        aria-label="Salvar nome da categoria"
                        className="rounded-full px-1 text-primary disabled:opacity-60"
                      >
                        ✓
                      </button>
                      <button
                        onClick={() => setEditingCategoryId(null)}
                        aria-label="Cancelar edição da categoria"
                        className="rounded-full px-1 text-muted-foreground hover:text-foreground"
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <span
                      key={cat.id}
                      className="inline-flex items-center gap-1.5 rounded-full bg-secondary py-1 pl-3 pr-1.5 text-xs font-medium text-secondary-foreground"
                    >
                      <button onClick={() => openEditCategory(cat)} className="hover:underline">
                        {cat.name}
                      </button>
                      <button
                        onClick={() =>
                          setDeletingCategoryId(deletingCategoryId === cat.id ? null : cat.id)
                        }
                        aria-label={`Apagar categoria ${cat.name}`}
                        className="rounded-full px-1 text-muted-foreground hover:text-destructive"
                      >
                        ×
                      </button>
                    </span>
                  ),
                )}
              </div>
            )}
            {editCategoryError && <p className="mt-2 text-xs text-destructive">{editCategoryError}</p>}
            {deletingCategoryId && (
              <div className="mt-2">
                <PasswordConfirm
                  message={`Apagar a categoria "${categories.find((c) => c.id === deletingCategoryId)?.name}"? Só funciona se nenhum produto estiver nela — mude a categoria deles antes. Confirme com a senha da equipe.`}
                  confirmLabel="Apagar categoria"
                  onCancel={() => setDeletingCategoryId(null)}
                  onConfirm={(password) => confirmDeleteCategory(deletingCategoryId, password)}
                />
              </div>
            )}
            {showCategoryForm && (
              <div className="mt-3 flex gap-2">
                <input
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  placeholder="Nome da categoria"
                  autoFocus
                  onKeyDown={(event) => event.key === "Enter" && void submitNewCategory()}
                  className="h-11 flex-1 rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
                />
                <button
                  onClick={() => void submitNewCategory()}
                  disabled={categorySaving || newCategoryName.trim().length < 2}
                  className="h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {categorySaving ? "Salvando..." : "Criar"}
                </button>
              </div>
            )}
            {categoryError && <p className="mt-2 text-xs text-destructive">{categoryError}</p>}
          </div>

          <button
            onClick={() => {
              setShowForm((value) => !value);
              setDismissedSuggestionIds(new Set());
            }}
            className="w-full rounded-xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {showForm ? "Cancelar" : "+ Novo produto"}
          </button>

          {showForm && (
            <SectionCard title="Novo produto do cardápio">
              <div className="space-y-3">
                <TextField label="Nome" value={name} onChange={setName} placeholder="Caipirinha" />
                {(nameMatches.products.length > 0 || nameMatches.stock.length > 0) && (
                    <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold">Já existe algo parecido</p>
                        <button
                          onClick={dismissNameSuggestions}
                          className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Ignorar
                        </button>
                      </div>
                      {nameMatches.products.length > 0 && (
                        <div className="mt-1.5 space-y-1">
                          <p className="text-xs text-muted-foreground">No cardápio:</p>
                          {nameMatches.products.map((item) => (
                            <p key={item.id} className="text-xs">
                              {item.name} · {item.category}
                            </p>
                          ))}
                        </div>
                      )}
                      {nameMatches.stock.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          <p className="text-xs text-muted-foreground">No estoque:</p>
                          {nameMatches.stock.map((item) => (
                            <div key={item.id} className="flex items-center justify-between gap-2">
                              <span className="text-xs">
                                {item.name} ({item.current_stock} {item.unit})
                              </span>
                              <button
                                onClick={() => addComponentFromStock(item.id)}
                                className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                              >
                                + Puxar como insumo
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                {/* Categoria é uma entidade própria (ver seção abaixo) — aqui só escolhe entre as
                    que já existem. Sem opção de criar embutida: criar categoria não é criar produto. */}
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">Categoria</span>
                  {categories.length === 0 ? (
                    <p className="mt-1 rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">
                      Nenhuma categoria cadastrada. Crie uma na seção "Categorias" acima antes de
                      cadastrar o produto.
                    </p>
                  ) : (
                    <select
                      value={category}
                      onChange={(event) => setCategory(event.target.value)}
                      className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                    >
                      {categories.map((option) => (
                        <option key={option.id} value={option.name}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <TextField label="Preço (R$)" value={price} onChange={setPrice} placeholder="18,00" />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-medium text-muted-foreground">Unidade de medida</span>
                    <select
                      value={unit}
                      onChange={(event) => setUnit(event.target.value as (typeof PRODUCT_UNITS)[number])}
                      className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                    >
                      {PRODUCT_UNITS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-muted-foreground">Tipo</span>
                    <select
                      value={packageType}
                      onChange={(event) =>
                        setPackageType(event.target.value as (typeof PRODUCT_PACKAGE_TYPES)[number])
                      }
                      className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                    >
                      {PRODUCT_PACKAGE_TYPES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-3">
                  <p className="text-xs font-semibold">Do que é feito</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Puxe do estoque o que este item consome. A cada venda a baixa acontece sozinha
                    nos insumos. Deixe vazio só se for algo sem controle de estoque nenhum.
                  </p>
                  <p className="mt-1.5 text-xs font-medium text-primary">
                    É uma dose? Clique em "+ Puxar insumo do estoque" abaixo, escolha a garrafa de
                    origem e digite o tamanho da dose em ml no campo ao lado — ex.: Tequila + 50.
                    Não use "Estoque inicial" mais abaixo pra isso.
                  </p>

                  {stockOptions.length === 0 ? (
                    <p className="mt-3 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                      Nada no estoque ainda. Cadastre em Estoque → Bebidas base ou Ingredientes.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {components.map((row) => {
                        const option = stockOptions.find((item) => item.id === row.stockId);
                        return (
                          <div key={row.key} className="flex items-center gap-2">
                            <select
                              value={row.stockId}
                              onChange={(event) =>
                                setComponents((current) =>
                                  current.map((c) =>
                                    c.key === row.key ? { ...c, stockId: event.target.value } : c,
                                  ),
                                )
                              }
                              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-ring"
                            >
                              <option value="">Escolha o insumo</option>
                              {stockOptions.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name} ({item.unit})
                                </option>
                              ))}
                            </select>
                            <input
                              value={row.quantity}
                              onChange={(event) =>
                                setComponents((current) =>
                                  current.map((c) =>
                                    c.key === row.key ? { ...c, quantity: event.target.value } : c,
                                  ),
                                )
                              }
                              placeholder={option ? option.unit : "qtd"}
                              inputMode="decimal"
                              className="h-11 w-24 shrink-0 rounded-xl border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
                            />
                            <button
                              onClick={() =>
                                setComponents((current) => current.filter((c) => c.key !== row.key))
                              }
                              aria-label="Remover insumo"
                              className="shrink-0 rounded-full px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-destructive"
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                      <button
                        onClick={() =>
                          setComponents((current) => [
                            ...current,
                            { key: `c-${Date.now()}-${current.length}`, stockId: "", quantity: "" },
                          ])
                        }
                        className="w-full rounded-lg border border-dashed border-border py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        + Puxar insumo do estoque
                      </button>
                    </div>
                  )}
                </div>

                {/* Produto com ficha técnica tira do estoque dos insumos, então um estoque próprio
                    aqui seria um número paralelo que nunca baixa. Some assim que uma linha de
                    insumo é adicionada — visto ao vivo alguém digitar "60" aqui pensando que era o
                    tamanho da dose, quando o campo certo é o de quantidade em "Do que é feito". */}
                {components.length === 0 && (
                  <TextField
                    label="Estoque inicial (só para item SEM insumo escolhido acima, ex.: cerveja lata fechada)"
                    value={stockQuantity}
                    onChange={setStockQuantity}
                    placeholder="0"
                    type="number"
                  />
                )}
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">Foto (opcional)</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)}
                    className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-xs file:font-medium"
                  />
                </label>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <PrimaryButton onClick={submitNewProduct} disabled={saving}>
                  {compressing ? "Comprimindo foto..." : saving ? "Salvando..." : "Salvar produto"}
                </PrimaryButton>
              </div>
            </SectionCard>
          )}

          {grouped.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
              Nenhum produto cadastrado ainda.
            </p>
          ) : (
            <div className="space-y-6">
              {grouped.map(([categoryName, categoryProducts]) => (
                <div key={categoryName}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                    {categoryName}
                  </p>
                  <ul className="space-y-3">
                    {categoryProducts.map((product) => {
                      // Produto com ficha técnica não tem estoque próprio: quem manda é o estoque
                      // dos componentes. Mostrar "0 un" em vermelho e oferecer "+ Repor" aqui
                      // sugeriria um problema que não existe e um botão que não resolve nada.
                      const hasRecipe = recipeProductIds.has(product.id);
                      const isPending = pendingProductIds.has(product.id);
                      const low = !hasRecipe && product.stock_quantity < LOW_STOCK_THRESHOLD;
                      const isOpen = openRestockId === product.id;
                      const isDeleting = deletingId === product.id;
                      const isEditing = editingProductId === product.id;
                      return (
                        <li key={product.id} className="rounded-2xl border border-border bg-card p-4">
                          {isPending && (
                            <p className="mb-2 text-xs font-medium text-destructive">
                              ⚠ Configuração de estoque pendente — vincule uma ficha técnica ou dê
                              a primeira entrada para liberar a venda.
                            </p>
                          )}
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex min-w-0 items-center gap-3">
                              {product.image_url ? (
                                <img
                                  src={product.image_url}
                                  alt={product.name}
                                  className="h-10 w-10 shrink-0 rounded-lg object-cover"
                                />
                              ) : (
                                <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                              )}
                              <div className="min-w-0">
                                <p className="truncate font-semibold">{product.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {brl(product.price)}
                                  {product.package_type ? ` · ${product.package_type}` : ""}
                                  {product.unit ? ` (${product.unit})` : ""}
                                  {!hasRecipe && product.average_cost > 0
                                    ? ` · custo ${brl(product.average_cost)}`
                                    : ""}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className={`text-sm font-bold ${low ? "text-destructive" : ""}`}>
                                {hasRecipe ? "ficha técnica" : `${product.stock_quantity} un`}
                              </span>
                              {!hasRecipe && (
                                <button
                                  onClick={() => {
                                    setOpenRestockId(isOpen ? null : product.id);
                                    setRestockAmount("");
                                    setRestockCost("");
                                    setDeletingId(null);
                                    setEditingProductId(null);
                                    // Sem isso, o erro de uma linha reaparece no formulário da
                                    // próxima que for aberta.
                                    setRestockError(null);
                                  }}
                                  // Uma entrada por vez: o formulário é compartilhado, então
                                  // abrir outro no meio de um envio mistura as duas linhas.
                                  disabled={busyId !== null && busyId !== product.id}
                                  className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                                >
                                  {isOpen ? "Cancelar" : "+ Entrada"}
                                </button>
                              )}
                              <button
                                onClick={() => (isEditing ? setEditingProductId(null) : openEditProduct(product))}
                                className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                              >
                                {isEditing ? "Cancelar" : "Editar"}
                              </button>
                              <button
                                onClick={() => {
                                  setDeletingId(isDeleting ? null : product.id);
                                  setOpenRestockId(null);
                                  setEditingProductId(null);
                                  setRestockError(null);
                                }}
                                className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                              >
                                Remover
                              </button>
                            </div>
                          </div>

                          {isEditing && (
                            <div className="mt-3 space-y-3 rounded-xl border border-dashed border-border p-3">
                              <TextField label="Nome" value={editProductName} onChange={setEditProductName} />
                              <label className="block">
                                <span className="text-xs font-medium text-muted-foreground">Categoria</span>
                                <select
                                  value={editProductCategory}
                                  onChange={(event) => setEditProductCategory(event.target.value)}
                                  className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                                >
                                  {categories.map((option) => (
                                    <option key={option.id} value={option.name}>
                                      {option.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <TextField label="Preço (R$)" value={editProductPrice} onChange={setEditProductPrice} />
                              <div className="grid grid-cols-2 gap-3">
                                <label className="block">
                                  <span className="text-xs font-medium text-muted-foreground">Unidade de medida</span>
                                  <select
                                    value={editProductUnit}
                                    onChange={(event) =>
                                      setEditProductUnit(event.target.value as (typeof PRODUCT_UNITS)[number])
                                    }
                                    className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                                  >
                                    {PRODUCT_UNITS.map((option) => (
                                      <option key={option} value={option}>
                                        {option}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="block">
                                  <span className="text-xs font-medium text-muted-foreground">Tipo</span>
                                  <select
                                    value={editProductPackageType}
                                    onChange={(event) =>
                                      setEditProductPackageType(
                                        event.target.value as (typeof PRODUCT_PACKAGE_TYPES)[number],
                                      )
                                    }
                                    className="mt-1 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm outline-none focus:border-ring"
                                  >
                                    {PRODUCT_PACKAGE_TYPES.map((option) => (
                                      <option key={option} value={option}>
                                        {option}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                              <label className="block">
                                <span className="text-xs font-medium text-muted-foreground">
                                  Trocar foto (opcional)
                                </span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  onChange={(event) => setEditProductPhotoFile(event.target.files?.[0] ?? null)}
                                  className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-xs file:font-medium"
                                />
                              </label>
                              {editProductError && (
                                <p className="text-xs text-destructive">{editProductError}</p>
                              )}
                              <PrimaryButton onClick={submitEditProduct} disabled={editProductSaving}>
                                {editProductCompressing
                                  ? "Comprimindo foto..."
                                  : editProductSaving
                                    ? "Salvando..."
                                    : "Salvar alterações"}
                              </PrimaryButton>
                            </div>
                          )}

                          {isDeleting && (
                            <div className="mt-3 space-y-2">
                              <PasswordConfirm
                                message={`Tirar “${product.name}” do cardápio? O cadastro e o histórico de vendas continuam guardados — o item só deixa de aparecer para lançamento. Confirme com a senha da equipe.`}
                                confirmLabel="Remover"
                                onCancel={() => setDeletingId(null)}
                                onConfirm={(password) => confirmDelete(product.id, password)}
                              />
                              {/* Só some do banco quando não há histórico de verdade (vendas/
                                  movimentos) — a função no servidor recusa se houver, mesmo com
                                  senha certa. O estoque em si nunca é o que bloqueia. */}
                              <details className="rounded-xl border border-dashed border-border px-3 py-2">
                                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-destructive">
                                  Cadastrei errado — apagar de vez (sem histórico)
                                </summary>
                                <div className="mt-2">
                                  <PasswordConfirm
                                    message={`Apagar “${product.name}” de vez? Só funciona se ele nunca teve venda nem movimento de estoque registrado — não dá pra desfazer. Confirme com a senha da equipe.`}
                                    confirmLabel="Apagar de vez"
                                    onCancel={() => setDeletingId(null)}
                                    onConfirm={(password) => confirmDeletePermanently(product.id, password)}
                                  />
                                </div>
                              </details>
                            </div>
                          )}

                          {isOpen && (
                            <div className="mt-3">
                              <div className="flex gap-2">
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={1}
                                  value={restockAmount}
                                  onChange={(event) => setRestockAmount(event.target.value)}
                                  placeholder={
                                    product.purchase_unit
                                      ? `Quantas ${product.purchase_unit}`
                                      : "Quantidade"
                                  }
                                  autoFocus
                                  className="h-11 flex-1 rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
                                />
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={restockCost}
                                  onChange={(event) => setRestockCost(event.target.value)}
                                  placeholder="Total pago (R$)"
                                  className="h-11 flex-1 rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
                                />
                              </div>
                              {Number(restockAmount) > 0 && (
                                <p className="mt-2 text-xs text-muted-foreground">
                                  Entram{" "}
                                  {Number(restockAmount) *
                                    product.units_per_pack *
                                    Number(product.content_amount)}{" "}
                                  un no estoque
                                  {Number(restockCost.replace(",", ".")) > 0
                                    ? ` · ${brl(
                                        Number(restockCost.replace(",", ".")) /
                                          (Number(restockAmount) *
                                            product.units_per_pack *
                                            Number(product.content_amount)),
                                      )} por un`
                                    : ""}
                                </p>
                              )}
                              <button
                                onClick={() => confirmRestock(product.id)}
                                disabled={busyId === product.id || !restockAmount}
                                className="mt-2 h-11 w-full rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                              >
                                {busyId === product.id ? "Salvando..." : "Confirmar entrada"}
                              </button>
                              {restockError && (
                                <p className="mt-2 text-xs text-destructive">{restockError}</p>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

/** Prévia somente-leitura: como o cardápio aparece pra quem está lançando/vendo pelo lado do cliente. */
function CustomerMenuPreview(props: {
  grouped: Array<[string, Product[]]>;
  recipeProductIds: Set<string>;
}) {
  // O cliente só vê produto ativo, então a categoria que ficou sem nenhum não deve aparecer
  // como um título solto com grade vazia.
  const visible = props.grouped
    .map(([name, items]) => [name, items.filter((p) => p.is_active)] as [string, Product[]])
    .filter(([, items]) => items.length > 0);

  if (visible.length === 0) {
    return (
      <p className="mt-6 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
        Nenhum produto ativo no cardápio.
      </p>
    );
  }

  return (
    <div className="mt-5 space-y-6">
      {visible.map(([categoryName, categoryProducts]) => (
        <div key={categoryName}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            {categoryName}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {categoryProducts
              .map((product) => {
                // stock_quantity só é confiável pra produto sem ficha técnica (ex.: cerveja lata) —
                // produto com receita depende do estoque dos componentes, não desse campo.
                const soldOut =
                  !props.recipeProductIds.has(product.id) && product.stock_quantity <= 0;
                return (
                  <div
                    key={product.id}
                    className={`flex items-center gap-3 rounded-2xl border border-border bg-card p-3 ${soldOut ? "opacity-50" : ""}`}
                  >
                    {product.image_url ? (
                      <img
                        src={product.image_url}
                        alt={product.name}
                        className="h-10 w-10 shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold leading-snug">{product.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {soldOut ? "Esgotado" : brl(Number(product.price))}
                      </p>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
