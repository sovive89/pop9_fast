import { createServerFn } from "@tanstack/react-start";

type PackagingInput = {
  purchaseUnit?: string | undefined;
  unitsPerPack?: number | undefined;
  contentAmount?: number | undefined;
};

/**
 * Valida a embalagem de compra. Recusa valor inválido em vez de normalizar em silêncio: salvar
 * uma embalagem diferente da que a pessoa digitou faria toda entrada futura calcular quantidade e
 * custo errados. units_per_pack/content_amount só podem fugir de 1×1 se houver purchase_unit —
 * sem isso a tela de entrada mostra "direto em ml/g/un" e multiplicaria pela embalagem escondida.
 */
function readPackaging(data: PackagingInput) {
  const unitsPerPack = data.unitsPerPack ?? 1;
  const contentAmount = data.contentAmount ?? 1;
  if (!Number.isInteger(unitsPerPack) || unitsPerPack <= 0) {
    return { ok: false as const, message: "Itens por embalagem deve ser um número inteiro maior que zero." };
  }
  if (!Number.isFinite(contentAmount) || contentAmount <= 0 || contentAmount >= 1000000) {
    return { ok: false as const, message: "Conteúdo por item deve ser maior que zero." };
  }
  if (!data.purchaseUnit?.trim() && (unitsPerPack !== 1 || contentAmount !== 1)) {
    return {
      ok: false as const,
      message: "Informe a unidade de compra (garrafa, caixa...) antes de mudar a embalagem.",
    };
  }
  return { ok: true as const, unitsPerPack, contentAmount };
}

/** Lê o total pago de uma entrada. `undefined` = entrada sem custo informado (permitido). */
function readPurchaseCost(value: number | undefined) {
  if (value === undefined) return { ok: true as const, purchaseCost: null };
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false as const, message: "Valor pago inválido." };
  }
  return { ok: true as const, purchaseCost: value > 0 ? value : null };
}

// ============ FORNECEDORES ============

export const listSuppliers = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data } = await admin()
    .from("pop9_fastbar_suppliers")
    .select("id, name, document, phone, active")
    .eq("active", true)
    .order("name");
  return { suppliers: data ?? [] };
});

export const createSupplier = createServerFn({ method: "POST" })
  .inputValidator((data: { name: string; document?: string; phone?: string; email?: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const name = data.name.trim();
    if (name.length < 2) return { ok: false as const, message: "Nome do fornecedor inválido." };
    const { error } = await admin().from("pop9_fastbar_suppliers").insert({
      name,
      document: data.document?.trim() || null,
      phone: data.phone?.trim() || null,
      email: data.email?.trim() || null,
    });
    if (error) return { ok: false as const, message: "Não foi possível salvar o fornecedor." };
    return { ok: true as const };
  });

// ============ INSUMOS (garrafas/pacotes) ============

export const listBaseDrinks = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data } = await admin()
    .from("pop9_fastbar_base_drinks")
    .select(
      "id, name, unit, current_stock, min_stock, average_cost, active, purchase_unit, units_per_pack, content_amount",
    )
    .eq("active", true)
    .order("name");
  return { baseDrinks: data ?? [] };
});

export const createBaseDrink = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      unit: "ml" | "un";
      minStock?: number | undefined;
      purchaseUnit?: string | undefined;
      unitsPerPack?: number | undefined;
      contentAmount?: number | undefined;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const name = data.name.trim();
    if (name.length < 2) return { ok: false as const, message: "Nome da bebida base inválido." };
    if (data.unit !== "ml" && data.unit !== "un") {
      return { ok: false as const, message: "Unidade inválida." };
    }
    const packaging = readPackaging(data);
    if (!packaging.ok) return packaging;
    // Devolve o id para que a tela consiga dar a entrada de estoque logo em seguida, no mesmo
    // gesto de cadastrar — é assim que a compra acontece no bar: chega a mercadoria e se registra
    // o que chegou, não "cadastra agora e informa a quantidade depois".
    const { data: created, error } = await admin()
      .from("pop9_fastbar_base_drinks")
      .insert({
        name,
        unit: data.unit,
        min_stock: data.minStock && data.minStock > 0 ? data.minStock : 0,
        purchase_unit: data.purchaseUnit?.trim() || null,
        units_per_pack: packaging.unitsPerPack,
        content_amount: packaging.contentAmount,
      })
      .select("id")
      .maybeSingle();
    if (error || !created) {
      return { ok: false as const, message: "Não foi possível salvar a bebida base." };
    }
    return { ok: true as const, id: created.id };
  });

/**
 * Ajusta a embalagem de compra de uma bebida base já cadastrada. Necessário porque insumos criados
 * antes desse campo existir ficam em 1×1, o que faria a entrada de estoque pedir "embalagens" e
 * somar a quantidade errada.
 */
export const updateBaseDrinkPackaging = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      baseDrinkId: string;
      purchaseUnit?: string | undefined;
      unitsPerPack?: number | undefined;
      contentAmount?: number | undefined;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const packaging = readPackaging(data);
    if (!packaging.ok) return packaging;
    const { error } = await admin()
      .from("pop9_fastbar_base_drinks")
      .update({
        purchase_unit: data.purchaseUnit?.trim() || null,
        units_per_pack: packaging.unitsPerPack,
        content_amount: packaging.contentAmount,
      })
      .eq("id", data.baseDrinkId);
    if (error) return { ok: false as const, message: "Não foi possível salvar a embalagem." };
    return { ok: true as const };
  });

const DELETE_MESSAGES: Record<string, string> = {
  in_use_by_recipe: "Esse insumo está numa ficha técnica — remova a ligação antes de apagar.",
  has_sales_history: "Esse insumo já saiu em vendas de verdade — apagar perderia o rastro.",
  not_found: "Insumo não encontrado.",
};

/**
 * Apaga a bebida base de vez. O número de estoque nunca bloqueia — o que impede é uso real: estar
 * numa ficha técnica ou já ter saído por venda. Uma entrada de compra errada sozinha (sem venda)
 * não bloqueia, porque é exatamente o caso que essa ação existe pra resolver: "cadastrei garrafa
 * de 1L com conteúdo 1 em vez de 1000, quero apagar e refazer certo".
 */
export const deleteBaseDrink = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; password: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    const { teamPasswordMatches } = await import("./bar-gate.server");
    await assertRegisterAccess();
    if (!teamPasswordMatches(data.password)) {
      return { ok: false as const, message: "Senha incorreta." };
    }
    const { data: result, error } = await admin().rpc("pop9_fastbar_delete_base_drink", {
      p_id: data.id,
    });
    const parsed = result as { ok: boolean; code?: string } | null;
    if (error || !parsed) return { ok: false as const, message: "Não foi possível apagar." };
    if (!parsed.ok) {
      return {
        ok: false as const,
        message: DELETE_MESSAGES[parsed.code ?? ""] ?? "Não foi possível apagar.",
      };
    }
    return { ok: true as const };
  });

/**
 * Dá entrada de estoque numa bebida base (compra). A equipe informa quantas embalagens de compra
 * (ex.: garrafas, caixas) e o custo total pago — a quantidade em `unit` e o custo por `unit` são
 * sempre calculados a partir de units_per_pack/content_amount, nunca digitados diretamente.
 */
export const addBaseDrinkEntry = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      baseDrinkId: string;
      packs: number;
      purchaseCost?: number | undefined;
      supplierId?: string | undefined;
      note?: string | undefined;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const packs = Number(data.packs);
    if (!Number.isInteger(packs) || packs <= 0) {
      return { ok: false as const, message: "Informe uma quantidade de embalagens válida." };
    }

    const cost = readPurchaseCost(data.purchaseCost);
    if (!cost.ok) return cost;

    const { data: material } = await admin()
      .from("pop9_fastbar_base_drinks")
      .select("id, current_stock, average_cost, units_per_pack, content_amount")
      .eq("id", data.baseDrinkId)
      .maybeSingle();
    if (!material) return { ok: false as const, message: "Bebida base não encontrada." };

    const quantity = packs * material.units_per_pack * Number(material.content_amount);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false as const, message: "Embalagem mal configurada — revise o cadastro." };
    }
    const unitCost = cost.purchaseCost !== null ? cost.purchaseCost / quantity : null;

    const { error: movementError } = await admin().from("pop9_fastbar_base_drink_movements").insert({
      base_drink_id: material.id,
      type: "entrada",
      quantity,
      reason: "compra",
      supplier_id: data.supplierId || null,
      unit_cost: unitCost,
      note: data.note?.trim() || null,
    });
    if (movementError) {
      return { ok: false as const, message: "Não foi possível registrar a entrada." };
    }

    // custo médio ponderado, se veio custo nesta entrada
    const currentStock = Number(material.current_stock);
    const currentAvg = Number(material.average_cost);
    const newStock = currentStock + quantity;
    const newAvg =
      unitCost !== null && newStock > 0
        ? (currentStock * currentAvg + quantity * unitCost) / newStock
        : currentAvg;

    const { error: updateError } = await admin()
      .from("pop9_fastbar_base_drinks")
      .update({ current_stock: newStock, average_cost: newAvg })
      .eq("id", material.id);
    if (updateError) {
      return { ok: false as const, message: "Não foi possível atualizar o estoque da bebida base." };
    }

    return { ok: true as const, newStock };
  });

/**
 * Registrar perda existe pra desperdício deixar de ser invisível: até essa função, o único jeito
 * de tirar quantidade do estoque sem venda era editar o número na mão, sem deixar rastro de por
 * quê. Com reason="perda" e o custo médio já cadastrado no item, dá pra somar o valor perdido ao
 * longo do tempo sem precisar que ninguém digite preço de novo aqui.
 */
export const addBaseDrinkLoss = createServerFn({ method: "POST" })
  .inputValidator((data: { baseDrinkId: string; quantity: number; note?: string | undefined }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const quantity = Number(data.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false as const, message: "Informe uma quantidade perdida válida." };
    }

    const { data: material } = await admin()
      .from("pop9_fastbar_base_drinks")
      .select("id, current_stock, average_cost")
      .eq("id", data.baseDrinkId)
      .maybeSingle();
    if (!material) return { ok: false as const, message: "Bebida base não encontrada." };

    const newStock = Number(material.current_stock) - quantity;
    if (newStock < 0) {
      return { ok: false as const, message: "Quantidade maior do que o estoque atual." };
    }

    const { error: movementError } = await admin().from("pop9_fastbar_base_drink_movements").insert({
      base_drink_id: material.id,
      type: "saida",
      quantity,
      reason: "perda",
      unit_cost: material.average_cost,
      note: data.note?.trim() || null,
    });
    if (movementError) {
      return { ok: false as const, message: "Não foi possível registrar a perda." };
    }

    const { error: updateError } = await admin()
      .from("pop9_fastbar_base_drinks")
      .update({ current_stock: newStock })
      .eq("id", material.id);
    if (updateError) {
      return { ok: false as const, message: "Não foi possível atualizar o estoque da bebida base." };
    }

    return { ok: true as const, newStock };
  });

// ============ INGREDIENTES DE DRINK (xarope, suco, refrigerante etc.) ============
// Nunca vendidos sozinhos — só existem pra entrar numa mistura.

export const listIngredients = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data } = await admin()
    .from("pop9_fastbar_drink_ingredients")
    .select(
      "id, name, unit, current_stock, min_stock, average_cost, active, purchase_unit, units_per_pack, content_amount",
    )
    .eq("active", true)
    .order("name");
  return { ingredients: data ?? [] };
});

export const createIngredient = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      unit: "ml" | "un" | "g";
      minStock?: number | undefined;
      purchaseUnit?: string | undefined;
      unitsPerPack?: number | undefined;
      contentAmount?: number | undefined;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const name = data.name.trim();
    if (name.length < 2) return { ok: false as const, message: "Nome do ingrediente inválido." };
    if (!["ml", "un", "g"].includes(data.unit)) {
      return { ok: false as const, message: "Unidade inválida." };
    }
    const packaging = readPackaging(data);
    if (!packaging.ok) return packaging;
    // Mesmo motivo de createBaseDrink: o id volta para a tela dar a entrada em seguida.
    const { data: created, error } = await admin()
      .from("pop9_fastbar_drink_ingredients")
      .insert({
        name,
        unit: data.unit,
        min_stock: data.minStock && data.minStock > 0 ? data.minStock : 0,
        purchase_unit: data.purchaseUnit?.trim() || null,
        units_per_pack: packaging.unitsPerPack,
        content_amount: packaging.contentAmount,
      })
      .select("id")
      .maybeSingle();
    if (error || !created) {
      return { ok: false as const, message: "Não foi possível salvar o ingrediente." };
    }
    return { ok: true as const, id: created.id };
  });

/** Ajusta a embalagem de compra de um ingrediente já cadastrado — mesmo motivo da bebida base. */
export const updateIngredientPackaging = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      ingredientId: string;
      purchaseUnit?: string | undefined;
      unitsPerPack?: number | undefined;
      contentAmount?: number | undefined;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const packaging = readPackaging(data);
    if (!packaging.ok) return packaging;
    const { error } = await admin()
      .from("pop9_fastbar_drink_ingredients")
      .update({
        purchase_unit: data.purchaseUnit?.trim() || null,
        units_per_pack: packaging.unitsPerPack,
        content_amount: packaging.contentAmount,
      })
      .eq("id", data.ingredientId);
    if (error) return { ok: false as const, message: "Não foi possível salvar a embalagem." };
    return { ok: true as const };
  });

/** Apaga o ingrediente de vez. Mesmo critério da bebida base: histórico real bloqueia, número de estoque não. */
export const deleteIngredient = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; password: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    const { teamPasswordMatches } = await import("./bar-gate.server");
    await assertRegisterAccess();
    if (!teamPasswordMatches(data.password)) {
      return { ok: false as const, message: "Senha incorreta." };
    }
    const { data: result, error } = await admin().rpc("pop9_fastbar_delete_ingredient", {
      p_id: data.id,
    });
    const parsed = result as { ok: boolean; code?: string } | null;
    if (error || !parsed) return { ok: false as const, message: "Não foi possível apagar." };
    if (!parsed.ok) {
      return {
        ok: false as const,
        message: DELETE_MESSAGES[parsed.code ?? ""] ?? "Não foi possível apagar.",
      };
    }
    return { ok: true as const };
  });

/**
 * Dá entrada de estoque num ingrediente (compra) — mesmo padrão da bebida base: embalagens de
 * compra + custo total pago, com quantidade e custo por `unit` sempre calculados.
 */
export const addIngredientEntry = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      ingredientId: string;
      packs: number;
      purchaseCost?: number | undefined;
      supplierId?: string | undefined;
      note?: string | undefined;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const packs = Number(data.packs);
    if (!Number.isInteger(packs) || packs <= 0) {
      return { ok: false as const, message: "Informe uma quantidade de embalagens válida." };
    }

    const cost = readPurchaseCost(data.purchaseCost);
    if (!cost.ok) return cost;

    const { data: ingredient } = await admin()
      .from("pop9_fastbar_drink_ingredients")
      .select("id, current_stock, average_cost, units_per_pack, content_amount")
      .eq("id", data.ingredientId)
      .maybeSingle();
    if (!ingredient) return { ok: false as const, message: "Ingrediente não encontrado." };

    const quantity = packs * ingredient.units_per_pack * Number(ingredient.content_amount);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false as const, message: "Embalagem mal configurada — revise o cadastro." };
    }
    const unitCost = cost.purchaseCost !== null ? cost.purchaseCost / quantity : null;

    const { error: movementError } = await admin().from("pop9_fastbar_drink_ingredient_movements").insert({
      ingredient_id: ingredient.id,
      type: "entrada",
      quantity,
      reason: "compra",
      supplier_id: data.supplierId || null,
      unit_cost: unitCost,
      note: data.note?.trim() || null,
    });
    if (movementError) {
      return { ok: false as const, message: "Não foi possível registrar a entrada." };
    }

    const currentStock = Number(ingredient.current_stock);
    const currentAvg = Number(ingredient.average_cost);
    const newStock = currentStock + quantity;
    const newAvg =
      unitCost !== null && newStock > 0
        ? (currentStock * currentAvg + quantity * unitCost) / newStock
        : currentAvg;

    const { error: updateError } = await admin()
      .from("pop9_fastbar_drink_ingredients")
      .update({ current_stock: newStock, average_cost: newAvg })
      .eq("id", ingredient.id);
    if (updateError) {
      return { ok: false as const, message: "Não foi possível atualizar o estoque do ingrediente." };
    }

    return { ok: true as const, newStock };
  });

/** Mesma lógica de addBaseDrinkLoss, pro lado dos ingredientes. */
export const addIngredientLoss = createServerFn({ method: "POST" })
  .inputValidator((data: { ingredientId: string; quantity: number; note?: string | undefined }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const quantity = Number(data.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false as const, message: "Informe uma quantidade perdida válida." };
    }

    const { data: ingredient } = await admin()
      .from("pop9_fastbar_drink_ingredients")
      .select("id, current_stock, average_cost")
      .eq("id", data.ingredientId)
      .maybeSingle();
    if (!ingredient) return { ok: false as const, message: "Ingrediente não encontrado." };

    const newStock = Number(ingredient.current_stock) - quantity;
    if (newStock < 0) {
      return { ok: false as const, message: "Quantidade maior do que o estoque atual." };
    }

    const { error: movementError } = await admin().from("pop9_fastbar_drink_ingredient_movements").insert({
      ingredient_id: ingredient.id,
      type: "saida",
      quantity,
      reason: "perda",
      unit_cost: ingredient.average_cost,
      note: data.note?.trim() || null,
    });
    if (movementError) {
      return { ok: false as const, message: "Não foi possível registrar a perda." };
    }

    const { error: updateError } = await admin()
      .from("pop9_fastbar_drink_ingredients")
      .update({ current_stock: newStock })
      .eq("id", ingredient.id);
    if (updateError) {
      return { ok: false as const, message: "Não foi possível atualizar o estoque do ingrediente." };
    }

    return { ok: true as const, newStock };
  });

// ============ PRODUTOS (cardápio) ============

export const listAllProducts = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data } = await admin()
    .from("pop9_fastbar_products")
    .select("id, name, category, is_active")
    .order("category")
    .order("name");
  return { products: data ?? [] };
});

/**
 * Categoria do cardápio é a divisão do menu (Bebidas, Doses, Drinks) — nada além de um nome.
 * Entidade própria, separada do formulário de produto, pra criar uma categoria nova nunca exigir
 * preencher preço/unidade/foto de um produto que não existe.
 */
export const listProductCategories = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data, error } = await admin()
    .from("pop9_fastbar_product_categories")
    .select("id, name")
    .order("name");
  // Falha de leitura não pode virar "lista vazia" — isso faria a tela mandar a equipe "criar uma
  // categoria" quando o problema real é o banco fora do ar, escondendo o erro em vez de mostrar.
  if (error) throw new Error("Não foi possível carregar as categorias.");
  return { categories: data ?? [] };
});

export const createProductCategory = createServerFn({ method: "POST" })
  .inputValidator((data: { name: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    if (typeof data.name !== "string") {
      return { ok: false as const, message: "Digite um nome de categoria." };
    }
    const name = data.name.trim();
    if (name.length < 2) return { ok: false as const, message: "Digite um nome de categoria." };

    const { error } = await admin().from("pop9_fastbar_product_categories").insert({ name });
    if (error) {
      // Nome único: categoria repetida (mesmo com maiúscula/minúscula diferente) cai aqui.
      if (error.code === "23505") {
        return { ok: false as const, message: "Já existe uma categoria com esse nome." };
      }
      return { ok: false as const, message: "Não foi possível criar a categoria." };
    }
    return { ok: true as const };
  });

/** Apaga a categoria — só se nenhum produto estiver nela. Reatribua os produtos antes de apagar. */
export const deleteProductCategory = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; password: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    const { teamPasswordMatches } = await import("./bar-gate.server");
    await assertRegisterAccess();
    if (!teamPasswordMatches(data.password)) {
      return { ok: false as const, message: "Senha incorreta." };
    }
    const { data: result, error } = await admin().rpc("pop9_fastbar_delete_product_category", {
      p_id: data.id,
    });
    const parsed = result as { ok: boolean; code?: string; count?: number } | null;
    if (error || !parsed) return { ok: false as const, message: "Não foi possível apagar." };
    if (!parsed.ok) {
      return {
        ok: false as const,
        message:
          parsed.code === "in_use"
            ? `Ainda tem ${parsed.count} produto(s) nessa categoria — mude a categoria deles antes de apagar.`
            : "Categoria não encontrada.",
      };
    }
    return { ok: true as const };
  });

/** Renomeia a categoria — propaga pros produtos que estavam nela. Não exige senha: renomear não
 * é destrutivo (ao contrário de apagar), é só ajuste de texto. */
export const updateProductCategory = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; name: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const { data: result, error } = await admin().rpc("pop9_fastbar_update_product_category", {
      p_id: data.id,
      p_name: data.name,
    });
    const parsed = result as { ok: boolean; code?: string } | null;
    if (error || !parsed) return { ok: false as const, message: "Não foi possível renomear." };
    if (!parsed.ok) {
      const messages: Record<string, string> = {
        not_found: "Categoria não encontrada.",
        invalid_name: "Digite um nome de categoria.",
        duplicate: "Já existe uma categoria com esse nome.",
      };
      return { ok: false as const, message: messages[parsed.code ?? ""] ?? "Não foi possível renomear." };
    }
    return { ok: true as const };
  });

export const PRODUCT_UNITS = ["un", "ml", "L", "g", "kg"] as const;
export const PRODUCT_PACKAGE_TYPES = [
  "Lata",
  "Garrafa",
  "Dose",
  "Barril",
  "Copo",
  "Porção",
  "Outro",
] as const;

export const createProduct = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      price: number;
      category: string;
      unit: string;
      packageType?: string;
      imageUrl?: string;
      stockQuantity?: number;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const name = data.name.trim();
    const price = Number(data.price);
    const unit = PRODUCT_UNITS.includes(data.unit as (typeof PRODUCT_UNITS)[number])
      ? data.unit
      : "un";
    if (name.length < 2) return { ok: false as const, message: "Nome do produto inválido." };
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false as const, message: "Preço inválido." };
    }

    const initialStock =
      data.stockQuantity && data.stockQuantity > 0 ? Math.floor(data.stockQuantity) : 0;

    // A checagem de categoria e a inserção do produto acontecem juntas, travando a linha da
    // categoria (fastbar_create_product), pra fechar a mesma corrida já fechada nas exclusões:
    // sem isso, a categoria podia ser lida como existente aqui e apagada por outra aba entre a
    // leitura e o insert, deixando o produto com um nome de categoria que não existe mais.
    const { data: result, error } = await admin().rpc("pop9_fastbar_create_product", {
      p_name: name,
      p_price: price,
      p_category: data.category.trim(),
      p_unit: unit,
      p_package_type: data.packageType?.trim() || null,
      p_image_url: data.imageUrl?.trim() || null,
      p_initial_stock: initialStock,
    });
    const parsed = result as { ok: boolean; code?: string; product_id?: string } | null;
    if (error || !parsed) return { ok: false as const, message: "Não foi possível salvar o produto." };
    if (!parsed.ok) {
      return {
        ok: false as const,
        message: parsed.code === "category_not_found" ? "Escolha uma categoria válida." : "Não foi possível salvar o produto.",
      };
    }

    return { ok: true as const, productId: parsed.product_id! };
  });

/** Edita nome, preço, categoria, unidade, tipo de embalagem e (opcionalmente) foto de um produto
 * já cadastrado. Não mexe na ficha técnica nem no estoque — isso continua em Estoque → Ficha
 * técnica e nos botões de entrada, que já têm suas próprias telas. */
/** Remove um objeto do bucket fastbar-products, mas só se nenhum outro produto ainda o referencia
 * — createProduct/updateProduct aceitam a image_url que o cliente manda de volta depois do
 * upload, sem travar dono único do arquivo, então apagar sem checar isso podia derrubar a foto de
 * um produto diferente que aproveitou a mesma URL. */
async function removeProductPhotoIfUnused(
  admin: (typeof import("./fastbar.server"))["admin"],
  imageUrl: string,
) {
  const { count } = await admin()
    .from("pop9_fastbar_products")
    .select("id", { count: "exact", head: true })
    .eq("image_url", imageUrl);
  if (count) return;
  const marker = "/fastbar-products/";
  const index = imageUrl.indexOf(marker);
  if (index === -1) return;
  const path = imageUrl.slice(index + marker.length);
  await admin().storage.from("fastbar-products").remove([path]);
}

export const updateProduct = createServerFn({ method: "POST" })
  .inputValidator(
    // packageType é obrigatório aqui (diferente de createProduct): omitir gravaria null e
    // apagaria o tipo de embalagem que o produto já tinha numa edição que nem mexia nisso.
    (data: {
      productId: string;
      name: string;
      price: number;
      category: string;
      unit: string;
      packageType: string;
      imageUrl?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const name = data.name.trim();
    const price = Number(data.price);
    const unit = PRODUCT_UNITS.includes(data.unit as (typeof PRODUCT_UNITS)[number])
      ? data.unit
      : "un";
    if (name.length < 2) return { ok: false as const, message: "Nome do produto inválido." };
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false as const, message: "Preço inválido." };
    }

    const changeImage = typeof data.imageUrl === "string";
    const newImageUrl = changeImage ? data.imageUrl!.trim() || null : null;

    // Busca a foto atual antes de trocar: depois do UPDATE não tem mais como saber qual era.
    const { data: before } = changeImage
      ? await admin().from("pop9_fastbar_products").select("image_url").eq("id", data.productId).maybeSingle()
      : { data: null };

    const { data: result, error } = await admin().rpc("pop9_fastbar_update_product", {
      p_id: data.productId,
      p_name: name,
      p_price: price,
      p_category: data.category.trim(),
      p_unit: unit,
      p_package_type: data.packageType?.trim() || null,
      p_image_url: newImageUrl,
      p_change_image: changeImage,
    });
    const parsed = result as { ok: boolean; code?: string } | null;
    if (error || !parsed) {
      // A troca não foi gravada — o arquivo recém-subido não tem produto nenhum apontando pra
      // ele. Best-effort: se a limpeza falhar aqui, sobra um órfão no bucket, não um estado
      // inconsistente no cardápio.
      if (changeImage && newImageUrl) await removeProductPhotoIfUnused(admin, newImageUrl);
      return { ok: false as const, message: "Não foi possível salvar as alterações." };
    }
    if (!parsed.ok) {
      if (changeImage && newImageUrl) await removeProductPhotoIfUnused(admin, newImageUrl);
      const messages: Record<string, string> = {
        not_found: "Produto não encontrado.",
        category_not_found: "Escolha uma categoria válida.",
      };
      return {
        ok: false as const,
        message: messages[parsed.code ?? ""] ?? "Não foi possível salvar as alterações.",
      };
    }

    // Gravou com sucesso: a foto antiga (se havia e é diferente da nova) virou órfã.
    if (changeImage && before?.image_url && before.image_url !== newImageUrl) {
      await removeProductPhotoIfUnused(admin, before.image_url);
    }

    return { ok: true as const };
  });

/** Recebe uma imagem em base64 (data URL) e sobe pro Storage, devolvendo a URL pública. */
export const uploadProductPhoto = createServerFn({ method: "POST" })
  .inputValidator((data: { fileName: string; base64: string; contentType: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${Date.now()}-${safeName}`;
    const bytes = Buffer.from(data.base64, "base64");

    const { error } = await admin()
      .storage.from("fastbar-products")
      .upload(path, bytes, { contentType: data.contentType, upsert: false });
    if (error) return { ok: false as const, message: "Não foi possível enviar a foto." };

    const { data: publicUrl } = admin().storage.from("fastbar-products").getPublicUrl(path);
    return { ok: true as const, url: publicUrl.publicUrl };
  });

// ============ FICHA TÉCNICA (receita) ============
// Cada linha da receita aponta pra UM componente: uma bebida base OU um ingrediente.

export const getRecipeItems = createServerFn({ method: "POST" })
  .inputValidator((data: { productId: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const { data: items } = await admin()
      .from("pop9_fastbar_recipe_items")
      .select(
        "id, base_drink_id, ingredient_id, quantity, fastbar_base_drinks(name, unit), fastbar_drink_ingredients(name, unit)",
      )
      .eq("product_id", data.productId);

    // O join do supabase-js pode vir como objeto único ou array de 1 — normaliza pra objeto único.
    type Joined = { name: string; unit: string } | { name: string; unit: string }[] | null;
    const unwrap = (value: Joined) => (Array.isArray(value) ? (value[0] ?? null) : value);

    const normalized = (items ?? []).map((item) => ({
      id: item.id,
      base_drink_id: item.base_drink_id,
      ingredient_id: item.ingredient_id,
      quantity: item.quantity,
      base_drink: unwrap(item.fastbar_base_drinks as Joined),
      ingredient: unwrap(item.fastbar_drink_ingredients as Joined),
    }));

    return { items: normalized };
  });

/** Substitui a ficha técnica inteira do produto pelos itens enviados. */
export const setRecipeItems = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      productId: string;
      items: Array<
        | { type: "base_drink"; baseDrinkId: string; quantity: number }
        | { type: "ingredient"; ingredientId: string; quantity: number }
      >;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const valid = data.items.filter((item) => Number(item.quantity) > 0);

    await admin().from("pop9_fastbar_recipe_items").delete().eq("product_id", data.productId);

    if (valid.length > 0) {
      const { error } = await admin().from("pop9_fastbar_recipe_items").insert(
        valid.map((item) => ({
          product_id: data.productId,
          base_drink_id: item.type === "base_drink" ? item.baseDrinkId : null,
          ingredient_id: item.type === "ingredient" ? item.ingredientId : null,
          quantity: Number(item.quantity),
        })),
      );
      if (error) return { ok: false as const, message: "Não foi possível salvar a ficha técnica." };
    }

    return { ok: true as const };
  });

type DoseInfo = { productName: string; doses: number };

/** Visão geral do estoque (bebidas base + ingredientes) com doses possíveis já calculadas. */
export const getBaseDrinksOverview = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();

  const [{ data: baseDrinks }, { data: ingredients }, { data: recipes }] = await Promise.all([
    admin()
      .from("pop9_fastbar_base_drinks")
      .select(
        "id, name, unit, current_stock, min_stock, average_cost, purchase_unit, units_per_pack, content_amount",
      )
      .eq("active", true)
      .order("name"),
    admin()
      .from("pop9_fastbar_drink_ingredients")
      .select(
        "id, name, unit, current_stock, min_stock, average_cost, purchase_unit, units_per_pack, content_amount",
      )
      .eq("active", true)
      .order("name"),
    admin()
      .from("pop9_fastbar_recipe_items")
      .select("product_id, base_drink_id, ingredient_id, quantity, fastbar_products(name)"),
  ]);

  const dosesByComponent = new Map<string, DoseInfo[]>();
  for (const recipe of recipes ?? []) {
    const componentId = recipe.base_drink_id ?? recipe.ingredient_id;
    const stockSource = recipe.base_drink_id
      ? (baseDrinks ?? []).find((m) => m.id === recipe.base_drink_id)
      : (ingredients ?? []).find((i) => i.id === recipe.ingredient_id);
    if (!componentId || !stockSource || recipe.quantity <= 0) continue;
    const doses = Math.floor(Number(stockSource.current_stock) / Number(recipe.quantity));
    const list = dosesByComponent.get(componentId) ?? [];
    const productJoin = (recipe as { fastbar_products?: { name: string } | { name: string }[] | null })
      .fastbar_products;
    const productName = Array.isArray(productJoin) ? productJoin[0]?.name : productJoin?.name;
    list.push({ productName: productName ?? "—", doses });
    dosesByComponent.set(componentId, list);
  }

  return {
    baseDrinks: (baseDrinks ?? []).map((item) => ({
      ...item,
      doses: dosesByComponent.get(item.id) ?? [],
    })),
    ingredients: (ingredients ?? []).map((item) => ({
      ...item,
      doses: dosesByComponent.get(item.id) ?? [],
    })),
  };
});

/**
 * Relatório do módulo Estoque: valor parado em estoque e o que está abaixo do mínimo. Cruza as
 * três tabelas de inventário (bebidas base, ingredientes, produtos de revenda) — cada uma com sua
 * própria noção de custo médio, mas só bebidas base e ingredientes têm min_stock cadastrado;
 * produto de revenda só entra no alerta de "zerado", não de "abaixo do mínimo".
 */
export const getStockReport = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  const { valueOf, monthKey } = await import("./analytics");
  await assertRegisterAccess();

  const [{ data: baseDrinks }, { data: ingredients }, { data: products }] = await Promise.all([
    admin()
      .from("pop9_fastbar_base_drinks")
      .select("id, name, unit, current_stock, min_stock, average_cost")
      .eq("active", true),
    admin()
      .from("pop9_fastbar_drink_ingredients")
      .select("id, name, unit, current_stock, min_stock, average_cost")
      .eq("active", true),
    admin()
      .from("pop9_fastbar_products")
      .select("id, name, category, stock_quantity, average_cost")
      .eq("is_active", true),
  ]);

  const baseDrinksValue = (baseDrinks ?? []).reduce(
    (sum, i) => sum + valueOf(i.current_stock, i.average_cost),
    0,
  );
  const ingredientsValue = (ingredients ?? []).reduce(
    (sum, i) => sum + valueOf(i.current_stock, i.average_cost),
    0,
  );
  const productsValue = (products ?? []).reduce(
    (sum, i) => sum + valueOf(i.stock_quantity, i.average_cost),
    0,
  );

  const lowStock = [
    ...(baseDrinks ?? [])
      .filter((i) => Number(i.current_stock) < Number(i.min_stock))
      .map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        current: Number(i.current_stock),
        min: Number(i.min_stock),
        kind: "Bebida base" as const,
      })),
    ...(ingredients ?? [])
      .filter((i) => Number(i.current_stock) < Number(i.min_stock))
      .map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        current: Number(i.current_stock),
        min: Number(i.min_stock),
        kind: "Ingrediente" as const,
      })),
  ].sort((a, b) => a.current / a.min - b.current / b.min);

  const outOfStockProducts = (products ?? [])
    .filter((p) => Number(p.stock_quantity) <= 0)
    .map((p) => ({ id: p.id, name: p.name, category: p.category }));

  // Desperdício: soma reason="perda" dos dois tipos de movimento, com o nome do item que perdeu
  // e agrupado por mês — "ao longo do tempo" só faz sentido comparando um mês com o anterior, não
  // um número solto. Não existe histórico antes dessa função porque a ação de registrar perda não
  // existia até agora: os meses vão aparecer vazios até a equipe começar a usar.
  const nameByBaseDrinkId = new Map((baseDrinks ?? []).map((i) => [i.id, i.name]));
  const nameByIngredientId = new Map((ingredients ?? []).map((i) => [i.id, i.name]));

  const [{ data: baseDrinkLosses }, { data: ingredientLosses }] = await Promise.all([
    admin()
      .from("pop9_fastbar_base_drink_movements")
      .select("base_drink_id, quantity, unit_cost, created_at")
      .eq("reason", "perda"),
    admin()
      .from("pop9_fastbar_drink_ingredient_movements")
      .select("ingredient_id, quantity, unit_cost, created_at")
      .eq("reason", "perda"),
  ]);

  const wasteByItem = new Map<string, { name: string; quantity: number; value: number }>();
  const wasteByMonth = new Map<string, number>();
  let wasteValueTotal = 0;

  for (const loss of baseDrinkLosses ?? []) {
    const name = nameByBaseDrinkId.get(loss.base_drink_id) ?? "—";
    const value = valueOf(loss.quantity, loss.unit_cost);
    const current = wasteByItem.get(loss.base_drink_id) ?? { name, quantity: 0, value: 0 };
    current.quantity += Number(loss.quantity);
    current.value += value;
    wasteByItem.set(loss.base_drink_id, current);
    const month = monthKey(loss.created_at);
    wasteByMonth.set(month, (wasteByMonth.get(month) ?? 0) + value);
    wasteValueTotal += value;
  }
  for (const loss of ingredientLosses ?? []) {
    const name = nameByIngredientId.get(loss.ingredient_id) ?? "—";
    const value = valueOf(loss.quantity, loss.unit_cost);
    const current = wasteByItem.get(loss.ingredient_id) ?? { name, quantity: 0, value: 0 };
    current.quantity += Number(loss.quantity);
    current.value += value;
    wasteByItem.set(loss.ingredient_id, current);
    const month = monthKey(loss.created_at);
    wasteByMonth.set(month, (wasteByMonth.get(month) ?? 0) + value);
    wasteValueTotal += value;
  }

  return {
    totalValue: baseDrinksValue + ingredientsValue + productsValue,
    valueByKind: {
      "Bebidas base": baseDrinksValue,
      Ingredientes: ingredientsValue,
      "Produtos de revenda": productsValue,
    },
    lowStock,
    outOfStockProducts,
    waste: {
      totalValue: wasteValueTotal,
      byItem: Array.from(wasteByItem.values()).sort((a, b) => b.value - a.value),
      byMonth: Array.from(wasteByMonth.entries())
        .map(([month, value]) => ({ month, value }))
        .sort((a, b) => a.month.localeCompare(b.month)),
    },
  };
});
