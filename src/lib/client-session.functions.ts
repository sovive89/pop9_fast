import { createServerFn } from "@tanstack/react-start";

export const openClientSession = createServerFn({ method: "POST" })
  .inputValidator((data: { name: string; phone: string }) => data)
  .handler(async ({ data }) => {
    const { admin, sanitizeName, sanitizePhone, upsertCustomer } = await import(
      "./fastbar.server"
    );

    const name = sanitizeName(data.name);
    const phone = sanitizePhone(data.phone);

    if (!name || !phone) {
      return { ok: false as const, message: "Informe nome completo e celular com DDD." };
    }

    // Mesmo celular já tem comanda em andamento: manda para ela em vez de criar outra.
    const { data: existing } = await admin()
      .from("pop9_fastbar_sessions")
      .select("id, customer_id")
      .eq("phone", phone)
      .in("status", ["pending", "open"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      const profileCompleted = await isProfileCompleted(existing.customer_id);
      return { ok: true as const, sessionId: existing.id, profileCompleted };
    }

    const customerId = await upsertCustomer(name, phone);

    const { data: inserted, error } = await admin()
      .from("pop9_fastbar_sessions")
      .insert({
        customer_name: name,
        phone,
        status: "pending",
        customer_id: customerId,
      })
      .select("id")
      .single();

    if (error || !inserted) {
      return { ok: false as const, message: "Não foi possível abrir a comanda." };
    }

    const profileCompleted = await isProfileCompleted(customerId);
    return { ok: true as const, sessionId: inserted.id, profileCompleted };
  });

async function isProfileCompleted(customerId: string | null) {
  if (!customerId) return false;
  const { admin } = await import("./fastbar.server");
  const { data } = await admin()
    .from("pop9_fastbar_customers")
    .select("profile_completed_at")
    .eq("id", customerId)
    .maybeSingle();
  return Boolean(data?.profile_completed_at);
}

export const ADMINISTRATIVE_REGIONS = [
  "Águas Claras",
  "Brazlândia",
  "Candangolândia",
  "Ceilândia",
  "Cruzeiro",
  "Fercal",
  "Gama",
  "Guará",
  "Itapoã",
  "Jardim Botânico",
  "Lago Norte",
  "Lago Sul",
  "Núcleo Bandeirante",
  "Paranoá",
  "Park Way",
  "Planaltina",
  "Plano Piloto",
  "Recanto das Emas",
  "Riacho Fundo",
  "Riacho Fundo II",
  "Samambaia",
  "Santa Maria",
  "São Sebastião",
  "SCIA/Estrutural",
  "SIA",
  "Sobradinho",
  "Sobradinho II",
  "Sol Nascente/Pôr do Sol",
  "Taguatinga",
  "Vicente Pires",
  "Varjão",
] as const;

export const HOW_FOUND_OUT_OPTIONS = [
  "Indicação de amigo",
  "Instagram",
  "Facebook",
  "Passando na rua",
  "Evento",
  "Google",
  "Outro",
] as const;

export const AGE_RANGE_OPTIONS = ["18-24", "25-34", "35-44", "45+"] as const;

export const MUSIC_GENRE_OPTIONS = [
  "Sertanejo",
  "Pagode/Samba",
  "Eletrônica",
  "Rock",
  "Funk",
  "Forró",
  "Variado",
  "Outro",
] as const;

// Compartilhado com a UI da tela de perfil, que anuncia esse número pro cliente antes de pedir os
// dados — mudar aqui sem mudar lá deixaria a promessa e a conta descasadas.
export const WELCOME_DISCOUNT_PERCENT = 10;

/**
 * Segunda tela, separada da abertura da comanda de propósito — é aqui que o consentimento de
 * marketing é um ato próprio, não algo aceito sem perceber junto com nome+celular.
 */
export const submitCustomerProfile = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      sessionId: string;
      fullName?: string;
      birthdayDay?: number;
      birthdayMonth?: number;
      administrativeRegion?: string;
      howFoundOut?: string;
      ageRange?: string;
      profession?: string;
      favoriteMusicGenre?: string;
      marketingOptIn: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { admin, sanitizeName } = await import("./fastbar.server");

    if (typeof data.marketingOptIn !== "boolean") {
      return { ok: false as const, message: "Escolha sim ou não para continuar." };
    }
    // Aniversário é tudo ou nada: dia sem mês (ou vice-versa) não serve pra campanha nenhuma e
    // quebraria o CHECK do banco — melhor recusar aqui com mensagem clara do que estourar erro.
    const hasDay = typeof data.birthdayDay === "number";
    const hasMonth = typeof data.birthdayMonth === "number";
    if (hasDay !== hasMonth) {
      return { ok: false as const, message: "Informe dia e mês do aniversário, ou deixe os dois em branco." };
    }
    if (hasDay && (data.birthdayDay! < 1 || data.birthdayDay! > 31)) {
      return { ok: false as const, message: "Dia do aniversário inválido." };
    }
    if (hasMonth && (data.birthdayMonth! < 1 || data.birthdayMonth! > 12)) {
      return { ok: false as const, message: "Mês do aniversário inválido." };
    }

    const { data: session } = await admin()
      .from("pop9_fastbar_sessions")
      .select("customer_id")
      .eq("id", data.sessionId)
      .maybeSingle();
    if (!session?.customer_id) {
      return { ok: false as const, message: "Comanda não encontrada." };
    }

    const fullName = data.fullName ? sanitizeName(data.fullName) : null;
    const nowIso = new Date().toISOString();

    const profile = {
      full_name: fullName,
      birthday_day: data.birthdayDay ?? null,
      birthday_month: data.birthdayMonth ?? null,
      administrative_region: data.administrativeRegion?.trim() || null,
      how_found_out: data.howFoundOut?.trim() || null,
      age_range: data.ageRange?.trim() || null,
      profession: data.profession?.trim() || null,
      favorite_music_genre: data.favoriteMusicGenre?.trim() || null,
    };

    // O desconto sai por cadastro completo E aceite de promoções — é a troca anunciada na tela.
    // Checa o objeto já normalizado (trim + null), senão um campo só com espaços passaria.
    const filledEverything = Object.values(profile).every((value) => value !== null);
    const earnsDiscount = filledEverything && data.marketingOptIn;

    const { data: customer } = await admin()
      .from("pop9_fastbar_customers")
      .select("welcome_discount_earned_at")
      .eq("id", session.customer_id)
      .maybeSingle();
    // Só concede uma vez na vida do cliente, mesmo que ele reencontre a tela por outro caminho.
    const grantDiscount = earnsDiscount && !customer?.welcome_discount_earned_at;

    const { error } = await admin()
      .from("pop9_fastbar_customers")
      .update({
        ...profile,
        marketing_opt_in: data.marketingOptIn,
        profile_completed_at: nowIso,
        ...(grantDiscount ? { welcome_discount_earned_at: nowIso } : {}),
      })
      .eq("id", session.customer_id);

    if (error) return { ok: false as const, message: "Não foi possível salvar." };

    if (grantDiscount) {
      // Aplicado depois do cadastro salvar: se o desconto falhar, o cliente não perde os dados
      // que digitou — e o pior caso é ficar sem o abatimento, não com cadastro pela metade.
      await admin()
        .from("pop9_fastbar_sessions")
        .update({ discount_percent: WELCOME_DISCOUNT_PERCENT })
        .eq("id", data.sessionId);
    }

    return { ok: true as const, discountGranted: grantDiscount };
  });
