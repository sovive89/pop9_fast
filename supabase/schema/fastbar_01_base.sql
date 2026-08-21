-- ============================================================================
-- pop9 — Parte 1: schema base (mesmos nomes de tabela do fast_bar)
-- ============================================================================
--  ⚠  RODAR SOMENTE NO PROJETO NOVO, VAZIO.
--
--  Os nomes de tabela aqui são IDÊNTICOS aos do fast_bar em produção
--  (projeto evjoxkllaaxgxdaupees). Isso é intencional — deixa o código da
--  pop9_fast funcionar sem alteração, trocando só as chaves no .env.
--
--  Consequência: confira o projeto selecionado no canto superior do painel
--  antes de rodar. Os comandos são `create table if not exists`, então num
--  banco já povoado eles não destroem nada — mas também não é onde devem ir.
-- ============================================================================
-- Reconstruído a partir de duas fontes, porque as tabelas fastbar_* nunca foram
-- criadas por migration (foram feitas direto no painel do Supabase):
--   colunas, nulabilidade e FKs -> src/integrations/supabase/types.ts (gerado do banco real)
--   constraints, índices e defaults -> supabase/migrations/*.sql
--
-- As 7 tabelas legado da primeira versão (bar_products, bar_sessions, bar_tab_items,
-- menu_items, tabs, tab_items, stock_movements) ficaram de fora de propósito: têm
-- zero referências no código.
--
-- PONTOS INFERIDOS — conferir contra o banco real antes de considerar fechado:
--   * tipos numéricos: types.ts reporta tudo como `number`, sem separar integer de numeric
--   * `phone` em customers/sessions ficou sem unique, igual ao que parece ser hoje
--   * ordem das colunas e nomes de constraint podem diferir do original
-- ============================================================================

begin;

-- ---------------------------------------------------------------- fornecedores
create table if not exists public.fastbar_suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  document text,
  email text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------------- clientes
create table if not exists public.fastbar_customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  name text not null,
  full_name text,
  notes text,
  total_spent numeric not null default 0,
  total_visits integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  birthday_day smallint,
  birthday_month smallint,
  administrative_region text,
  how_found_out text,
  age_range text,
  profession text,
  favorite_music_genre text,
  marketing_opt_in boolean not null default false,
  profile_completed_at timestamptz,
  welcome_discount_earned_at timestamptz,
  constraint fastbar_customers_birthday_day_valid
    check (birthday_day is null or (birthday_day between 1 and 31)),
  constraint fastbar_customers_birthday_month_valid
    check (birthday_month is null or (birthday_month between 1 and 12)),
  -- Dia e mês andam juntos: um sem o outro é aniversário pela metade.
  constraint fastbar_customers_birthday_complete
    check ((birthday_day is null) = (birthday_month is null))
);

create index if not exists fastbar_customers_birthday_idx
  on public.fastbar_customers (birthday_month, birthday_day);
create index if not exists fastbar_customers_marketing_opt_in_idx
  on public.fastbar_customers (marketing_opt_in);

-- ------------------------------------------------------------ categorias
create table if not exists public.fastbar_product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create unique index if not exists fastbar_product_categories_name_ci_key
  on public.fastbar_product_categories (lower(name));

-- -------------------------------------------------------------------- produtos
create table if not exists public.fastbar_products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  price numeric not null default 0,
  stock_quantity numeric not null default 0,
  average_cost numeric not null default 0,
  unit text not null default 'un',
  purchase_unit text,
  package_type text,
  units_per_pack integer not null default 1,
  content_amount numeric not null default 1,
  image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fastbar_products_units_per_pack_positive check (units_per_pack > 0),
  constraint fastbar_products_content_amount_positive check (content_amount > 0)
);

-- --------------------------------------------------- insumos (as duas tabelas)
-- base_drinks e drink_ingredients são idênticas coluna a coluna. A duplicação vem
-- do domínio de bar (destilado vs. resto) e está replicada aqui só para o espelho
-- continuar fiel — a Parte 2 introduz o item unificado que as substitui.
create table if not exists public.fastbar_base_drinks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text not null,
  current_stock numeric not null default 0,
  min_stock numeric not null default 0,
  average_cost numeric not null default 0,
  purchase_unit text,
  units_per_pack integer not null default 1,
  content_amount numeric not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fastbar_base_drinks_units_per_pack_positive check (units_per_pack > 0),
  constraint fastbar_base_drinks_content_amount_positive
    check (content_amount > 0 and content_amount < 1000000)
);

create table if not exists public.fastbar_drink_ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text not null,
  current_stock numeric not null default 0,
  min_stock numeric not null default 0,
  average_cost numeric not null default 0,
  purchase_unit text,
  units_per_pack integer not null default 1,
  content_amount numeric not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fastbar_drink_ingredients_units_per_pack_positive check (units_per_pack > 0),
  constraint fastbar_drink_ingredients_content_amount_positive
    check (content_amount > 0 and content_amount < 1000000)
);

-- -------------------------------------------------------------- ficha técnica
create table if not exists public.fastbar_recipe_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.fastbar_products(id) on delete cascade,
  base_drink_id uuid references public.fastbar_base_drinks(id),
  ingredient_id uuid references public.fastbar_drink_ingredients(id),
  quantity numeric not null,
  -- ADIÇÃO ao original: a regra "preencha exatamente um" existe hoje só como convenção,
  -- e todo código de estoque depende dela. Aqui ela vira garantia do banco.
  constraint fastbar_recipe_items_exactly_one_component
    check (num_nonnulls(base_drink_id, ingredient_id) = 1)
);

create index if not exists fastbar_recipe_items_product_idx
  on public.fastbar_recipe_items (product_id);

-- -------------------------------------------------------------------- comandas
create table if not exists public.fastbar_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  phone text not null,
  status text not null default 'pending',
  customer_id uuid references public.fastbar_customers(id),
  discount_percent numeric(5,2) not null default 0,
  started_at timestamptz,
  closed_at timestamptz,
  paid_at timestamptz,
  archived_at timestamptz,
  payment_method text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fastbar_sessions_status_check
    check (status in ('pending', 'open', 'closed', 'paid', 'cancelled')),
  constraint fastbar_sessions_discount_percent_valid
    check (discount_percent >= 0 and discount_percent <= 100)
);

create index if not exists fastbar_sessions_archived_at_idx
  on public.fastbar_sessions (archived_at);
create index if not exists fastbar_sessions_status_idx
  on public.fastbar_sessions (status, started_at desc);

create table if not exists public.fastbar_tab_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.fastbar_sessions(id) on delete cascade,
  product_id uuid references public.fastbar_products(id),
  name text not null,
  unit_price numeric not null,
  quantity integer not null default 1,
  added_at timestamptz not null default now()
);

create index if not exists fastbar_tab_items_session_idx
  on public.fastbar_tab_items (session_id, added_at);

-- ------------------------------------------------------------------ movimentos
create table if not exists public.fastbar_stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.fastbar_products(id) on delete cascade,
  session_id uuid references public.fastbar_sessions(id) on delete set null,
  supplier_id uuid references public.fastbar_suppliers(id),
  quantity numeric not null,
  movement_type text not null,
  note text,
  unit_cost numeric,
  created_at timestamptz not null default now()
);

create index if not exists fastbar_stock_movements_product_idx
  on public.fastbar_stock_movements (product_id, created_at desc);

create table if not exists public.fastbar_base_drink_movements (
  id uuid primary key default gen_random_uuid(),
  base_drink_id uuid not null references public.fastbar_base_drinks(id) on delete cascade,
  supplier_id uuid references public.fastbar_suppliers(id),
  type text not null,
  quantity numeric not null,
  reason text not null,
  note text,
  unit_cost numeric,
  created_at timestamptz not null default now(),
  constraint fastbar_base_drink_movements_reason_check
    check (reason in ('compra', 'venda', 'perda', 'ajuste'))
);

create table if not exists public.fastbar_drink_ingredient_movements (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.fastbar_drink_ingredients(id) on delete cascade,
  supplier_id uuid references public.fastbar_suppliers(id),
  type text not null,
  quantity numeric not null,
  reason text not null,
  note text,
  unit_cost numeric,
  created_at timestamptz not null default now(),
  constraint fastbar_drink_ingredient_movements_reason_check
    check (reason in ('compra', 'venda', 'perda', 'ajuste'))
);

-- ------------------------------------------------------------------------- RLS
-- Mesmo padrão do schema atual: acesso só via service role, porque as server
-- functions já ficam atrás de assertRegisterAccess.
do $$
declare t text;
begin
  foreach t in array array[
    'fastbar_suppliers', 'fastbar_customers', 'fastbar_product_categories',
    'fastbar_products', 'fastbar_base_drinks', 'fastbar_drink_ingredients',
    'fastbar_recipe_items', 'fastbar_sessions', 'fastbar_tab_items',
    'fastbar_stock_movements', 'fastbar_base_drink_movements',
    'fastbar_drink_ingredient_movements'
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
