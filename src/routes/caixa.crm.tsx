import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";

export const Route = createFileRoute("/caixa/crm")({
  // Pop9 é gestão de food truck — sem CRM. Redireciona a rota e as 4 subrotas de uma vez.
  beforeLoad: () => {
    throw redirect({ to: "/caixa" });
  },
  head: () => ({
    meta: [{ title: "CRM | FastBar" }],
  }),
  component: CrmLayout,
});

/**
 * Módulo próprio dentro do caixa: hoje só tem "Clientes", mas a estrutura já existe pra receber
 * Campanhas e Fidelidade sem precisar reorganizar rota de novo.
 */
function CrmLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname.startsWith("/caixa/crm/clientes")
    ? "clientes"
    : pathname.startsWith("/caixa/crm/analises")
      ? "analises"
      : "visao-geral";

  const tabClass = (tab: string) =>
    `rounded-full px-3.5 py-1.5 text-xs font-medium ${
      active === tab
        ? "bg-primary text-primary-foreground"
        : "bg-secondary text-secondary-foreground"
    }`;

  return (
    <div>
      <div className="mx-auto w-full max-w-2xl px-5 pt-5">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">CRM</p>
        <div className="mt-2 flex gap-2 overflow-x-auto">
          <Link to="/caixa/crm" className={tabClass("visao-geral")}>
            Visão geral
          </Link>
          <Link to="/caixa/crm/clientes" className={tabClass("clientes")}>
            Clientes
          </Link>
          <Link to="/caixa/crm/analises" className={tabClass("analises")}>
            Análises
          </Link>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
