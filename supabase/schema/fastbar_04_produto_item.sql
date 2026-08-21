-- ============================================================================
-- pop9 — Parte 4: vínculo produto ↔ item de produção, com prefixo pop9_
-- ============================================================================
--  Roda depois das Partes 1-3. Todo objeto tocado começa com `pop9_` — nada
--  aqui altera, lê ou apaga tabela de produção do fast_bar.
--
--  Um produto do cardápio pode agora apontar pra um item (tipicamente tipo
--  'acabado') que a Produção abastece. Produto sem item_id continua igual:
--  receita debitada na hora (bebida montada) ou stock_quantity simples.
--
--  A diferença central: item vinculado NÃO reprocessa a ficha técnica a cada
--  venda — a ficha já foi consumida na produção, em lote. Vender só debita o
--  estoque pronto que a produção creditou.
-- ============================================================================

begin;

alter table public.pop9_fastbar_products
  add column if not exists item_id uuid references public.pop9_fastbar_itens(id);

create index if not exists pop9_fastbar_products_item_id_idx
  on public.pop9_fastbar_products (item_id) where item_id is not null;

-- ---------------------------------------------------------------- pop9_fastbar_apply_sale_stock
-- Terceiro caminho antes dos dois que já existiam: produto com item_id debita
-- o item vinculado e registra em item_movimentos; sem item_id, comportamento
-- idêntico ao anterior (stock_quantity + recipe_items).
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
-- Espelho exato do debito acima: item vinculado credita de volta o item, sem
-- tocar em receita.
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
    values (v_item_id, 'ajuste', p_quantity, v_unidade_id, p_session_id, 'Estorno por cancelamento de lançamento');

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

-- ---------------------------------------------------------------- pop9_fastbar_add_tab_item
-- Mesma função de sempre, com um terceiro ramo de validação ANTES dos outros
-- dois: produto com item_id confere o estoque do item vinculado (bloqueando
-- a venda sem saldo, igual aos outros dois casos) e nunca cai no ramo de
-- receita nem no de stock_quantity simples.
create or replace function public.pop9_fastbar_add_tab_item(
  p_session_id uuid,
  p_product_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_name text;
  v_price numeric;
  v_stock numeric;
  v_item_id uuid;
  v_has_recipe boolean;
  v_has_movements boolean;
  v_component text;
  v_available numeric;
  r record;
begin
  select status into v_status
  from public.pop9_fastbar_sessions
  where id = p_session_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'session_not_open');
  end if;

  select name, price, stock_quantity, item_id into v_name, v_price, v_stock, v_item_id
  from public.pop9_fastbar_products
  where id = p_product_id and is_active = true
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'product_unavailable');
  end if;

  if v_item_id is not null then
    select it.estoque_atual, it.nome into v_available, v_component
    from public.pop9_fastbar_itens it
    where it.id = v_item_id
    for update;

    if not found then
      return jsonb_build_object('ok', false, 'code', 'product_not_configured');
    end if;
    if coalesce(v_available, 0) < 1 then
      return jsonb_build_object(
        'ok', false,
        'code', 'insufficient_stock',
        'component', v_component
      );
    end if;

    insert into public.pop9_fastbar_tab_items (session_id, product_id, name, unit_price, quantity)
    values (p_session_id, p_product_id, v_name, v_price, 1);

    perform public.pop9_fastbar_apply_sale_stock(p_product_id, p_session_id, 1);

    return jsonb_build_object('ok', true);
  end if;

  select exists(select 1 from public.pop9_fastbar_recipe_items where product_id = p_product_id)
    into v_has_recipe;
  select exists(select 1 from public.pop9_fastbar_stock_movements where product_id = p_product_id)
    into v_has_movements;

  if not (v_has_recipe or v_has_movements) then
    return jsonb_build_object('ok', false, 'code', 'product_not_configured');
  end if;

  if v_has_recipe then
    for r in
      select ri.base_drink_id, ri.ingredient_id, ri.quantity
      from public.pop9_fastbar_recipe_items ri
      where ri.product_id = p_product_id
      order by ri.base_drink_id nulls last, ri.ingredient_id nulls last
    loop
      if coalesce(r.quantity, 0) <= 0 then
        continue;
      end if;
      if r.base_drink_id is null and r.ingredient_id is null then
        continue;
      end if;

      if r.base_drink_id is not null then
        select bd.current_stock, bd.name into v_available, v_component
        from public.pop9_fastbar_base_drinks bd
        where bd.id = r.base_drink_id
        for update;
      else
        select di.current_stock, di.name into v_available, v_component
        from public.pop9_fastbar_drink_ingredients di
        where di.id = r.ingredient_id
        for update;
      end if;

      if not found then
        return jsonb_build_object('ok', false, 'code', 'product_not_configured');
      end if;

      if coalesce(v_available, 0) < r.quantity then
        return jsonb_build_object(
          'ok', false,
          'code', 'insufficient_stock',
          'component', v_component
        );
      end if;
    end loop;
  else
    if coalesce(v_stock, 0) < 1 then
      return jsonb_build_object(
        'ok', false,
        'code', 'insufficient_stock',
        'component', v_name
      );
    end if;
  end if;

  insert into public.pop9_fastbar_tab_items (session_id, product_id, name, unit_price, quantity)
  values (p_session_id, p_product_id, v_name, v_price, 1);

  perform public.pop9_fastbar_apply_sale_stock(p_product_id, p_session_id, 1);

  return jsonb_build_object('ok', true);
end;
$$;

commit;
