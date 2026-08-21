import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/comanda/$sessionId")({
  head: () => ({
    meta: [
      { title: "Minha comanda | FastBar" },
      {
        name: "description",
        content: "Acompanhe os itens lançados pelo caixa, o total e o tempo no bar.",
      },
    ],
  }),
  beforeLoad: () => {
    // Pop9 não tem fluxo de cliente — este link antigo agora vai pro acesso da equipe.
    throw redirect({ to: "/equipe" });
  },
  component: function ComandaRedirect() {
    return null;
  },
});
