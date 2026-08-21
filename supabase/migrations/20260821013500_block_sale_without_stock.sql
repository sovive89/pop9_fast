-- Bloqueia lançamento na comanda quando não há lastro de estoque.
--
-- Antes desta migration, fastbar_add_tab_item validava sessão aberta e produto configurado,
-- mas nunca conferia saldo. Como fastbar_apply_sale_stock subtrai direto
-- (`set current_stock = current_stock - n`, sem checagem) e não existe constraint de
-- não-negativo, o estoque cruzava o zero e ficava negativo — foi assim que TÔNICA chegou a -1.
--
-- A fonte do lastro depende do tipo de produto:
--   composto (tem fastbar_recipe_items) -> saldo dos insumos/bebidas base da ficha técnica
--   simples  (sem ficha técnica)        -> stock_quantity do próprio produto
--
-- Checar stock_quantity também no composto bloquearia todos eles de uma vez, porque
-- fastbar_apply_sale_stock decrementa esse campo inclusive nos compostos, onde ele não
-- representa disponibilidade real.

create or replace function public.fastbar_add_tab_item(
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
  from public.fastbar_sessions
  where id = p_session_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'session_not_open');
  end if;

  select name, price, stock_quantity into v_name, v_price, v_stock
  from public.fastbar_products
  where id = p_product_id and is_active = true
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'product_unavailable');
  end if;

  select exists(select 1 from public.fastbar_recipe_items where product_id = p_product_id)
    into v_has_recipe;
  select exists(select 1 from public.fastbar_stock_movements where product_id = p_product_id)
    into v_has_movements;

  if not (v_has_recipe or v_has_movements) then
    return jsonb_build_object('ok', false, 'code', 'product_not_configured');
  end if;

  if v_has_recipe then
    -- A ordem de leitura repete a de fastbar_apply_sale_stock de propósito: duas vendas
    -- simultâneas precisam adquirir os locks na mesma sequência, senão travam uma na outra.
    -- O `for update` aqui é o que impede duas vendas de passarem juntas pela mesma checagem
    -- e só então descobrirem que só havia saldo para uma.
    for r in
      select ri.base_drink_id, ri.ingredient_id, ri.quantity
      from public.fastbar_recipe_items ri
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
        from public.fastbar_base_drinks bd
        where bd.id = r.base_drink_id
        for update;
      else
        select di.current_stock, di.name into v_available, v_component
        from public.fastbar_drink_ingredients di
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

  insert into public.fastbar_tab_items (session_id, product_id, name, unit_price, quantity)
  values (p_session_id, p_product_id, v_name, v_price, 1);

  perform public.fastbar_apply_sale_stock(p_product_id, p_session_id, 1);

  return jsonb_build_object('ok', true);
end;
$$;
