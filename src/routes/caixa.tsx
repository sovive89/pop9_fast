import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Bell,
  ClipboardList,
  Factory,
  LogOut,
  Package,
  UtensilsCrossed,
  TrendingUp,
} from "lucide-react";
import { checkBarAccess, lockBarPanel } from "@/lib/bar-gate.functions";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export const Route = createFileRoute("/caixa")({
  beforeLoad: async () => {
    const { unlocked } = await checkBarAccess();
    if (!unlocked) throw redirect({ to: "/equipe" });
  },
  component: RegisterLayout,
});

const MODULES = [
  { id: "lancamentos", to: "/caixa", label: "Lançamentos", icon: ClipboardList },
  { id: "cardapio", to: "/caixa/cardapio", label: "Cardápio", icon: UtensilsCrossed },
  { id: "estoque", to: "/caixa/estoque", label: "Estoque", icon: Package },
  { id: "producao", to: "/caixa/producao", label: "Produção", icon: Factory },
  { id: "relatorios", to: "/caixa/relatorios", label: "Relatórios Vendas", icon: TrendingUp },
  { id: "alertas", to: "/caixa/alertas", label: "Alertas", icon: Bell },
] as const;

function RegisterLayout() {
  const navigate = useNavigate();
  const lock = useServerFn(lockBarPanel);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const active =
    MODULES.find((m) => (m.id === "lancamentos" ? pathname === "/caixa" : pathname.startsWith(m.to)))
      ?.id ?? "lancamentos";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-primary group-data-[collapsible=icon]:hidden">
            Pop9 Fast
          </p>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {MODULES.map((mod) => (
                  <SidebarMenuItem key={mod.id}>
                    <SidebarMenuButton asChild isActive={active === mod.id} tooltip={mod.label}>
                      <Link to={mod.to}>
                        <mod.icon />
                        <span>{mod.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Sair do caixa"
                onClick={async () => {
                  await lock();
                  await navigate({ to: "/equipe", replace: true });
                }}
              >
                <LogOut />
                <span>Sair do caixa</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <div className="flex items-center gap-2 px-5 pt-5 md:hidden">
          <SidebarTrigger />
        </div>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
