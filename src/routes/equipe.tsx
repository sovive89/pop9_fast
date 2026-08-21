import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { unlockBarPanel } from "@/lib/bar-gate.functions";

export const Route = createFileRoute("/equipe")({
  head: () => ({
    meta: [
      { title: "Acesso do caixa | FastBar" },
      {
        name: "description",
        content: "Área restrita: informe a senha da equipe para abrir o caixa do FastBar.",
      },
      { property: "og:title", content: "Acesso do caixa | FastBar" },
      {
        property: "og:description",
        content: "Informe a senha da equipe para acessar o caixa e as comandas.",
      },
    ],
  }),
  component: StaffUnlock,
});

function StaffUnlock() {
  const navigate = useNavigate();
  const unlock = useServerFn(unlockBarPanel);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    setServerError(null);
    // Sem isso, uma exceção do servidor (ex.: variável de ambiente ausente) deixa o
    // botão preso em "Verificando..." pra sempre — a promise rejeita e nada reseta o estado.
    try {
      const { ok } = await unlock({ data: { password } });
      if (ok) {
        await navigate({ to: "/caixa", replace: true });
        return;
      }
      setError(true);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Erro inesperado no servidor.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Área restrita</p>
      <h1 className="mt-2 text-3xl font-bold">Acesso do caixa</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Informe a senha da equipe para abrir o caixa.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-3">
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Senha da equipe"
          className="h-12 w-full rounded-xl border border-border bg-card px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        {error && <p className="text-sm text-destructive">Senha incorreta.</p>}
        {serverError && (
          <p className="text-sm text-destructive">Erro no servidor: {serverError}</p>
        )}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-soft disabled:opacity-60"
        >
          {busy ? "Verificando..." : "Entrar no caixa"}
        </button>
      </form>
    </main>
  );
}
