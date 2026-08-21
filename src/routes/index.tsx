import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  // Pop9 não tem página pública de cliente — só acesso da equipe.
  beforeLoad: () => {
    throw redirect({ to: "/equipe" });
  },
  component: function HomeRedirect() {
    return null;
  },
});
