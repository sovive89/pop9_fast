import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { useSession } from "@tanstack/react-start/server";
import { sessionConfig, type GateSession } from "./bar-gate.server";

export const CODE_TTL_MINUTES = 10;

export const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));

export const admin = () => supabaseAdmin;

export async function assertRegisterAccess() {
  const session = await useSession<GateSession>(sessionConfig());
  if (session.data.unlocked !== true) throw new Error("Acesso do caixa não autorizado.");
}

export function sanitizeName(value: unknown) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length < 3 || name.length > 80) return null;
  if (/\d/.test(name)) return null; // nomes não têm dígitos
  const letters = name.toLowerCase().replace(/[^a-zà-ú]/g, "");
  if (letters.length < 2 || new Set(letters).size < 2) return null; // ex.: "aaaa", "xx"
  return name;
}

export function sanitizePhone(value: unknown) {
  const phone = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (phone.length < 10 || phone.length > 11) return null;
  if (/^(\d)\1+$/.test(phone)) return null; // ex.: 11111111111
  return phone;
}

// As operações de estoque (baixa por venda, estorno, drenagem de comanda) vivem em funções no
// Postgres — ver a migration atomic_stock_operations. Elas ficaram lá porque só dentro do banco é
// possível somar o saldo sem intervalo entre ler e gravar, e agrupar os vários passos numa
// transação única. As versões que existiam aqui perdiam atualizações concorrentes e podiam parar
// no meio deixando o estoque incoerente.


/** Cria o cliente na primeira visita, ou atualiza nome/última visita/contagem numa nova visita. */
export async function upsertCustomer(name: string, phone: string): Promise<string> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await supabaseAdmin
    .from("pop9_fastbar_customers")
    .select("id, total_visits")
    .eq("phone", phone)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from("pop9_fastbar_customers")
      .update({ name, last_seen_at: nowIso, total_visits: existing.total_visits + 1 })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: inserted } = await supabaseAdmin
    .from("pop9_fastbar_customers")
    .insert({ name, phone, total_visits: 1, first_seen_at: nowIso, last_seen_at: nowIso })
    .select("id")
    .single();

  return inserted!.id;
}

/** Soma o consumo da comanda paga no total histórico do cliente. */
export async function registerCustomerSpend(sessionId: string) {
  const { data: session } = await supabaseAdmin
    .from("pop9_fastbar_sessions")
    .select("customer_id, discount_percent")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session?.customer_id) return;

  const { data: items } = await supabaseAdmin
    .from("pop9_fastbar_tab_items")
    .select("unit_price, quantity")
    .eq("session_id", sessionId);

  const subtotal = (items ?? []).reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  // Credita o que foi de fato cobrado, não o preço de tabela — senão o CRM e o faturamento
  // ficariam maiores do que o dinheiro que realmente entrou no caixa.
  const discountPercent = Number(session.discount_percent ?? 0);
  const total = discountPercent > 0 ? subtotal * (1 - discountPercent / 100) : subtotal;
  if (total <= 0) return;

  const { data: customer } = await supabaseAdmin
    .from("pop9_fastbar_customers")
    .select("total_spent")
    .eq("id", session.customer_id)
    .maybeSingle();
  if (!customer) return;

  await supabaseAdmin
    .from("pop9_fastbar_customers")
    .update({ total_spent: Number(customer.total_spent) + total })
    .eq("id", session.customer_id);
}
