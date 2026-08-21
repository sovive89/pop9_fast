import { createServerFn } from "@tanstack/react-start";

export const getStockOverview = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const [{ data: products }, { data: recipeLinks }, { data: movementLinks }] = await Promise.all([
    admin()
      .from("pop9_fastbar_products")
      .select(
        "id, name, category, price, unit, package_type, is_active, stock_quantity, image_url, purchase_unit, units_per_pack, content_amount, average_cost",
      )
      .order("category")
      .order("name"),
    admin().from("pop9_fastbar_recipe_items").select("product_id"),
    admin().from("pop9_fastbar_stock_movements").select("product_id"),
  ]);
  // Produtos com ficha técnica não têm stock_quantity próprio confiável — quem controla
  // disponibilidade pra eles é o estoque dos componentes (bebidas base/ingredientes), não este campo.
  const recipeProductIds = Array.from(new Set((recipeLinks ?? []).map((link) => link.product_id)));
  // "Configurado" = tem ficha técnica OU já recebeu ao menos uma entrada de estoque — mesmo
  // critério que fastbar_add_tab_item usa pra bloquear a venda. Sem nenhum dos dois, o item nunca
  // teve sua origem de estoque definida.
  const movedProductIds = new Set((movementLinks ?? []).map((link) => link.product_id));
  const recipeSet = new Set(recipeProductIds);
  const pendingProductIds = (products ?? [])
    .filter((product) => !recipeSet.has(product.id) && !movedProductIds.has(product.id))
    .map((product) => product.id);
  return { products: products ?? [], recipeProductIds, pendingProductIds };
});

export const restockProduct = createServerFn({ method: "POST" })
  .inputValidator((data: { productId: string; quantity: number }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const quantity = Math.floor(Number(data.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false as const, message: "Informe uma quantidade válida." };
    }

    // O saldo é somado dentro do banco (`set stock_quantity = stock_quantity + n`), junto com o
    // registro do movimento. Ler o saldo aqui e gravar depois perderia uma das entradas se duas
    // reposições acontecessem ao mesmo tempo.
    const { data: result, error } = await admin().rpc("pop9_fastbar_restock_product", {
      p_product_id: data.productId,
      p_quantity: quantity,
    });
    const parsed = result as { ok: boolean; code?: string; new_quantity?: number } | null;
    if (error || !parsed) {
      return { ok: false as const, message: "Não foi possível registrar a entrada." };
    }
    if (!parsed.ok) {
      return {
        ok: false as const,
        message:
          parsed.code === "product_not_found"
            ? "Produto não encontrado."
            : "Informe uma quantidade válida.",
      };
    }
    return { ok: true as const, newQuantity: parsed.new_quantity ?? 0 };
  });

/**
 * Entrada de compra de um produto de revenda (cerveja em lata, água): quantas embalagens chegaram
 * e quanto foi pago no total. A quantidade em unidades e o custo por unidade são sempre calculados
 * a partir daí, nunca digitados — mesmo motivo que vale para os insumos.
 *
 * "Repor" (restockProduct) continua existindo para ajuste solto de quantidade, sem nota fiscal.
 */
export const addProductEntry = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      productId: string;
      packs: number;
      purchaseCost?: number | undefined;
      supplierId?: string | undefined;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const packs = Math.floor(Number(data.packs));
    if (!Number.isFinite(packs) || packs <= 0) {
      return { ok: false as const, message: "Informe uma quantidade válida." };
    }

    const { data: result, error } = await admin().rpc("pop9_fastbar_add_product_entry", {
      p_product_id: data.productId,
      p_packs: packs,
      ...(data.purchaseCost !== undefined ? { p_purchase_cost: data.purchaseCost } : {}),
      ...(data.supplierId !== undefined ? { p_supplier_id: data.supplierId } : {}),
    });
    const parsed = result as { ok: boolean; code?: string; quantity?: number } | null;
    if (error || !parsed) {
      return { ok: false as const, message: "Não foi possível registrar a entrada." };
    }
    if (!parsed.ok) {
      return {
        ok: false as const,
        message:
          parsed.code === "product_not_found"
            ? "Produto não encontrado."
            : "Informe uma quantidade válida.",
      };
    }
    return { ok: true as const, quantity: parsed.quantity ?? 0 };
  });
