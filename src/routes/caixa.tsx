import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { checkBarAccess, lockBarPanel } from "@/lib/bar-gate.functions";

export const Route = createFileRoute("/caixa")({
  beforeLoad: async () => {
    const { unlocked } = await checkBarAccess();
    if (!unlocked) throw redirect({ to: "/equipe" });
  },
  component: RegisterLayout,
});

function RegisterLayout() {
  const navigate = useNavigate();
  const lock = useServerFn(lockBarPanel);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = pathname.startsWith("/caixa/cardapio")
    ? "cardapio"
    : pathname.startsWith("/caixa/estoque")
      ? "estoque"
      : pathname.startsWith("/caixa/relatorios")
          ? "relatorios"
          : pathname.startsWith("/caixa/alertas")
            ? "alertas"
            : "comandas";

  const tabClass = (tab: string) =>
    `rounded-full px-4 py-1.5 text-sm font-medium ${active === tab ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`;

  return (
    <div>
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-5 pt-5">
        <div className="flex gap-2 overflow-x-auto">
          <Link to="/caixa" className={tabClass("comandas")}>
            Comandas
          </Link>
          <Link to="/caixa/cardapio" className={tabClass("cardapio")}>
            Cardápio
          </Link>
          <Link to="/caixa/estoque" className={tabClass("estoque")}>
            Estoque
          </Link>
          <Link to="/caixa/relatorios" className={tabClass("relatorios")}>
            Relatórios Vendas
          </Link>
          <Link to="/caixa/alertas" className={tabClass("alertas")}>
            Alertas
          </Link>
        </div>
        <button
          onClick={async () => {
            await lock();
            await navigate({ to: "/equipe", replace: true });
          }}
          className="shrink-0 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Sair do caixa
        </button>
      </div>
      <Outlet />
    </div>
  );
}
