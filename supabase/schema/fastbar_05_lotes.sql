-- ============================================================================
-- pop9 — Parte 5: lotes e validade, com prefixo pop9_
-- ============================================================================
--  Roda depois das Partes 1-4. Todo objeto tocado começa com `pop9_` — nada
--  aqui altera, lê ou apaga tabela de produção do fast_bar.
--
--  pop9_fastbar_itens.estoque_atual continua sendo o número que todo o resto
--  do sistema já lê (validação de venda, tela de itens). Lote é uma camada de
--  rastreabilidade POR CIMA disso, não substitui: a soma de quantidade_restante
--  dos lotes de um item deve bater com o estoque_atual dele.
--
--  Consumo respeita FEFO (first-expire-first-out): lote sem validade entra
--  por último na fila, depois dos que vencem mais cedo -- é assim que se evita
--  vencer estoque parado enquanto o mais novo sai primeiro.
-- ============================================================================

begin;

create table if not exists public.pop9_fastbar_lotes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.pop9_fastbar_itens(id) on delete cascade,
  quantidade_inicial numeric not null,
  quantidade_restante numeric not null,
  unidade_id uuid not null references public.pop9_fastbar_unidades(id),
  custo_unitario numeric not null default 0,
  validade date,
  origem text not null,
  fornecedor_id uuid references public.pop9_fastbar_suppliers(id),
  producao_id uuid references public.pop9_fastbar_producoes(id),
  movimento_id uuid references public.pop9_fastbar_item_movimentos(id),
  created_at timestamptz not null default now(),
  -- 'ajuste' cobre estorno de venda: não dá pra saber de qual lote específico a
  -- unidade vendida saiu, então a devolução vira um lote novo, sem validade
  -- (não temos como recuperar a validade original), só pra manter a soma de
  -- quantidade_restante batendo com estoque_atual.
  constraint pop9_fastbar_lotes_origem_check check (origem in ('compra', 'producao', 'ajuste')),
  constraint pop9_fastbar_lotes_quantidade_inicial_positiva check (quantidade_inicial > 0),
  constraint pop9_fastbar_lotes_quantidade_restante_valida
    check (quantidade_restante >= 0 and quantidade_restante <= quantidade_inicial)
);

create index if not exists pop9_fastbar_lotes_item_fefo_idx
  on public.pop9_fastbar_lotes (item_id, validade nulls last, created_at)
  where quantidade_restante > 0;

-- ------------------------------------------------- consumir lotes (FEFO, interno)
-- Debita quantidade_necessaria dos lotes do item, do que vence mais cedo pro que vence
-- mais tarde (nulo por último). Só mexe em lotes -- quem chama já debitou estoque_atual
-- antes, na mesma transação; se os lotes estiverem defasados em relação ao agregado
-- (drift), consome o que existir sem falhar a operação -- o número que todo o resto do
-- sistema confia é o estoque_atual, já validado por quem chamou.
create or replace function public.pop9_fastbar_consumir_lotes(
  p_item_id uuid,
  p_quantidade numeric
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restante numeric := p_quantidade;
  v_consumir numeric;
  lote record;
begin
  if coalesce(p_quantidade, 0) <= 0 then
    return;
  end if;

  for lote in
    select id, quantidade_restante
    from public.pop9_fastbar_lotes
    where item_id = p_item_id and quantidade_restante > 0
    order by validade nulls last, created_at
    for update
  loop
    exit when v_restante <= 0;
    v_consumir := least(lote.quantidade_restante, v_restante);
    update public.pop9_fastbar_lotes
    set quantidade_restante = quantidade_restante - v_consumir
    where id = lote.id;
    v_restante := v_restante - v_consumir;
  end loop;
end;
$$;

-- ------------------------------------------------- entrada de estoque (cria lote)
-- Usada por insumo/revenda: registra a compra, cria o lote com validade opcional,
-- credita estoque_atual e recalcula custo médio ponderado.
create or replace function public.pop9_fastbar_registrar_entrada_estoque(
  p_item_id uuid,
  p_quantidade numeric,
  p_unidade_id uuid,
  p_valor_pago numeric default null,
  p_validade date default null,
  p_fornecedor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_qtd_convertida numeric;
  v_custo_unitario numeric := 0;
  v_movimento_id uuid;
  v_lote_id uuid;
begin
  if coalesce(p_quantidade, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_quantity');
  end if;

  select id, unidade_estoque_id, estoque_atual, custo_medio into v_item
  from public.pop9_fastbar_itens
  where id = p_item_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'item_not_found');
  end if;

  v_qtd_convertida := public.pop9_fastbar_converter(p_quantidade, p_unidade_id, v_item.unidade_estoque_id);

  if p_valor_pago is not null and p_valor_pago > 0 then
    v_custo_unitario := p_valor_pago / v_qtd_convertida;
  end if;

  insert into public.pop9_fastbar_item_movimentos
    (item_id, tipo, quantidade, unidade_id, custo_unitario, fornecedor_id, nota)
  values
    (p_item_id, 'entrada', v_qtd_convertida, v_item.unidade_estoque_id, v_custo_unitario, p_fornecedor_id,
     'Entrada de compra')
  returning id into v_movimento_id;

  insert into public.pop9_fastbar_lotes
    (item_id, quantidade_inicial, quantidade_restante, unidade_id, custo_unitario, validade, origem,
     fornecedor_id, movimento_id)
  values
    (p_item_id, v_qtd_convertida, v_qtd_convertida, v_item.unidade_estoque_id, v_custo_unitario, p_validade,
     'compra', p_fornecedor_id, v_movimento_id)
  returning id into v_lote_id;

  update public.pop9_fastbar_itens
  set custo_medio = case
        when v_custo_unitario > 0 and (estoque_atual + v_qtd_convertida) > 0
          then ((estoque_atual * custo_medio) + (v_qtd_convertida * v_custo_unitario))
               / (estoque_atual + v_qtd_convertida)
        else custo_medio
      end,
      estoque_atual = estoque_atual + v_qtd_convertida,
      updated_at = now()
  where id = p_item_id;

  return jsonb_build_object(
    'ok', true,
    'lote_id', v_lote_id,
    'quantidade_convertida', v_qtd_convertida
  );
end;
$$;

-- ------------------------------------------------- registrar produção (com lote/validade)
-- Mesma função de antes, com duas adições: recebe p_validade pro lote do item produzido, e
-- os componentes debitados agora também consomem de seus lotes em ordem FEFO (a validação de
-- saldo continua olhando estoque_atual, que segue sendo o número autoritativo).
create or replace function public.pop9_fastbar_registrar_producao(
  p_ficha_id uuid,
  p_lotes numeric default 1,
  p_observacao text default null,
  p_validade date default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ficha record;
  v_producao_id uuid;
  v_lote_id uuid;
  v_movimento_producao_id uuid;
  v_custo_total numeric := 0;
  v_necessario numeric;
  v_disponivel numeric;
  v_produzido numeric;
  c record;
begin
  if coalesce(p_lotes, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'lotes_invalidos');
  end if;

  select f.*, i.unidade_estoque_id as item_unidade_id
  into v_ficha
  from public.pop9_fastbar_fichas f
  join public.pop9_fastbar_itens i on i.id = f.item_produzido_id
  where f.id = p_ficha_id and f.ativa
  for update of f;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'ficha_nao_encontrada');
  end if;

  for c in
    select fc.item_id, fc.quantidade, fc.unidade_id, it.nome, it.unidade_estoque_id, it.custo_medio
    from public.pop9_fastbar_ficha_componentes fc
    join public.pop9_fastbar_itens it on it.id = fc.item_id
    where fc.ficha_id = p_ficha_id
    order by fc.item_id
  loop
    v_necessario := public.pop9_fastbar_converter(
      c.quantidade * p_lotes, c.unidade_id, c.unidade_estoque_id
    );

    select estoque_atual into v_disponivel
    from public.pop9_fastbar_itens
    where id = c.item_id
    for update;

    if v_disponivel < v_necessario then
      return jsonb_build_object(
        'ok', false,
        'code', 'estoque_insuficiente',
        'item', c.nome,
        'necessario', v_necessario,
        'disponivel', v_disponivel
      );
    end if;

    v_custo_total := v_custo_total + (v_necessario * c.custo_medio);
  end loop;

  v_produzido := public.pop9_fastbar_converter(
    v_ficha.rendimento_quantidade * p_lotes,
    v_ficha.rendimento_unidade_id,
    v_ficha.item_unidade_id
  );

  insert into public.pop9_fastbar_producoes (
    ficha_id, item_produzido_id, quantidade_produzida, unidade_id, custo_total, observacao
  )
  values (
    p_ficha_id, v_ficha.item_produzido_id, v_produzido, v_ficha.item_unidade_id,
    v_custo_total, p_observacao
  )
  returning id into v_producao_id;

  for c in
    select fc.item_id, fc.quantidade, fc.unidade_id, it.unidade_estoque_id
    from public.pop9_fastbar_ficha_componentes fc
    join public.pop9_fastbar_itens it on it.id = fc.item_id
    where fc.ficha_id = p_ficha_id
    order by fc.item_id
  loop
    v_necessario := public.pop9_fastbar_converter(
      c.quantidade * p_lotes, c.unidade_id, c.unidade_estoque_id
    );

    update public.pop9_fastbar_itens
    set estoque_atual = estoque_atual - v_necessario,
        updated_at = now()
    where id = c.item_id;

    perform public.pop9_fastbar_consumir_lotes(c.item_id, v_necessario);

    insert into public.pop9_fastbar_item_movimentos (
      item_id, tipo, quantidade, unidade_id, producao_id, nota
    )
    values (
      c.item_id, 'consumo', v_necessario, c.unidade_estoque_id, v_producao_id,
      'Consumo em produção'
    );
  end loop;

  update public.pop9_fastbar_itens
  set custo_medio = case
        when estoque_atual + v_produzido > 0
          then ((estoque_atual * custo_medio) + v_custo_total) / (estoque_atual + v_produzido)
        else custo_medio
      end,
      estoque_atual = estoque_atual + v_produzido,
      updated_at = now()
  where id = v_ficha.item_produzido_id;

  insert into public.pop9_fastbar_item_movimentos (
    item_id, tipo, quantidade, unidade_id, custo_unitario, producao_id, nota
  )
  values (
    v_ficha.item_produzido_id, 'producao', v_produzido, v_ficha.item_unidade_id,
    case when v_produzido > 0 then v_custo_total / v_produzido else 0 end,
    v_producao_id, 'Entrada por produção'
  )
  returning id into v_movimento_producao_id;

  insert into public.pop9_fastbar_lotes (
    item_id, quantidade_inicial, quantidade_restante, unidade_id, custo_unitario, validade,
    origem, producao_id, movimento_id
  )
  values (
    v_ficha.item_produzido_id, v_produzido, v_produzido, v_ficha.item_unidade_id,
    case when v_produzido > 0 then v_custo_total / v_produzido else 0 end,
    p_validade, 'producao', v_producao_id, v_movimento_producao_id
  )
  returning id into v_lote_id;

  return jsonb_build_object(
    'ok', true,
    'producao_id', v_producao_id,
    'lote_id', v_lote_id,
    'quantidade_produzida', v_produzido,
    'custo_total', v_custo_total
  );
end;
$$;

-- ---------------------------------------------------------------- pop9_fastbar_apply_sale_stock
-- Mesma função da Parte 4, com uma adição: o ramo de item vinculado agora também
-- consome dos lotes do item (FEFO), pra lote e estoque_atual não dessincronizarem
-- assim que o primeiro acabado for vendido.
create or replace function public.pop9_fastbar_apply_sale_stock(
  p_product_id uuid,
  p_session_id uuid,
  p_quantity integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_amount numeric;
  v_item_id uuid;
  v_unidade_id uuid;
begin
  if p_product_id is null or coalesce(p_quantity, 0) <= 0 then
    return;
  end if;

  insert into public.pop9_fastbar_stock_movements (product_id, session_id, quantity, movement_type, note)
  values (p_product_id, p_session_id, p_quantity, 'out', 'Lançamento na comanda');

  select item_id into v_item_id from public.pop9_fastbar_products where id = p_product_id;

  if v_item_id is not null then
    select unidade_estoque_id into v_unidade_id
    from public.pop9_fastbar_itens where id = v_item_id;

    update public.pop9_fastbar_itens
    set estoque_atual = estoque_atual - p_quantity,
        updated_at = now()
    where id = v_item_id;

    perform public.pop9_fastbar_consumir_lotes(v_item_id, p_quantity);

    insert into public.pop9_fastbar_item_movimentos
      (item_id, tipo, quantidade, unidade_id, session_id, nota)
    values (v_item_id, 'saida', p_quantity, v_unidade_id, p_session_id, 'Baixa automática por venda');

    -- Item vinculado não reprocessa ficha técnica — já foi consumida na produção.
    return;
  end if;

  update public.pop9_fastbar_products
  set stock_quantity = stock_quantity - p_quantity
  where id = p_product_id;

  for r in
    select base_drink_id, ingredient_id, quantity
    from public.pop9_fastbar_recipe_items
    where product_id = p_product_id
    order by base_drink_id nulls last, ingredient_id nulls last
  loop
    v_amount := r.quantity * p_quantity;
    if v_amount <= 0 then
      continue;
    end if;

    if r.base_drink_id is not null then
      insert into public.pop9_fastbar_base_drink_movements (base_drink_id, type, quantity, reason, note)
      values (r.base_drink_id, 'saida', v_amount, 'venda', 'Baixa automática por venda');

      update public.pop9_fastbar_base_drinks
      set current_stock = current_stock - v_amount
      where id = r.base_drink_id;

    elsif r.ingredient_id is not null then
      insert into public.pop9_fastbar_drink_ingredient_movements (ingredient_id, type, quantity, reason, note)
      values (r.ingredient_id, 'saida', v_amount, 'venda', 'Baixa automática por venda');

      update public.pop9_fastbar_drink_ingredients
      set current_stock = current_stock - v_amount
      where id = r.ingredient_id;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- pop9_fastbar_revert_item_stock
-- Mesma adição no espelho: item vinculado credita de volta um lote novo (origem
-- 'ajuste', sem validade -- não dá pra recuperar de qual lote específico saiu).
create or replace function public.pop9_fastbar_revert_item_stock(
  p_product_id uuid,
  p_session_id uuid,
  p_quantity integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_amount numeric;
  v_item_id uuid;
  v_unidade_id uuid;
  v_movimento_id uuid;
begin
  if p_product_id is null or coalesce(p_quantity, 0) <= 0 then
    return;
  end if;

  insert into public.pop9_fastbar_stock_movements (product_id, session_id, quantity, movement_type, note)
  values (p_product_id, p_session_id, p_quantity, 'in', 'Cancelamento de lançamento');

  select item_id into v_item_id from public.pop9_fastbar_products where id = p_product_id;

  if v_item_id is not null then
    select unidade_estoque_id into v_unidade_id
    from public.pop9_fastbar_itens where id = v_item_id;

    update public.pop9_fastbar_itens
    set estoque_atual = estoque_atual + p_quantity,
        updated_at = now()
    where id = v_item_id;

    insert into public.pop9_fastbar_item_movimentos
      (item_id, tipo, quantidade, unidade_id, session_id, nota)
    values (v_item_id, 'ajuste', p_quantity, v_unidade_id, p_session_id, 'Estorno por cancelamento de lançamento')
    returning id into v_movimento_id;

    insert into public.pop9_fastbar_lotes
      (item_id, quantidade_inicial, quantidade_restante, unidade_id, custo_unitario, origem, movimento_id)
    values
      (v_item_id, p_quantity, p_quantity, v_unidade_id, 0, 'ajuste', v_movimento_id);

    return;
  end if;

  update public.pop9_fastbar_products
  set stock_quantity = stock_quantity + p_quantity
  where id = p_product_id;

  for r in
    select base_drink_id, ingredient_id, quantity
    from public.pop9_fastbar_recipe_items
    where product_id = p_product_id
    order by base_drink_id nulls last, ingredient_id nulls last
  loop
    v_amount := r.quantity * p_quantity;
    if v_amount <= 0 then
      continue;
    end if;

    if r.base_drink_id is not null then
      insert into public.pop9_fastbar_base_drink_movements (base_drink_id, type, quantity, reason, note)
      values (r.base_drink_id, 'entrada', v_amount, 'ajuste', 'Estorno por cancelamento de lançamento');

      update public.pop9_fastbar_base_drinks
      set current_stock = current_stock + v_amount
      where id = r.base_drink_id;

    elsif r.ingredient_id is not null then
      insert into public.pop9_fastbar_drink_ingredient_movements (ingredient_id, type, quantity, reason, note)
      values (r.ingredient_id, 'entrada', v_amount, 'ajuste', 'Estorno por cancelamento de lançamento');

      update public.pop9_fastbar_drink_ingredients
      set current_stock = current_stock + v_amount
      where id = r.ingredient_id;
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['pop9_fastbar_lotes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "service role only" on public.%I', t);
    execute format(
      'create policy "service role only" on public.%I for all using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'')',
      t
    );
  end loop;
end $$;

commit;
