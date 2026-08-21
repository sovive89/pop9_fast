-- ============================================================================
-- pop9 — Parte 2: estruturas de restaurante
-- ============================================================================
--  ⚠  RODAR SOMENTE NO PROJETO NOVO, depois da Parte 1.
--
--  Estas tabelas NÃO existem no fast_bar. Rodar isto no projeto de produção
--  criaria um modelo paralelo lá dentro, sem nada usando ele.
-- ============================================================================
-- Roda depois da Parte 1. Introduz o que o modelo de bar não comporta:
--   * item unificado com tipo (insumo / semiacabado / acabado / revenda)
--   * unidades de medida com dimensão, para impedir conversão inválida
--   * embalagens de compra por item ("abrir unidades por tipo de entrada")
--   * ficha técnica com item de saída e rendimento — base do porcionamento
--   * produção (mise en place) como operação que CREDITA estoque
--
-- O modelo antigo só sabia dar baixa por venda. Semiacabado não cabia nele porque
-- é saída de uma ficha e insumo de outra ao mesmo tempo.
-- ============================================================================

begin;

-- ------------------------------------------------------------------- unidades
-- A dimensão é o que impede somar ml com grama. fator_base converte para a
-- unidade canônica da dimensão (g para massa, ml para volume, un para contagem).
create table if not exists public.fastbar_unidades (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  nome text not null,
  dimensao text not null,
  fator_base numeric not null,
  created_at timestamptz not null default now(),
  constraint fastbar_unidades_dimensao_check
    check (dimensao in ('massa', 'volume', 'contagem')),
  constraint fastbar_unidades_fator_positivo check (fator_base > 0)
);

insert into public.fastbar_unidades (codigo, nome, dimensao, fator_base) values
  ('g',  'grama',      'massa',    1),
  ('kg', 'quilograma', 'massa',    1000),
  ('ml', 'mililitro',  'volume',   1),
  ('l',  'litro',      'volume',   1000),
  ('un', 'unidade',    'contagem', 1)
on conflict (codigo) do nothing;

-- Converte respeitando a dimensão. Duas unidades de dimensões diferentes não têm
-- conversão possível — falhar alto é melhor do que devolver um número plausível e errado.
create or replace function public.fastbar_converter(
  p_quantidade numeric,
  p_de uuid,
  p_para uuid
) returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_de record;
  v_para record;
begin
  if p_de = p_para then
    return p_quantidade;
  end if;

  select dimensao, fator_base into v_de
  from public.fastbar_unidades where id = p_de;
  select dimensao, fator_base into v_para
  from public.fastbar_unidades where id = p_para;

  if v_de is null or v_para is null then
    raise exception 'Unidade não encontrada';
  end if;
  if v_de.dimensao <> v_para.dimensao then
    raise exception 'Conversão inválida: % não converte para %', v_de.dimensao, v_para.dimensao;
  end if;

  return p_quantidade * v_de.fator_base / v_para.fator_base;
end;
$$;

-- ---------------------------------------------------------------------- itens
-- Uma tabela só, no lugar de base_drinks + drink_ingredients. O tipo não é
-- rótulo: define de onde vem o saldo do item.
--   insumo      -> entra por compra, sai por consumo em ficha
--   semiacabado -> entra por PRODUÇÃO, sai por consumo em ficha  (mise en place)
--   acabado     -> entra por PRODUÇÃO, sai por venda
--   revenda     -> entra por compra, sai por venda (sem transformação)
create table if not exists public.fastbar_itens (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  tipo text not null,
  unidade_estoque_id uuid not null references public.fastbar_unidades(id),
  estoque_atual numeric not null default 0,
  estoque_minimo numeric not null default 0,
  custo_medio numeric not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fastbar_itens_tipo_check
    check (tipo in ('insumo', 'semiacabado', 'acabado', 'revenda')),
  constraint fastbar_itens_estoque_nao_negativo check (estoque_atual >= 0)
);

create unique index if not exists fastbar_itens_nome_ci_key
  on public.fastbar_itens (lower(nome));
create index if not exists fastbar_itens_tipo_idx
  on public.fastbar_itens (tipo) where ativo;

-- ------------------------------------------------------- embalagens de compra
-- "Abrir unidades por tipo de entrada": o mesmo item pode entrar como caixa com
-- 12, fardo com 6 ou garrafa de 1000 ml. Cada embalagem diz quanto rende na
-- unidade de estoque do item, então a entrada é registrada como se compra e o
-- saldo cresce na unidade em que se consome.
create table if not exists public.fastbar_item_embalagens (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.fastbar_itens(id) on delete cascade,
  nome text not null,
  quantidade_por_embalagem numeric not null,
  unidade_conteudo_id uuid not null references public.fastbar_unidades(id),
  padrao boolean not null default false,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint fastbar_item_embalagens_quantidade_positiva
    check (quantidade_por_embalagem > 0)
);

create unique index if not exists fastbar_item_embalagens_padrao_key
  on public.fastbar_item_embalagens (item_id) where padrao;

-- -------------------------------------------------------------- ficha técnica
-- A diferença central para fastbar_recipe_items: a ficha tem item de SAÍDA e
-- RENDIMENTO. Sem rendimento não existe porcionamento — não dá para saber que
-- uma receita de molho rende 2000 ml e portanto 40 porções de 50 ml.
create table if not exists public.fastbar_fichas (
  id uuid primary key default gen_random_uuid(),
  item_produzido_id uuid not null references public.fastbar_itens(id) on delete cascade,
  rendimento_quantidade numeric not null,
  rendimento_unidade_id uuid not null references public.fastbar_unidades(id),
  modo_preparo text,
  versao integer not null default 1,
  ativa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fastbar_fichas_rendimento_positivo check (rendimento_quantidade > 0)
);

-- Uma ficha ativa por item; versões antigas ficam guardadas para histórico de custo.
create unique index if not exists fastbar_fichas_item_ativa_key
  on public.fastbar_fichas (item_produzido_id) where ativa;

create table if not exists public.fastbar_ficha_componentes (
  id uuid primary key default gen_random_uuid(),
  ficha_id uuid not null references public.fastbar_fichas(id) on delete cascade,
  item_id uuid not null references public.fastbar_itens(id),
  quantidade numeric not null,
  unidade_id uuid not null references public.fastbar_unidades(id),
  constraint fastbar_ficha_componentes_quantidade_positiva check (quantidade > 0),
  constraint fastbar_ficha_componentes_unica unique (ficha_id, item_id)
);

create index if not exists fastbar_ficha_componentes_item_idx
  on public.fastbar_ficha_componentes (item_id);

-- ---------------------------------------------------------------- porcionamento
-- Quanto do item cada porção consome. Um mesmo semiacabado pode ser servido em
-- tamanhos diferentes (individual 50 ml, família 200 ml).
create table if not exists public.fastbar_porcoes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.fastbar_itens(id) on delete cascade,
  nome text not null,
  quantidade numeric not null,
  unidade_id uuid not null references public.fastbar_unidades(id),
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint fastbar_porcoes_quantidade_positiva check (quantidade > 0),
  constraint fastbar_porcoes_unica unique (item_id, nome)
);

-- -------------------------------------------------------------------- produção
-- O evento de mise en place. Consome os componentes da ficha e credita o item
-- produzido — a operação que não existia no modelo de bar.
create table if not exists public.fastbar_producoes (
  id uuid primary key default gen_random_uuid(),
  ficha_id uuid not null references public.fastbar_fichas(id),
  item_produzido_id uuid not null references public.fastbar_itens(id),
  quantidade_produzida numeric not null,
  unidade_id uuid not null references public.fastbar_unidades(id),
  custo_total numeric not null default 0,
  observacao text,
  created_at timestamptz not null default now(),
  constraint fastbar_producoes_quantidade_positiva check (quantidade_produzida > 0)
);

-- ------------------------------------------------------ movimentos unificados
-- Substitui stock_movements + base_drink_movements + drink_ingredient_movements.
-- Toda alteração de saldo passa por aqui, qualquer que seja o tipo do item.
create table if not exists public.fastbar_item_movimentos (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.fastbar_itens(id) on delete cascade,
  tipo text not null,
  quantidade numeric not null,
  unidade_id uuid not null references public.fastbar_unidades(id),
  custo_unitario numeric,
  fornecedor_id uuid references public.fastbar_suppliers(id),
  producao_id uuid references public.fastbar_producoes(id) on delete set null,
  session_id uuid references public.fastbar_sessions(id) on delete set null,
  nota text,
  created_at timestamptz not null default now(),
  constraint fastbar_item_movimentos_tipo_check
    check (tipo in ('entrada', 'saida', 'producao', 'consumo', 'perda', 'ajuste')),
  constraint fastbar_item_movimentos_quantidade_positiva check (quantidade > 0)
);

create index if not exists fastbar_item_movimentos_item_idx
  on public.fastbar_item_movimentos (item_id, created_at desc);

-- ------------------------------------------------- registrar produção (atômica)
-- Multiplica a ficha pelo número de lotes, valida saldo de todos os componentes
-- ANTES de mexer em qualquer um, dá baixa e credita o produzido. Tudo numa
-- transação: ou a produção inteira acontece, ou nada acontece — produção pela
-- metade deixaria insumo baixado sem o semiacabado correspondente existir.
create or replace function public.fastbar_registrar_producao(
  p_ficha_id uuid,
  p_lotes numeric default 1,
  p_observacao text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ficha record;
  v_producao_id uuid;
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
  from public.fastbar_fichas f
  join public.fastbar_itens i on i.id = f.item_produzido_id
  where f.id = p_ficha_id and f.ativa
  for update of f;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'ficha_nao_encontrada');
  end if;

  -- Passo 1: travar e conferir todos os componentes antes de debitar qualquer um.
  -- Ordem estável por item_id para duas produções simultâneas não travarem uma na outra.
  for c in
    select fc.item_id, fc.quantidade, fc.unidade_id, it.nome, it.unidade_estoque_id, it.custo_medio
    from public.fastbar_ficha_componentes fc
    join public.fastbar_itens it on it.id = fc.item_id
    where fc.ficha_id = p_ficha_id
    order by fc.item_id
  loop
    v_necessario := public.fastbar_converter(
      c.quantidade * p_lotes, c.unidade_id, c.unidade_estoque_id
    );

    select estoque_atual into v_disponivel
    from public.fastbar_itens
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

  v_produzido := public.fastbar_converter(
    v_ficha.rendimento_quantidade * p_lotes,
    v_ficha.rendimento_unidade_id,
    v_ficha.item_unidade_id
  );

  insert into public.fastbar_producoes (
    ficha_id, item_produzido_id, quantidade_produzida, unidade_id, custo_total, observacao
  )
  values (
    p_ficha_id, v_ficha.item_produzido_id, v_produzido, v_ficha.item_unidade_id,
    v_custo_total, p_observacao
  )
  returning id into v_producao_id;

  -- Passo 2: agora que tudo foi validado, debitar.
  for c in
    select fc.item_id, fc.quantidade, fc.unidade_id, it.unidade_estoque_id
    from public.fastbar_ficha_componentes fc
    join public.fastbar_itens it on it.id = fc.item_id
    where fc.ficha_id = p_ficha_id
    order by fc.item_id
  loop
    v_necessario := public.fastbar_converter(
      c.quantidade * p_lotes, c.unidade_id, c.unidade_estoque_id
    );

    update public.fastbar_itens
    set estoque_atual = estoque_atual - v_necessario,
        updated_at = now()
    where id = c.item_id;

    insert into public.fastbar_item_movimentos (
      item_id, tipo, quantidade, unidade_id, producao_id, nota
    )
    values (
      c.item_id, 'consumo', v_necessario, c.unidade_estoque_id, v_producao_id,
      'Consumo em produção'
    );
  end loop;

  -- Passo 3: creditar o item produzido, com custo médio ponderado.
  update public.fastbar_itens
  set custo_medio = case
        when estoque_atual + v_produzido > 0
          then ((estoque_atual * custo_medio) + v_custo_total) / (estoque_atual + v_produzido)
        else custo_medio
      end,
      estoque_atual = estoque_atual + v_produzido,
      updated_at = now()
  where id = v_ficha.item_produzido_id;

  insert into public.fastbar_item_movimentos (
    item_id, tipo, quantidade, unidade_id, custo_unitario, producao_id, nota
  )
  values (
    v_ficha.item_produzido_id, 'producao', v_produzido, v_ficha.item_unidade_id,
    case when v_produzido > 0 then v_custo_total / v_produzido else 0 end,
    v_producao_id, 'Entrada por produção'
  );

  return jsonb_build_object(
    'ok', true,
    'producao_id', v_producao_id,
    'quantidade_produzida', v_produzido,
    'custo_total', v_custo_total
  );
end;
$$;

-- ------------------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array[
    'fastbar_unidades', 'fastbar_itens', 'fastbar_item_embalagens',
    'fastbar_fichas', 'fastbar_ficha_componentes', 'fastbar_porcoes',
    'fastbar_producoes', 'fastbar_item_movimentos'
  ]
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
