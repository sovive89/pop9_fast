-- ============================================================================
-- pop9 — Parte 3: funções de negócio, com prefixo pop9_
-- ============================================================================
--  Roda depois da Parte 1 (precisa das tabelas pop9_fastbar_* já existindo).
--
--  16 funções portadas das migrations de produção, operando só em tabelas
--  pop9_fastbar_*. Nenhuma toca fastbar_* (produção). Inclui a correção de
--  estoque negativo (pop9_fastbar_add_tab_item valida saldo antes de vender —
--  produto composto confere os insumos da ficha, simples confere stock_quantity).
--
--  Ordem de criação respeita as dependências: quem é chamado por outra função
--  vem primeiro (apply_sale_stock e revert_item_stock antes de quem as usa).
-- ============================================================================

begin;

-- ---------------------------------------------------------------- pop9_fastbar_apply_sale_stock
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
begin
  if p_product_id is null or coalesce(p_quantity, 0) <= 0 then
    return;
  end if;

  insert into public.pop9_fastbar_stock_movements (product_id, session_id, quantity, movement_type, note)
  values (p_product_id, p_session_id, p_quantity, 'out', 'Lançamento na comanda');

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
begin
  if p_product_id is null or coalesce(p_quantity, 0) <= 0 then
    return;
  end if;

  insert into public.pop9_fastbar_stock_movements (product_id, session_id, quantity, movement_type, note)
  values (p_product_id, p_session_id, p_quantity, 'in', 'Cancelamento de lançamento');

  update public.pop9_fastbar_products
  set stock_quantity = stock_quantity + p_quantity
  where id = p_product_id;

  -- Ordem fixa (bebidas base antes de ingredientes, por id) para que duas transações concorrentes
  -- travem as mesmas linhas na mesma sequência e não fiquem esperando uma pela outra.
  for r in
    select base_drink_id, ingredient_id, quantity
    from public.pop9_fastbar_recipe_items
    where product_id = p_product_id
    order by base_drink_id nulls last, ingredient_id nulls last
  loop
    v_amount := r.quantity * p_quantity;
    if v_amount <= 0 then
      continue; -- o CHECK dos movimentos exige quantidade positiva
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

  select name, price, stock_quantity into v_name, v_price, v_stock
  from public.pop9_fastbar_products
  where id = p_product_id and is_active = true
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'product_unavailable');
  end if;

  select exists(select 1 from public.pop9_fastbar_recipe_items where product_id = p_product_id)
    into v_has_recipe;
  select exists(select 1 from public.pop9_fastbar_stock_movements where product_id = p_product_id)
    into v_has_movements;

  if not (v_has_recipe or v_has_movements) then
    return jsonb_build_object('ok', false, 'code', 'product_not_configured');
  end if;

  if v_has_recipe then
    -- A ordem de leitura repete a de pop9_fastbar_apply_sale_stock de propósito: duas vendas
    -- simultâneas precisam adquirir os locks na mesma sequência, senão travam uma na outra.
    -- O `for update` aqui é o que impede duas vendas de passarem juntas pela mesma checagem
    -- e só então descobrirem que só havia saldo para uma.
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
-- ---------------------------------------------------------------- pop9_fastbar_remove_tab_item
create or replace function public.pop9_fastbar_remove_tab_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_status text;
  v_session_id uuid;
begin
  -- Descobre a comanda antes de travar qualquer coisa, para travar sempre comanda -> item.
  select session_id into v_session_id
  from public.pop9_fastbar_tab_items
  where id = p_item_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'item_not_found');
  end if;

  select status into v_status
  from public.pop9_fastbar_sessions
  where id = v_session_id
  for update;

  if v_status is distinct from 'open' then
    return jsonb_build_object('ok', false, 'code', 'session_not_open');
  end if;

  -- Só agora trava o item. Se um cancelamento da comanda passou na frente, ele já terá apagado
  -- esta linha e o select abaixo não encontra nada.
  select id, product_id, session_id, quantity
  into v_item
  from public.pop9_fastbar_tab_items
  where id = p_item_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'item_not_found');
  end if;

  perform public.pop9_fastbar_revert_item_stock(v_item.product_id, v_item.session_id, v_item.quantity);
  delete from public.pop9_fastbar_tab_items where id = p_item_id;

  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_undo_last_tab_item
create or replace function public.pop9_fastbar_undo_last_tab_item(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_item record;
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

  select id, product_id, session_id, quantity
  into v_item
  from public.pop9_fastbar_tab_items
  where session_id = p_session_id
  order by added_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_items');
  end if;

  perform public.pop9_fastbar_revert_item_stock(v_item.product_id, v_item.session_id, v_item.quantity);
  delete from public.pop9_fastbar_tab_items where id = v_item.id;

  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_clear_tab_items
create or replace function public.pop9_fastbar_clear_tab_items(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_item record;
  v_removed integer := 0;
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

  for v_item in
    select id, product_id, session_id, quantity
    from public.pop9_fastbar_tab_items
    where session_id = p_session_id
    order by id
    for update
  loop
    perform public.pop9_fastbar_revert_item_stock(v_item.product_id, v_item.session_id, v_item.quantity);
    v_removed := v_removed + 1;
  end loop;

  delete from public.pop9_fastbar_tab_items where session_id = p_session_id;

  return jsonb_build_object('ok', true, 'removed', v_removed);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_cancel_session
create or replace function public.pop9_fastbar_cancel_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_item record;
begin
  select status into v_status
  from public.pop9_fastbar_sessions
  where id = p_session_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;
  if v_status = 'paid' then
    return jsonb_build_object('ok', false, 'code', 'cannot_cancel');
  end if;

  if v_status <> 'cancelled' then
    update public.pop9_fastbar_sessions
    set status = 'cancelled',
        closed_at = coalesce(closed_at, now())
    where id = p_session_id;
  end if;

  for v_item in
    select id, product_id, session_id, quantity
    from public.pop9_fastbar_tab_items
    where session_id = p_session_id
    order by id
    for update
  loop
    perform public.pop9_fastbar_revert_item_stock(v_item.product_id, v_item.session_id, v_item.quantity);
  end loop;

  delete from public.pop9_fastbar_tab_items where session_id = p_session_id;

  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_create_product
create or replace function public.pop9_fastbar_create_product(
  p_name text,
  p_price numeric,
  p_category text,
  p_unit text,
  p_package_type text,
  p_image_url text,
  p_initial_stock integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category_name text;
  v_product_id uuid;
begin
  select name into v_category_name
  from public.pop9_fastbar_product_categories
  where lower(name) = lower(p_category)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'category_not_found');
  end if;

  insert into public.pop9_fastbar_products (
    name, category, price, unit, package_type, image_url, stock_quantity
  ) values (
    p_name, v_category_name, p_price, p_unit, p_package_type, p_image_url,
    greatest(coalesce(p_initial_stock, 0), 0)
  )
  returning id into v_product_id;

  if coalesce(p_initial_stock, 0) > 0 then
    insert into public.pop9_fastbar_stock_movements (product_id, quantity, movement_type, note)
    values (v_product_id, p_initial_stock, 'in', 'Estoque inicial no cadastro');
  end if;

  return jsonb_build_object('ok', true, 'product_id', v_product_id);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_update_product
create or replace function public.pop9_fastbar_update_product(
  p_id uuid,
  p_name text,
  p_price numeric,
  p_category text,
  p_unit text,
  p_package_type text,
  p_image_url text,
  p_change_image boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category_name text;
begin
  select name into v_category_name
  from public.pop9_fastbar_product_categories
  where lower(name) = lower(p_category)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'category_not_found');
  end if;

  perform 1 from public.pop9_fastbar_products where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  update public.pop9_fastbar_products
  set name = p_name,
      price = p_price,
      category = v_category_name,
      unit = p_unit,
      package_type = p_package_type,
      image_url = case when p_change_image then p_image_url else image_url end,
      updated_at = now()
  where id = p_id;

  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_delete_product
create or replace function public.pop9_fastbar_delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movements integer;
  v_tab_items integer;
  v_deleted integer;
begin
  perform 1 from public.pop9_fastbar_products where id = p_product_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'product_not_found');
  end if;

  select count(*) into v_movements
  from public.pop9_fastbar_stock_movements where product_id = p_product_id;
  select count(*) into v_tab_items
  from public.pop9_fastbar_tab_items where product_id = p_product_id;

  if v_movements > 0 or v_tab_items > 0 then
    return jsonb_build_object('ok', false, 'code', 'has_history');
  end if;

  delete from public.pop9_fastbar_recipe_items where product_id = p_product_id;
  delete from public.pop9_fastbar_products where id = p_product_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    return jsonb_build_object('ok', false, 'code', 'product_not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_delete_product_category
create or replace function public.pop9_fastbar_delete_product_category(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_in_use integer;
  v_deleted integer;
begin
  select name into v_name from public.pop9_fastbar_product_categories where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select count(*) into v_in_use
  from public.pop9_fastbar_products
  where lower(category) = lower(v_name);

  if v_in_use > 0 then
    return jsonb_build_object('ok', false, 'code', 'in_use', 'count', v_in_use);
  end if;

  delete from public.pop9_fastbar_product_categories where id = p_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_update_product_category
create or replace function public.pop9_fastbar_update_product_category(
  p_id uuid,
  p_name text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_name text;
  v_new_name text := trim(p_name);
begin
  select name into v_old_name from public.pop9_fastbar_product_categories where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_new_name is null or length(v_new_name) < 2 then
    return jsonb_build_object('ok', false, 'code', 'invalid_name');
  end if;

  if lower(v_new_name) <> lower(v_old_name) and exists (
    select 1 from public.pop9_fastbar_product_categories where lower(name) = lower(v_new_name)
  ) then
    return jsonb_build_object('ok', false, 'code', 'duplicate');
  end if;

  begin
    update public.pop9_fastbar_product_categories set name = v_new_name where id = p_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'duplicate');
  end;

  update public.pop9_fastbar_products set category = v_new_name where lower(category) = lower(v_old_name);

  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_delete_base_drink
create or replace function public.pop9_fastbar_delete_base_drink(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipes integer;
  v_sales integer;
  v_deleted integer;
begin
  perform 1 from public.pop9_fastbar_base_drinks where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select count(*) into v_recipes
  from public.pop9_fastbar_recipe_items where base_drink_id = p_id;
  select count(*) into v_sales
  from public.pop9_fastbar_base_drink_movements where base_drink_id = p_id and reason = 'venda';

  if v_recipes > 0 then
    return jsonb_build_object('ok', false, 'code', 'in_use_by_recipe');
  end if;
  if v_sales > 0 then
    return jsonb_build_object('ok', false, 'code', 'has_sales_history');
  end if;

  delete from public.pop9_fastbar_base_drink_movements where base_drink_id = p_id;
  delete from public.pop9_fastbar_base_drinks where id = p_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_delete_ingredient
create or replace function public.pop9_fastbar_delete_ingredient(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipes integer;
  v_sales integer;
  v_deleted integer;
begin
  perform 1 from public.pop9_fastbar_drink_ingredients where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select count(*) into v_recipes
  from public.pop9_fastbar_recipe_items where ingredient_id = p_id;
  select count(*) into v_sales
  from public.pop9_fastbar_drink_ingredient_movements where ingredient_id = p_id and reason = 'venda';

  if v_recipes > 0 then
    return jsonb_build_object('ok', false, 'code', 'in_use_by_recipe');
  end if;
  if v_sales > 0 then
    return jsonb_build_object('ok', false, 'code', 'has_sales_history');
  end if;

  delete from public.pop9_fastbar_drink_ingredient_movements where ingredient_id = p_id;
  delete from public.pop9_fastbar_drink_ingredients where id = p_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_restock_product
create or replace function public.pop9_fastbar_restock_product(
  p_product_id uuid,
  p_quantity integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new integer;
begin
  if coalesce(p_quantity, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_quantity');
  end if;

  update public.pop9_fastbar_products
  set stock_quantity = stock_quantity + p_quantity
  where id = p_product_id
  returning stock_quantity into v_new;

  if v_new is null then
    return jsonb_build_object('ok', false, 'code', 'product_not_found');
  end if;

  insert into public.pop9_fastbar_stock_movements (product_id, quantity, movement_type, note)
  values (p_product_id, p_quantity, 'in', 'Reposição manual');

  return jsonb_build_object('ok', true, 'new_quantity', v_new);
end;
$$;
-- ---------------------------------------------------------------- pop9_fastbar_add_product_entry
create or replace function public.pop9_fastbar_add_product_entry(
  p_product_id uuid,
  p_packs integer,
  p_purchase_cost numeric default null,
  p_supplier_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prod record;
  v_qty integer;
  v_unit_cost numeric;
  v_new_stock integer;
begin
  if coalesce(p_packs, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_quantity');
  end if;

  select id, stock_quantity, units_per_pack, content_amount, average_cost
  into v_prod
  from public.pop9_fastbar_products
  where id = p_product_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'product_not_found');
  end if;

  v_qty := (p_packs * v_prod.units_per_pack * v_prod.content_amount)::integer;
  if v_qty <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_quantity');
  end if;

  if p_purchase_cost is not null and p_purchase_cost > 0 then
    v_unit_cost := p_purchase_cost / v_qty;
  end if;

  insert into public.pop9_fastbar_stock_movements
    (product_id, quantity, movement_type, note, supplier_id, unit_cost)
  values (p_product_id, v_qty, 'in', 'Entrada de compra', p_supplier_id, v_unit_cost);

  -- Custo médio ponderado: mistura o que já havia com o que chegou, para o preço de venda poder
  -- ser conferido contra o custo real e não contra o da última compra.
  if v_unit_cost is not null then
    update public.pop9_fastbar_products
    set stock_quantity = stock_quantity + v_qty,
        average_cost = case
          when stock_quantity + v_qty <= 0 then v_unit_cost
          else ((average_cost * greatest(stock_quantity, 0)) + (v_unit_cost * v_qty))
               / (greatest(stock_quantity, 0) + v_qty)
        end
    where id = p_product_id
    returning stock_quantity into v_new_stock;
  else
    update public.pop9_fastbar_products
    set stock_quantity = stock_quantity + v_qty
    where id = p_product_id
    returning stock_quantity into v_new_stock;
  end if;

  return jsonb_build_object('ok', true, 'quantity', v_qty, 'new_stock', v_new_stock);
end;
$$;
commit;
