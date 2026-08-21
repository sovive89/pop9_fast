import { createServerFn } from "@tanstack/react-start";

export const getCustomersOverview = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  const { classifyLead, vipSpendThreshold, averageTicket, daysSince } = await import("./crm");
  await assertRegisterAccess();
  const { data: customers } = await admin()
    .from("pop9_fastbar_customers")
    .select("id, name, phone, total_visits, total_spent, first_seen_at, last_seen_at")
    .order("total_spent", { ascending: false });

  // Classifica no servidor, não na tela: o corte de VIP é o 80º percentil da base inteira, então
  // depende de ver todos os clientes de uma vez. Feito no cliente, uma lista filtrada mudaria o
  // corte e o mesmo cliente trocaria de segmento conforme a busca digitada.
  const rows = customers ?? [];
  const threshold = vipSpendThreshold(rows);
  const now = Date.now();

  return {
    customers: rows.map((customer) => ({
      ...customer,
      segment: classifyLead(customer, threshold, now),
      averageTicket: averageTicket(customer),
      idleDays: daysSince(customer.last_seen_at, now),
    })),
  };
});

/**
 * Números agregados da página inicial do CRM — cruza dado que já existe no banco (coletado na
 * segunda tela pós-abertura de comanda) mas nunca tinha virado informação acionável.
 */
export const getCrmDashboard = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  const { classifyLead, vipSpendThreshold } = await import("./crm");
  const { todayDayMonth } = await import("./analytics");
  await assertRegisterAccess();

  const { data: customers } = await admin()
    .from("pop9_fastbar_customers")
    .select(
      "id, name, total_visits, total_spent, last_seen_at, birthday_day, birthday_month, how_found_out, marketing_opt_in",
    );
  const rows = customers ?? [];
  const threshold = vipSpendThreshold(rows);
  const now = Date.now();

  // Faturamento por segmento: total histórico acumulado em fastbar_customers.total_spent, não um
  // período — diferente do gráfico de Relatórios, que soma comandas pagas dentro do intervalo
  // escolhido. Aqui é "quem já trouxe mais dinheiro pra casa desde sempre".
  const revenueBySegment: Record<string, number> = {};
  for (const customer of rows) {
    const segment = classifyLead(customer, threshold, now);
    revenueBySegment[segment] = (revenueBySegment[segment] ?? 0) + Number(customer.total_spent);
  }

  // Aniversariantes do mês corrente, no fuso do bar — pra campanha de aniversário ou só ligar
  // desejando feliz aniversário no dia.
  const { month: currentMonth } = todayDayMonth();
  const birthdaysThisMonth = rows
    .filter((c) => c.birthday_month === currentMonth)
    .map((c) => ({ id: c.id, name: c.name, day: c.birthday_day! }))
    .sort((a, b) => a.day - b.day);

  // De onde vem a base — só conta quem respondeu, "Não informado" inflaria um canal que não existe.
  const howFoundOutCounts: Record<string, number> = {};
  for (const customer of rows) {
    if (!customer.how_found_out) continue;
    howFoundOutCounts[customer.how_found_out] = (howFoundOutCounts[customer.how_found_out] ?? 0) + 1;
  }

  const marketingOptInCount = rows.filter((c) => c.marketing_opt_in).length;

  return {
    revenueBySegment,
    birthdaysThisMonth,
    howFoundOutCounts,
    marketingOptInCount,
    totalCustomers: rows.length,
  };
});

/**
 * Sinal do CRM pro módulo Alertas: quem precisa de ação hoje, não um dashboard completo. Em risco
 * e perdido já são os segmentos que pedem ação por definição (ver crm.ts); aniversariante é "hoje",
 * não "esse mês" como no dashboard — ligar no dia certo é o que importa aqui.
 */
export const getCrmAlerts = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  const { classifyLead, vipSpendThreshold } = await import("./crm");
  const { todayDayMonth } = await import("./analytics");
  await assertRegisterAccess();

  const { data: customers } = await admin()
    .from("pop9_fastbar_customers")
    .select("id, name, phone, total_visits, total_spent, last_seen_at, birthday_day, birthday_month");
  const rows = customers ?? [];
  const threshold = vipSpendThreshold(rows);
  const now = Date.now();

  const atRisk = rows
    .map((c) => ({ ...c, segment: classifyLead(c, threshold, now) }))
    .filter((c) => c.segment === "risco" || c.segment === "perdido")
    .map((c) => ({ id: c.id, name: c.name, phone: c.phone, segment: c.segment }));

  const { day: todayDay, month: todayMonth } = todayDayMonth();

  const birthdaysToday = rows
    .filter((c) => c.birthday_day === todayDay && c.birthday_month === todayMonth)
    .map((c) => ({ id: c.id, name: c.name, phone: c.phone }));

  return { atRisk, birthdaysToday };
});

/**
 * Retenção por coorte: agrupa clientes pelo mês da primeira visita e mede quantos % de cada
 * coorte voltou a comprar em cada mês seguinte. Diferente de "taxa de recompra" (um número só
 * pra base inteira), isso mostra SE a retenção está melhorando ou piorando coorte a coorte —
 * dois bares com a mesma taxa de recompra podem ter trajetórias opostas.
 *
 * Limita a 6 coortes (últimos 6 meses com cliente novo) e 6 meses de profundidade: mais que isso
 * vira uma matriz grande demais pra ler numa tela de celular, e coortes muito antigas têm cada vez
 * menos meses seguintes pra mostrar (a diagonal da matriz).
 */
export const getRetentionCohorts = createServerFn({ method: "POST" }).handler(async () => {
  const { admin, assertRegisterAccess } = await import("./fastbar.server");
  const { monthKey, monthsBetween } = await import("./analytics");
  await assertRegisterAccess();

  const { data: customers } = await admin()
    .from("pop9_fastbar_customers")
    .select("id, first_seen_at");
  const { data: sessions } = await admin()
    .from("pop9_fastbar_sessions")
    .select("customer_id, paid_at")
    .eq("status", "paid")
    .not("customer_id", "is", null);

  const cohortByCustomer = new Map<string, string>();
  for (const c of customers ?? []) cohortByCustomer.set(c.id, monthKey(c.first_seen_at));

  // Meses de visita distintos por cliente — um cliente que voltou 3x no mesmo mês conta uma vez
  // naquele mês, senão o gráfico infla retenção com gente que só ficou mais tempo na mesma visita.
  const visitMonthsByCustomer = new Map<string, Set<string>>();
  for (const s of sessions ?? []) {
    if (!s.customer_id || !s.paid_at) continue;
    const set = visitMonthsByCustomer.get(s.customer_id) ?? new Set<string>();
    set.add(monthKey(s.paid_at));
    visitMonthsByCustomer.set(s.customer_id, set);
  }

  const cohortSizes = new Map<string, number>();
  for (const cohort of cohortByCustomer.values()) {
    cohortSizes.set(cohort, (cohortSizes.get(cohort) ?? 0) + 1);
  }

  const cohortMonths = Array.from(cohortSizes.keys()).sort().slice(-6);
  const depth = 6;

  const matrix = cohortMonths.map((cohort) => {
    const size = cohortSizes.get(cohort) ?? 0;
    const retained = Array.from({ length: depth }, (_, offset) => {
      let count = 0;
      for (const [customerId, customerCohort] of cohortByCustomer) {
        if (customerCohort !== cohort) continue;
        const visits = visitMonthsByCustomer.get(customerId);
        if (!visits) continue;
        for (const visitMonth of visits) {
          if (monthsBetween(cohort, visitMonth) === offset) {
            count += 1;
            break;
          }
        }
      }
      return { offset, percent: size > 0 ? (count / size) * 100 : 0, count };
    });
    return { cohort, size, retained };
  });

  return { cohorts: matrix, depth };
});

export const getCustomerDetail = createServerFn({ method: "POST" })
  .inputValidator((data: { customerId: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    const { classifyLead, vipSpendThreshold, averageTicket, daysSince } = await import("./crm");
    await assertRegisterAccess();

    const [{ data: customer }, { data: sessions }] = await Promise.all([
      admin().from("pop9_fastbar_customers").select("*").eq("id", data.customerId).maybeSingle(),
      admin()
        .from("pop9_fastbar_sessions")
        .select("id, status, started_at, closed_at, paid_at, payment_method")
        .eq("customer_id", data.customerId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    const sessionIds = (sessions ?? []).map((session) => session.id);
    const [{ data: items }, { data: products }] = await Promise.all([
      sessionIds.length
        ? admin()
            .from("pop9_fastbar_tab_items")
            .select("session_id, product_id, name, unit_price, quantity, added_at")
            .in("session_id", sessionIds)
        : Promise.resolve({ data: [] as never[] }),
      admin().from("pop9_fastbar_products").select("id, category"),
    ]);
    const categoryByProductId = new Map((products ?? []).map((p) => [p.id, p.category]));

    const totalBySession = new Map<string, number>();
    // O que ele consome, pra conversa no balcão e pra escolher a promoção que faz sentido pra ele.
    const byProduct = new Map<string, { name: string; quantity: number; revenue: number }>();
    const byCategory = new Map<string, number>();
    const byHour = new Map<number, number>();
    for (const item of items ?? []) {
      const revenue = Number(item.unit_price) * item.quantity;
      totalBySession.set(item.session_id, (totalBySession.get(item.session_id) ?? 0) + revenue);

      const current = byProduct.get(item.name) ?? { name: item.name, quantity: 0, revenue: 0 };
      current.quantity += item.quantity;
      current.revenue += revenue;
      byProduct.set(item.name, current);

      const category = (item.product_id && categoryByProductId.get(item.product_id)) || "Outros";
      byCategory.set(category, (byCategory.get(category) ?? 0) + item.quantity);

      if (item.added_at) {
        const hour = Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "America/Sao_Paulo",
            hour: "2-digit",
            hour12: false,
          }).format(new Date(item.added_at)),
        );
        if (Number.isFinite(hour)) byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
      }
    }

    const visits = (sessions ?? []).map((session) => ({
      ...session,
      total: totalBySession.get(session.id) ?? 0,
    }));

    const favorites = Array.from(byProduct.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    const favoriteCategory =
      Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Forma de pagamento preferida: só entre visitas pagas, senão "pending"/"nunca pagou" contaria
    // como uma forma de pagamento.
    const paidVisits = visits.filter((v) => v.status === "paid" && v.payment_method);
    const byMethod = new Map<string, number>();
    for (const visit of paidVisits) {
      byMethod.set(visit.payment_method!, (byMethod.get(visit.payment_method!) ?? 0) + 1);
    }
    const preferredPaymentMethod =
      Array.from(byMethod.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Horário em que mais consome — pra saber se ele é de happy hour ou de virada de noite.
    const peakHour = Array.from(byHour.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Intervalo médio entre visitas: precisa de pelo menos duas com data de início pra ter uma
    // diferença. Cliente de visita única fica sem essa métrica, não com um zero enganoso.
    const startedDates = visits
      .map((v) => v.started_at)
      .filter((v): v is string => Boolean(v))
      .sort();
    let avgDaysBetweenVisits: number | null = null;
    if (startedDates.length >= 2) {
      const first = new Date(startedDates[0]!).getTime();
      const last = new Date(startedDates[startedDates.length - 1]!).getTime();
      avgDaysBetweenVisits = (last - first) / 86400000 / (startedDates.length - 1);
    }

    // O corte de VIP e a fatia do faturamento são relativos à base inteira, então a ficha precisa
    // consultar todos os clientes — senão o mesmo cliente apareceria com um segmento aqui e outro
    // na lista, ou uma fatia calculada contra o número errado.
    const { data: allCustomers } = await admin()
      .from("pop9_fastbar_customers")
      .select("total_spent");
    const threshold = vipSpendThreshold(allCustomers ?? []);
    const totalBaseSpend = (allCustomers ?? []).reduce((sum, c) => sum + Number(c.total_spent), 0);
    const now = Date.now();

    return {
      customer: customer ?? null,
      visits,
      favorites,
      favoriteCategory,
      preferredPaymentMethod,
      peakHour,
      avgDaysBetweenVisits,
      revenueShare:
        customer && totalBaseSpend > 0 ? Number(customer.total_spent) / totalBaseSpend : 0,
      segment: customer ? classifyLead(customer, threshold, now) : null,
      averageTicket: customer ? averageTicket(customer) : 0,
      idleDays: customer ? daysSince(customer.last_seen_at, now) : 0,
    };
  });

export const updateCustomerNotes = createServerFn({ method: "POST" })
  .inputValidator((data: { customerId: string; notes: string }) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    await assertRegisterAccess();
    const { error } = await admin()
      .from("pop9_fastbar_customers")
      .update({ notes: data.notes })
      .eq("id", data.customerId);
    if (error) return { ok: false as const, message: "Não foi possível salvar a nota." };
    return { ok: true as const };
  });
