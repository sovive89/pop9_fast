import { createFileRoute, redirect } from "@tanstack/react-router";
import { OpenTabForm } from "@/features/client/components/OpenTabForm";

export const Route = createFileRoute("/abrir")({
  // Pop9 não tem autoatendimento por QR code — a comanda é aberta pela equipe, no caixa.
  beforeLoad: () => {
    throw redirect({ to: "/equipe" });
  },
  head: () => ({
    meta: [
      { title: "Abrir comanda | FastBar" },
      {
        name: "description",
        content:
          "Abra sua comanda informando nome e celular e acompanhe seu consumo em tempo real.",
      },
    ],
  }),
  component: AbrirPage,
});

function AbrirPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-10">
      <OpenTabForm />
    </main>
  );
}
