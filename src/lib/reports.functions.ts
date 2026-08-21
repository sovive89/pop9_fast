import { createServerFn } from "@tanstack/react-start";

export type ReportsRange = { from: string; to: string };

/** Hora local do bar a partir do timestamp UTC gravado no banco. */
function localHour(iso: string) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return Number(hour);
}

export const getReportsOverview = createServerFn({ method: "POST" })
  .inputValidator((data: ReportsRange) => data)
  .handler(async ({ data }) => {
    const { admin, assertRegisterAccess } = await import("./fastbar.server");
    const { classifyLead, vipSpendThreshold } = await import("./crm");
    await assertRegisterAccess();

    const { data: sessions } = await admin()
      .from("pop9_fastbar_sessions")
      .select("id, paid_at, payment_method, customer_id, discount_percent")
      .eq("status", "paid")
      .gte("paid_at", data.from)
      .lte("paid_at", data.to);

    const sessionIds = (sessions ?? []).map((session) => session.id);

    // Desconto de boas-vindas do CRM não entra na receita por produto/categoria/hora: é um custo de
    // aquisição de cliente, não do produto — descontar ali puxaria pra baixo a margem de itens que
    // não têm nada a ver com a promoção. Fica separado como uma linha própria ("Desconto CRM").
    const revenueOf = (item: { unit_price: number; quantity: number }) =>
      Number(item.unit_price) * item.quantity;

    const [{ data: items }, { data: products }, { data: recipeItems }] = await Promise.all([
      sessionIds.length
        ? admin()
            .from("pop9_fastbar_tab_items")
            .select("session_id, product_id, name, unit_price, quantity, added_at")
            .in("session_id", sessionIds)
        : Promise.resolve({ data: [] as never[] }),
      admin().from("pop9_fastbar_products").select("id, category, average_cost"),
      admin().from("pop9_fastbar_recipe_items").select("product_id, base_drink_id, ingredient_id, quantity"),
    ]);

    // Custo dos insumos, pra fechar o CMV de item com ficha técnica: nesses, o custo não está no
    // produto (que não tem estoque próprio) e sim espalhado nos componentes da receita.
    const usesComponents = (recipeItems ?? []).length > 0;
    const [{ data: baseDrinks }, { data: ingredients }] = usesComponents
      ? await Promise.all([
          admin().from("pop9_fastbar_base_drinks").select("id, average_cost"),
          admin().from("pop9_fastbar_drink_ingredients").select("id, average_cost"),
        ])
      : [{ data: [] as never[] }, { data: [] as never[] }];

    const componentCost = new Map<string, number>();
    for (const row of baseDrinks ?? []) componentCost.set(row.id, Number(row.average_cost) || 0);
    for (const row of ingredients ?? []) componentCost.set(row.id, Number(row.average_cost) || 0);

    // Custo de uma unidade de cada produto com receita = soma de (quantidade × custo do insumo).
    const recipeCostByProduct = new Map<string, number>();
    const recipeHasPricelessComponent = new Set<string>();
    for (const row of recipeItems ?? []) {
      const componentId = row.base_drink_id ?? row.ingredient_id;
      if (!componentId) continue;
      const unitCost = componentCost.get(componentId) ?? 0;
      if (unitCost <= 0) recipeHasPricelessComponent.add(row.product_id);
      recipeCostByProduct.set(
        row.product_id,
        (recipeCostByProduct.get(row.product_id) ?? 0) + Number(row.quantity) * unitCost,
      );
    }

    const productInfo = new Map(
      (products ?? []).map((p) => [p.id, { category: p.category, cost: Number(p.average_cost) || 0 }]),
    );

    /** Custo de uma unidade vendida. Receita manda: produto com ficha não tem custo próprio. */
    function unitCostOf(productId: string | null) {
      if (!productId) return 0;
      if (recipeCostByProduct.has(productId)) return recipeCostByProduct.get(productId)!;
      return productInfo.get(productId)?.cost ?? 0;
    }

    const revenueBySession = new Map<string, number>();
    for (const item of items ?? []) {
      const revenue = revenueOf(item);
      revenueBySession.set(item.session_id, (revenueBySession.get(item.session_id) ?? 0) + revenue);
    }

    const totalRevenue = Array.from(revenueBySession.values()).reduce((sum, v) => sum + v, 0);
    const paidSessionsCount = sessions?.length ?? 0;
    const averageTicket = paidSessionsCount > 0 ? totalRevenue / paidSessionsCount : 0;

    // Linha própria, fora do cálculo de CMV/margem: quanto foi abatido em desconto de boas-vindas
    // no período, e de quantas comandas. totalRevenue continua no preço de tabela — é o que caiu
    // de fato no caixa que fica menor, não o que os produtos "valem".
    let crmDiscountTotal = 0;
    let crmDiscountSessions = 0;
    for (const session of sessions ?? []) {
      const percent = Number(session.discount_percent ?? 0);
      if (percent <= 0) continue;
      const sessionRevenue = revenueBySession.get(session.id) ?? 0;
      crmDiscountTotal += sessionRevenue * (percent / 100);
      crmDiscountSessions += 1;
    }

    // ---- CMV -------------------------------------------------------------
    // Itens sem custo registrado ficam contados à parte: sem isso o CMV apareceria menor do que é
    // e a margem, maior — o erro cairia justo pro lado que engana a favor.
    let totalCost = 0;
    let revenueWithoutCost = 0;
    const missingCostNames = new Set<string>();
    for (const item of items ?? []) {
      const unitCost = unitCostOf(item.product_id);
      const revenue = revenueOf(item);
      if (unitCost <= 0 || (item.product_id && recipeHasPricelessComponent.has(item.product_id))) {
        revenueWithoutCost += revenue;
        missingCostNames.add(item.name);
      }
      totalCost += unitCost * item.quantity;
    }
    const grossProfit = totalRevenue - totalCost;
    const cmvPercent = totalRevenue > 0 ? (totalCost / totalRevenue) * 100 : 0;
    const marginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    // ---- Séries ----------------------------------------------------------
    const byDay = new Map<string, number>();
    for (const session of sessions ?? []) {
      if (!session.paid_at) continue;
      const day = session.paid_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + (revenueBySession.get(session.id) ?? 0));
    }
    const revenueByDay = Array.from(byDay.entries())
      .map(([date, revenue]) => ({ date, revenue }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const byMethod = new Map<string, number>();
    for (const session of sessions ?? []) {
      const method = session.payment_method ?? "Não informado";
      byMethod.set(method, (byMethod.get(method) ?? 0) + (revenueBySession.get(session.id) ?? 0));
    }
    const revenueByMethod = Array.from(byMethod.entries()).map(([method, revenue]) => ({
      method,
      revenue,
    }));

    const byProduct = new Map<
      string,
      { name: string; quantity: number; revenue: number; cost: number }
    >();
    const byCategory = new Map<string, { revenue: number; cost: number }>();
    const byHour = new Map<number, number>();
    for (const item of items ?? []) {
      const revenue = Number(item.unit_price) * item.quantity;
      const cost = unitCostOf(item.product_id) * item.quantity;

      const key = item.product_id ?? item.name;
      const current = byProduct.get(key) ?? { name: item.name, quantity: 0, revenue: 0, cost: 0 };
      current.quantity += item.quantity;
      current.revenue += revenue;
      current.cost += cost;
      byProduct.set(key, current);

      const category =
        (item.product_id && productInfo.get(item.product_id)?.category) || "Outros";
      const catCurrent = byCategory.get(category) ?? { revenue: 0, cost: 0 };
      catCurrent.revenue += revenue;
      catCurrent.cost += cost;
      byCategory.set(category, catCurrent);

      if (item.added_at) {
        const hour = localHour(item.added_at);
        if (Number.isFinite(hour)) byHour.set(hour, (byHour.get(hour) ?? 0) + revenue);
      }
    }

    const topProducts = Array.from(byProduct.values())
      .map((row) => ({
        name: row.name,
        quantity: row.quantity,
        revenue: row.revenue,
        cost: row.cost,
        profit: row.revenue - row.cost,
        marginPercent: row.revenue > 0 ? ((row.revenue - row.cost) / row.revenue) * 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const revenueByCategory = Array.from(byCategory.entries())
      .map(([category, row]) => ({
        category,
        revenue: row.revenue,
        cost: row.cost,
        profit: row.revenue - row.cost,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const revenueByHour = Array.from(byHour.entries())
      .map(([hour, revenue]) => ({ hour, revenue }))
      .sort((a, b) => a.hour - b.hour);

    // ---- Clientes: novo x recorrente, e composição da base -----------------
    // Comanda de balcão não tem cliente (customer_id nulo) e entra numa fatia própria, em vez de
    // ser somada como se fosse cliente novo — inflaria "novos" com quem nem cadastrado é.
    const customerIds = Array.from(
      new Set((sessions ?? []).map((s) => s.customer_id).filter((id): id is string => Boolean(id))),
    );
    const { data: periodCustomers } = customerIds.length
      ? await admin()
          .from("pop9_fastbar_customers")
          .select("id, first_seen_at")
          .in("id", customerIds)
      : { data: [] as never[] };
    const firstSeenById = new Map(
      (periodCustomers ?? []).map((c) => [c.id, c.first_seen_at as string]),
    );

    let newCustomerRevenue = 0;
    let returningCustomerRevenue = 0;
    let walkInRevenue = 0;
    const newCustomerIds = new Set<string>();
    const returningCustomerIds = new Set<string>();
    for (const session of sessions ?? []) {
      const revenue = revenueBySession.get(session.id) ?? 0;
      if (!session.customer_id) {
        walkInRevenue += revenue;
        continue;
      }
      const firstSeen = firstSeenById.get(session.customer_id);
      const isNew = firstSeen ? firstSeen >= data.from : false;
      if (isNew) {
        newCustomerRevenue += revenue;
        newCustomerIds.add(session.customer_id);
      } else {
        returningCustomerRevenue += revenue;
        returningCustomerIds.add(session.customer_id);
      }
    }

    const { data: allCustomers } = await admin()
      .from("pop9_fastbar_customers")
      .select("id, total_visits, total_spent, last_seen_at");
    const threshold = vipSpendThreshold(allCustomers ?? []);
    const segmentCounts: Record<string, number> = {};
    const segmentByCustomerId = new Map<string, string>();
    for (const customer of allCustomers ?? []) {
      const segment = classifyLead(customer, threshold);
      segmentCounts[segment] = (segmentCounts[segment] ?? 0) + 1;
      segmentByCustomerId.set(customer.id, segment);
    }

    // Cruza o faturamento do período (já calculado por sessão acima) com o segmento de cada
    // cliente — responde "quem sustenta o caixa em R$", não só "quantos clientes tem em cada
    // grupo". Comanda de balcão (sem customer_id) não entra: não tem segmento pra atribuir.
    const revenueBySegment: Record<string, number> = {};
    for (const session of sessions ?? []) {
      if (!session.customer_id) continue;
      const segment = segmentByCustomerId.get(session.customer_id);
      if (!segment) continue;
      const revenue = revenueBySession.get(session.id) ?? 0;
      revenueBySegment[segment] = (revenueBySegment[segment] ?? 0) + revenue;
    }

    return {
      totalRevenue,
      paidSessionsCount,
      averageTicket,
      crmDiscountTotal,
      crmDiscountSessions,
      totalCost,
      grossProfit,
      cmvPercent,
      marginPercent,
      revenueWithoutCost,
      missingCostProducts: Array.from(missingCostNames).slice(0, 10),
      revenueByDay,
      revenueByMethod,
      revenueByCategory,
      revenueByHour,
      topProducts,
      customerMix: {
        newRevenue: newCustomerRevenue,
        returningRevenue: returningCustomerRevenue,
        walkInRevenue,
        newCount: newCustomerIds.size,
        returningCount: returningCustomerIds.size,
      },
      segmentCounts,
      revenueBySegment,
    };
  });
