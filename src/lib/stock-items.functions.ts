import { createServerFn } from "@tanstack/react-start";

const TIPOS = ["insumo", "semiacabado", "acabado", "revenda"] as const;
export type ItemTipo = (typeof TIPOS)[number];

export const TIPO_LABELS: Record<ItemTipo, string> = {
  insumo: "Insumo",
  semiacabado: "Semiacabado",
  acabado: "Acabado",
  revenda: "Revenda",
};

// ============ UNIDADES ============

/** Lista fixa (g, kg, ml, l, un) semeada pela migration — raramente muda, por isso cacheável no cliente. */
export const listUnidades = createServerFn({ method: "GET" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data } = await admin()
    .from("pop9_fastbar_unidades")
    .select("id, codigo, nome, dimensao")
    .order("dimensao")
    .order("fator_base");
  return { unidades: data ?? [] };
});

// ============ ITENS ============

export const listItems = createServerFn({ method: "POST" })
  .inputValidator((data: { tipo?: ItemTipo } | undefined) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    let query = admin()
      .from("pop9_fastbar_itens")
      .select(
        "id, nome, tipo, estoque_atual, estoque_minimo, custo_medio, ativo, unidade_estoque_id, pop9_fastbar_unidades(codigo, nome)",
      )
      .eq("ativo", true)
      .order("nome");
    if (data?.tipo) query = query.eq("tipo", data.tipo);
    const { data: items } = await query;
    return { items: items ?? [] };
  });

/**
 * Nome é único (case-insensitive, garantido por índice) porque produção e ficha técnica resolvem
 * item por nome em telas de busca — dois itens "Molho" e "molho" seriam indistinguíveis pra quem
 * está lançando.
 */
export const createItem = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      nome: string;
      tipo: ItemTipo;
      unidadeEstoqueId: string;
      estoqueMinimo?: number;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const nome = data.nome.trim();
    if (nome.length < 2) return { ok: false as const, message: "Nome inválido." };
    if (!TIPOS.includes(data.tipo)) return { ok: false as const, message: "Tipo inválido." };
    const estoqueMinimo = data.estoqueMinimo ?? 0;
    if (!Number.isFinite(estoqueMinimo) || estoqueMinimo < 0) {
      return { ok: false as const, message: "Estoque mínimo inválido." };
    }

    const { error } = await admin().from("pop9_fastbar_itens").insert({
      nome,
      tipo: data.tipo,
      unidade_estoque_id: data.unidadeEstoqueId,
      estoque_minimo: estoqueMinimo,
    });
    if (error) {
      // unique_violation do índice case-insensitive por nome.
      if (error.code === "23505") return { ok: false as const, message: "Já existe um item com esse nome." };
      return { ok: false as const, message: "Não foi possível salvar o item." };
    }
    return { ok: true as const };
  });

export const updateItem = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      id: string;
      nome: string;
      tipo: ItemTipo;
      estoqueMinimo: number;
      ativo: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const nome = data.nome.trim();
    if (nome.length < 2) return { ok: false as const, message: "Nome inválido." };
    if (!TIPOS.includes(data.tipo)) return { ok: false as const, message: "Tipo inválido." };
    if (!Number.isFinite(data.estoqueMinimo) || data.estoqueMinimo < 0) {
      return { ok: false as const, message: "Estoque mínimo inválido." };
    }

    const { error } = await admin()
      .from("pop9_fastbar_itens")
      .update({
        nome,
        tipo: data.tipo,
        estoque_minimo: data.estoqueMinimo,
        ativo: data.ativo,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) {
      if (error.code === "23505") return { ok: false as const, message: "Já existe um item com esse nome." };
      return { ok: false as const, message: "Não foi possível atualizar o item." };
    }
    return { ok: true as const };
  });

/**
 * Igual ao padrão de exclusão dos produtos/insumos antigos: recusa apagar o que tem rastro
 * (ficha técnica, componente de outra ficha, produto do cardápio vinculado ou movimento de
 * estoque) — apagar destruiria histórico de venda/produção. "Desativar" (updateItem com
 * ativo=false) é o caminho pra tirar de circulação sem perder o rastro.
 */
export const deleteItem = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    const [ficha, componente, produto, movimento] = await Promise.all([
      admin().from("pop9_fastbar_fichas").select("id").eq("item_produzido_id", data.id).limit(1),
      admin().from("pop9_fastbar_ficha_componentes").select("id").eq("item_id", data.id).limit(1),
      admin().from("pop9_fastbar_products").select("id").eq("item_id", data.id).limit(1),
      admin().from("pop9_fastbar_item_movimentos").select("id").eq("item_id", data.id).limit(1),
    ]);
    if (
      (ficha.data?.length ?? 0) > 0 ||
      (componente.data?.length ?? 0) > 0 ||
      (produto.data?.length ?? 0) > 0 ||
      (movimento.data?.length ?? 0) > 0
    ) {
      return {
        ok: false as const,
        message:
          "Esse item já tem ficha técnica, produto vinculado ou movimento -- desative em vez de apagar.",
      };
    }

    const { error, count } = await admin()
      .from("pop9_fastbar_itens")
      .delete({ count: "exact" })
      .eq("id", data.id);
    if (error) return { ok: false as const, message: "Não foi possível apagar o item." };
    if (!count) return { ok: false as const, message: "Item não encontrado." };
    return { ok: true as const };
  });

// ============ EMBALAGENS DE COMPRA ============

export const listEmbalagens = createServerFn({ method: "POST" })
  .inputValidator((data: { itemId: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const { data: embalagens } = await admin()
      .from("pop9_fastbar_item_embalagens")
      .select("id, nome, quantidade_por_embalagem, padrao, ativo, pop9_fastbar_unidades(codigo, nome)")
      .eq("item_id", data.itemId)
      .eq("ativo", true)
      .order("padrao", { ascending: false })
      .order("nome");
    return { embalagens: embalagens ?? [] };
  });

export const createEmbalagem = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      itemId: string;
      nome: string;
      quantidadePorEmbalagem: number;
      unidadeConteudoId: string;
      padrao?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const nome = data.nome.trim();
    if (nome.length < 2) return { ok: false as const, message: "Nome da embalagem inválido." };
    if (!Number.isFinite(data.quantidadePorEmbalagem) || data.quantidadePorEmbalagem <= 0) {
      return { ok: false as const, message: "Quantidade por embalagem deve ser maior que zero." };
    }

    // Só uma embalagem padrão por item (garantido também por índice único parcial no banco) --
    // desmarca a anterior antes de marcar a nova, pra "Definir como padrão" ser uma troca, não uma
    // segunda marcação que o índice rejeitaria.
    if (data.padrao) {
      await admin()
        .from("pop9_fastbar_item_embalagens")
        .update({ padrao: false })
        .eq("item_id", data.itemId)
        .eq("padrao", true);
    }

    const { error } = await admin().from("pop9_fastbar_item_embalagens").insert({
      item_id: data.itemId,
      nome,
      quantidade_por_embalagem: data.quantidadePorEmbalagem,
      unidade_conteudo_id: data.unidadeConteudoId,
      padrao: data.padrao ?? false,
    });
    if (error) return { ok: false as const, message: "Não foi possível salvar a embalagem." };
    return { ok: true as const };
  });

export const deleteEmbalagem = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    // Embalagem não tem histórico próprio (a entrada de compra registra na unidade de estoque,
    // não na embalagem) -- apagar de verdade é seguro, ao contrário de item/produto.
    const { error } = await admin().from("pop9_fastbar_item_embalagens").delete().eq("id", data.id);
    if (error) return { ok: false as const, message: "Não foi possível apagar a embalagem." };
    return { ok: true as const };
  });
