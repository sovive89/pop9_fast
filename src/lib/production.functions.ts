import { createServerFn } from "@tanstack/react-start";

// ============ FICHAS TÉCNICAS ============

export const listFichas = createServerFn({ method: "GET" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data } = await admin()
    .from("pop9_fastbar_fichas")
    .select(
      "id, rendimento_quantidade, modo_preparo, ativa, item_produzido:pop9_fastbar_itens!pop9_fastbar_fichas_item_produzido_id_fkey(id, nome, tipo, unidade_estoque_id), rendimento_unidade:pop9_fastbar_unidades!pop9_fastbar_fichas_rendimento_unidade_id_fkey(codigo, nome)",
    )
    .eq("ativa", true)
    .order("created_at", { ascending: false });
  return { fichas: data ?? [] };
});

export const getFichaComponentes = createServerFn({ method: "POST" })
  .inputValidator((data: { fichaId: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const { data: componentes } = await admin()
      .from("pop9_fastbar_ficha_componentes")
      .select(
        "id, quantidade, item:pop9_fastbar_itens!pop9_fastbar_ficha_componentes_item_id_fkey(id, nome, estoque_atual, unidade_estoque_id), unidade:pop9_fastbar_unidades!pop9_fastbar_ficha_componentes_unidade_id_fkey(codigo, nome)",
      )
      .eq("ficha_id", data.fichaId);
    return { componentes: componentes ?? [] };
  });

/**
 * Só uma ficha ativa por item produzido (garantido também por índice único parcial no banco) --
 * criar uma nova pro mesmo item sem desativar a antiga falharia; aqui isso já é tratado como erro
 * amigável em vez de mensagem genérica de banco.
 */
export const createFicha = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      itemProduzidoId: string;
      rendimentoQuantidade: number;
      rendimentoUnidadeId: string;
      modoPreparo?: string;
      componentes: Array<{ itemId: string; quantidade: number; unidadeId: string }>;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    if (!Number.isFinite(data.rendimentoQuantidade) || data.rendimentoQuantidade <= 0) {
      return { ok: false as const, message: "Rendimento deve ser maior que zero." };
    }
    if (data.componentes.length === 0) {
      return { ok: false as const, message: "Adicione ao menos um componente." };
    }
    for (const c of data.componentes) {
      if (!Number.isFinite(c.quantidade) || c.quantidade <= 0) {
        return { ok: false as const, message: "Quantidade de componente inválida." };
      }
    }

    const { data: ficha, error } = await admin()
      .from("pop9_fastbar_fichas")
      .insert({
        item_produzido_id: data.itemProduzidoId,
        rendimento_quantidade: data.rendimentoQuantidade,
        rendimento_unidade_id: data.rendimentoUnidadeId,
        modo_preparo: data.modoPreparo?.trim() || null,
      })
      .select("id")
      .single();

    if (error || !ficha) {
      if (error?.code === "23505") {
        return {
          ok: false as const,
          message: "Esse item já tem uma ficha ativa -- desative a atual antes de criar outra.",
        };
      }
      return { ok: false as const, message: "Não foi possível salvar a ficha." };
    }

    const { error: componentesError } = await admin().from("pop9_fastbar_ficha_componentes").insert(
      data.componentes.map((c) => ({
        ficha_id: ficha.id,
        item_id: c.itemId,
        quantidade: c.quantidade,
        unidade_id: c.unidadeId,
      })),
    );
    if (componentesError) {
      // Ficha sem componente nenhum não serve pra nada -- desfaz, pra não sobrar lixo pela metade.
      await admin().from("pop9_fastbar_fichas").delete().eq("id", ficha.id);
      return { ok: false as const, message: "Não foi possível salvar os componentes da ficha." };
    }

    return { ok: true as const, fichaId: ficha.id as string };
  });

export const deactivateFicha = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const { error } = await admin()
      .from("pop9_fastbar_fichas")
      .update({ ativa: false, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) return { ok: false as const, message: "Não foi possível desativar a ficha." };
    return { ok: true as const };
  });

// ============ PRODUÇÃO ============

type RegistrarProducaoResult = {
  ok: boolean;
  code?: string;
  item?: string;
  necessario?: number;
  disponivel?: number;
  producao_id?: string;
  quantidade_produzida?: number;
  custo_total?: number;
};

/** Chama a função do banco -- toda a lógica de validar saldo, debitar e creditar mora lá,
 * atômica, pra produção nunca ficar pela metade se algo falhar no meio. */
export const registrarProducao = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { fichaId: string; lotes: number; observacao?: string; validade?: string }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();

    if (!Number.isFinite(data.lotes) || data.lotes <= 0) {
      return { ok: false as const, message: "Número de lotes inválido." };
    }

    const { data: result, error } = await admin().rpc("pop9_fastbar_registrar_producao", {
      p_ficha_id: data.fichaId,
      p_lotes: data.lotes,
      p_observacao: data.observacao?.trim() || null,
      p_validade: data.validade || null,
    });
    if (error) return { ok: false as const, message: "Não foi possível registrar a produção." };

    const r = result as RegistrarProducaoResult;
    if (!r.ok) {
      if (r.code === "estoque_insuficiente") {
        return {
          ok: false as const,
          message: `Sem estoque de ${r.item} (precisa de ${r.necessario}, tem ${r.disponivel}).`,
        };
      }
      if (r.code === "ficha_nao_encontrada") {
        return { ok: false as const, message: "Ficha não encontrada ou inativa." };
      }
      return { ok: false as const, message: "Não foi possível registrar a produção." };
    }

    return {
      ok: true as const,
      quantidadeProduzida: r.quantidade_produzida ?? 0,
      custoTotal: r.custo_total ?? 0,
    };
  });

export const listProducoes = createServerFn({ method: "GET" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  await assertRegisterAccess();
  const { data } = await admin()
    .from("pop9_fastbar_producoes")
    .select(
      "id, quantidade_produzida, custo_total, observacao, created_at, item_produzido:pop9_fastbar_itens!pop9_fastbar_producoes_item_produzido_id_fkey(nome), unidade:pop9_fastbar_unidades!pop9_fastbar_producoes_unidade_id_fkey(codigo)",
    )
    .order("created_at", { ascending: false })
    .limit(30);
  return { producoes: data ?? [] };
});
