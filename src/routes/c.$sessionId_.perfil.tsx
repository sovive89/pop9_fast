import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Field } from "@/components/shared/Field";
import {
  ADMINISTRATIVE_REGIONS,
  AGE_RANGE_OPTIONS,
  HOW_FOUND_OUT_OPTIONS,
  MUSIC_GENRE_OPTIONS,
  submitCustomerProfile,
} from "@/lib/client-session.functions";

export const Route = createFileRoute("/c/$sessionId_/perfil")({
  // Depende do fluxo de cliente por QR code, que o pop9 não tem.
  beforeLoad: () => {
    throw redirect({ to: "/equipe" });
  },
  head: () => ({
    meta: [
      { title: "Só mais um pouquinho | FastBar" },
      {
        name: "description",
        content: "Conte um pouco mais sobre você — tudo opcional, exceto uma pergunta.",
      },
    ],
  }),
  component: CustomerProfilePage,
});

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const MONTHS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

function selectClass() {
  return "mt-1.5 h-12 w-full rounded-xl border border-border bg-card px-4 text-base outline-none focus:border-ring";
}

function CustomerProfilePage() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const submit = useServerFn(submitCustomerProfile);

  const [fullName, setFullName] = useState("");
  const [birthdayDay, setBirthdayDay] = useState("");
  const [birthdayMonth, setBirthdayMonth] = useState("");
  const [administrativeRegion, setAdministrativeRegion] = useState("");
  const [howFoundOut, setHowFoundOut] = useState("");
  const [ageRange, setAgeRange] = useState("");
  const [profession, setProfession] = useState("");
  const [favoriteMusicGenre, setFavoriteMusicGenre] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function goToTab() {
    await navigate({ to: "/c/$sessionId", params: { sessionId } });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    // Único campo obrigatório da tela: a regra é escolher sim ou não, nunca deixar em branco.
    if (marketingOptIn === null) {
      setError("Escolha sim ou não pra continuar.");
      return;
    }
    setError(null);
    setBusy(true);
    const result = await submit({
      data: {
        sessionId,
        marketingOptIn,
        ...(fullName ? { fullName } : {}),
        ...(birthdayDay ? { birthdayDay: Number(birthdayDay) } : {}),
        ...(birthdayMonth ? { birthdayMonth: Number(birthdayMonth) } : {}),
        ...(administrativeRegion ? { administrativeRegion } : {}),
        ...(howFoundOut ? { howFoundOut } : {}),
        ...(ageRange ? { ageRange } : {}),
        ...(profession ? { profession } : {}),
        ...(favoriteMusicGenre ? { favoriteMusicGenre } : {}),
      },
    });
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    await goToTab();
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          Só mais um pouquinho
        </p>
        <h1 className="mt-1 text-2xl font-bold">Quer contar mais sobre você?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tudo aqui é opcional, menos a última pergunta. Ajuda a gente a te conhecer melhor.
        </p>
        <p className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          🎁 Preencha tudo e aceite receber novidades pra ganhar <strong>10% de desconto</strong> na
          comanda de hoje.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <Field id="fullName" label="Nome completo" value={fullName} onChange={setFullName} />

        <div>
          <span className="text-sm font-medium">Aniversário (dia e mês, sem o ano)</span>
          <div className="mt-1.5 grid grid-cols-2 gap-3">
            <select
              value={birthdayDay}
              onChange={(event) => setBirthdayDay(event.target.value)}
              className={selectClass()}
            >
              <option value="">Dia</option>
              {DAYS.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>
            <select
              value={birthdayMonth}
              onChange={(event) => setBirthdayMonth(event.target.value)}
              className={selectClass()}
            >
              <option value="">Mês</option>
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="block">
          <span className="text-sm font-medium">Bairro / Região Administrativa</span>
          <select
            value={administrativeRegion}
            onChange={(event) => setAdministrativeRegion(event.target.value)}
            className={selectClass()}
          >
            <option value="">Prefiro não dizer</option>
            {ADMINISTRATIVE_REGIONS.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Como conheceu o bar?</span>
          <select
            value={howFoundOut}
            onChange={(event) => setHowFoundOut(event.target.value)}
            className={selectClass()}
          >
            <option value="">Prefiro não dizer</option>
            {HOW_FOUND_OUT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Faixa etária</span>
          <select
            value={ageRange}
            onChange={(event) => setAgeRange(event.target.value)}
            className={selectClass()}
          >
            <option value="">Prefiro não dizer</option>
            {AGE_RANGE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <Field id="profession" label="Profissão (opcional)" value={profession} onChange={setProfession} />

        <label className="block">
          <span className="text-sm font-medium">Gênero musical preferido</span>
          <select
            value={favoriteMusicGenre}
            onChange={(event) => setFavoriteMusicGenre(event.target.value)}
            className={selectClass()}
          >
            <option value="">Prefiro não dizer</option>
            {MUSIC_GENRE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-sm font-medium">
            Podemos te enviar promoções e novidades pelo WhatsApp e Instagram?
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setMarketingOptIn(true)}
              className={`h-11 flex-1 rounded-xl text-sm font-semibold ${
                marketingOptIn === true
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground"
              }`}
            >
              Sim
            </button>
            <button
              type="button"
              onClick={() => setMarketingOptIn(false)}
              className={`h-11 flex-1 rounded-xl text-sm font-semibold ${
                marketingOptIn === false
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground"
              }`}
            >
              Não
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-soft disabled:opacity-60"
        >
          {busy ? "Salvando..." : "Continuar"}
        </button>
      </form>
    </main>
  );
}
