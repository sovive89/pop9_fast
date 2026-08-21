import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PasswordConfirm } from "@/components/shared/PasswordConfirm";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { brl, digits, elapsed, formatPhone, hhmm } from "@/lib/format";
import { useServerFn } from "@tanstack/react-start";
import { getRegisterOverview } from "@/lib/tab-reads.functions";
import {
  archiveClosedSessions,
  archiveSession,
  cancelSession,
  clearTabItems,
  openSessionByTeam,
  openWalkInSession,
  removeTabItem,
  unarchiveSession,
  undoLastTabItem,
} from "@/lib/register.functions";
import type { BarSession } from "@/types/fastbar";

type OverviewItem = {
  id: string;
  session_id: string;
  name: string;
  unit_price: number;
  quantity: number;
  added_at: string;
};

export const Route = createFileRoute("/caixa/")({
  head: () => ({
    meta: [
      { title: "Caixa | Lançamentos do Pop9 Fast" },
      {
        name: "description",
        content: "Localize lançamentos por nome ou celular, lance itens e feche a conta.",
      },
      { property: "og:title", content: "Caixa | Lançamentos do Pop9 Fast" },
      {
        property: "og:description",
        content: "Lançamentos abertos, busca rápida e fechamento pelo caixa.",
      },
    ],
  }),
  component: RegisterList,
});

/** Código curto e legível pra equipe conferir o cliente sem ler um UUID inteiro. */
function shortId(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(/-/g, "").slice(0, 6).toUpperCase();
}

/** "Maria Creuza" -> "Maria C." — cabe no card quadrado sem truncar de forma ilegível. */
function shortName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? name;
  return `${parts[0]} ${parts[1]!.charAt(0).toUpperCase()}.`;
}

function RegisterList() {
  const [sessions, setSessions] = useState<BarSession[]>([]);
  const [items, setItems] = useState<OverviewItem[]>([]);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"open" | "all" | "archived">("open");
  const [now, setNow] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    kind: string;
    sessionId?: string;
    itemId?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Abertura pela equipe (sem QR) e lançamento de balcão. Campos próprios, fora do `confirming`
  // genérico, porque aqui não é confirmar uma ação num lançamento que já existe — é criar um.
  const [opening, setOpening] = useState<null | "manual" | "walkin">(null);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");

  const navigate = useNavigate();
  const loadOverview = useServerFn(getRegisterOverview);
  const undoLast = useServerFn(undoLastTabItem);
  const removeItem = useServerFn(removeTabItem);
  const clearItems = useServerFn(clearTabItems);
  const cancelOne = useServerFn(cancelSession);
  const archiveOne = useServerFn(archiveSession);
  const unarchiveOne = useServerFn(unarchiveSession);
  const archiveClosed = useServerFn(archiveClosedSessions);
  const openManual = useServerFn(openSessionByTeam);
  const openWalkIn = useServerFn(openWalkInSession);

  async function load() {
    const result = await loadOverview();
    setSessions(result.sessions as BarSession[]);
    setItems(result.items as OverviewItem[]);
  }

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 10000);
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      clearInterval(poll);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const itemsBySession = useMemo(() => {
    const map = new Map<string, OverviewItem[]>();
    for (const item of items) {
      const list = map.get(item.session_id) ?? [];
      list.push(item);
      map.set(item.session_id, list);
    }
    return map;
  }, [items]);

  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      map.set(
        item.session_id,
        (map.get(item.session_id) ?? 0) + Number(item.unit_price) * item.quantity,
      );
    }
    return map;
  }, [items]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const termDigits = digits(search);
    return sessions
      .filter((session) => {
        const archived = Boolean(session.archived_at);
        if (view === "archived") return archived;
        if (archived) return false;
        // "Em aberto" = ainda em andamento. Paga e cancelada são desfechos, não pendências.
        return view === "all" ? true : !["paid", "cancelled"].includes(session.status);
      })
      .filter((session) => {
        if (!term) return true;
        return (
          session.customer_name.toLowerCase().includes(term) ||
          (termDigits.length > 0 && session.phone.includes(termDigits))
        );
      });
  }, [sessions, search, view]);

  const openSessions = sessions.filter((session) => session.status === "open");
  const openTotal = openSessions.reduce((sum, session) => sum + (totals.get(session.id) ?? 0), 0);
  const archivableCount = sessions.filter(
    (session) =>
      !session.archived_at && ["closed", "paid", "cancelled"].includes(session.status),
  ).length;

  /** Abre e já leva pro lançamento: quem abre quer lançar em seguida, não voltar pra lista. */
  async function confirmOpenManual(password: string) {
    const result = await openManual({ data: { name: newName, phone: newPhone, password } });
    if (result.ok) {
      setOpening(null);
      setNewName("");
      setNewPhone("");
      await navigate({ to: "/caixa/$sessionId", params: { sessionId: result.sessionId } });
    }
    return result;
  }

  async function confirmOpenWalkIn(password: string) {
    const result = await openWalkIn({ data: { password } });
    if (result.ok) {
      setOpening(null);
      await navigate({ to: "/caixa/$sessionId", params: { sessionId: result.sessionId } });
    }
    return result;
  }

  async function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) return setError(result.message ?? "Não foi possível concluir.");
      setConfirming(null);
      await load();
    } catch {
      setError("Não foi possível concluir — tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Caixa</p>
          <h1 className="mt-1 text-3xl font-bold">Lançamentos</h1>
        </div>
        <div className="text-right text-sm">
          <p className="text-muted-foreground">{openSessions.length} abertas</p>
          <p className="font-semibold">{brl(openTotal)}</p>
        </div>
      </div>

      <div className="mt-6 flex gap-2">
        <button
          onClick={() => {
            setOpening(opening === "manual" ? null : "manual");
            setNewName("");
            setNewPhone("");
            setError(null);
          }}
          className="h-11 flex-1 rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-soft"
        >
          {opening === "manual" ? "Cancelar" : "+ Abrir lançamento"}
        </button>
        <button
          onClick={() => {
            setOpening(opening === "walkin" ? null : "walkin");
            setError(null);
          }}
          className="h-11 flex-1 rounded-xl border border-border text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {opening === "walkin" ? "Cancelar" : "Lançamento balcão"}
        </button>
      </div>

      {opening === "manual" && (
        <div className="mt-3 space-y-3 rounded-2xl border border-border bg-card p-4">
          <p className="text-sm font-semibold">Abrir lançamento</p>
          <p className="text-xs text-muted-foreground">
            Cadastra o cliente e abre o lançamento. Se esse celular já tiver um em andamento, você
            vai direto pra ele.
          </p>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Nome completo"
            autoFocus
            maxLength={80}
            className="h-11 w-full rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <input
            value={newPhone}
            onChange={(event) => setNewPhone(formatPhone(event.target.value))}
            placeholder="(11) 91234-5678"
            inputMode="tel"
            className="h-11 w-full rounded-xl border border-border bg-background px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <PasswordConfirm
            message="Confirme com a senha da equipe para abrir o lançamento."
            confirmLabel="Abrir lançamento"
            onCancel={() => setOpening(null)}
            onConfirm={confirmOpenManual}
          />
        </div>
      )}

      {opening === "walkin" && (
        <div className="mt-3 rounded-2xl border border-border bg-card p-4">
          <PasswordConfirm
            message="Abrir o lançamento de balcão do dia? Ele registra produto, estoque e faturamento como qualquer outro — só não fica relacionado a nenhum cliente. Se o de hoje já estiver aberto, você vai direto pra ele."
            confirmLabel="Abrir balcão"
            onCancel={() => setOpening(null)}
            onConfirm={confirmOpenWalkIn}
          />
        </div>
      )}

      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Buscar por nome ou celular"
        className="mt-6 h-12 w-full rounded-xl border border-border bg-card px-4 text-base outline-none placeholder:text-muted-foreground focus:border-ring"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(
          [
            { id: "open", label: "Em aberto" },
            { id: "all", label: "Todas" },
            { id: "archived", label: "Arquivadas" },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            onClick={() => setView(option.id)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${view === option.id ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}
          >
            {option.label}
          </button>
        ))}
        {view === "all" && archivableCount > 0 && (
          <button
            onClick={() => setConfirming({ kind: "archiveAll" })}
            className="ml-auto rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Arquivar fechadas ({archivableCount})
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {confirming?.kind === "archiveAll" && (
        <ConfirmBar
          message={`Tirar ${archivableCount} lançamentos fechados/pagos/cancelados da lista? Nada é apagado — eles continuam contando no faturamento (quando aplicável) e você pode revê-los em "Arquivadas".`}
          confirmLabel="Arquivar"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => run(() => archiveClosed({ data: {} }))}
        />
      )}

      {filtered.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          Nenhum lançamento encontrado.
        </p>
      ) : (
        <ul className="mt-5 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {filtered.map((session) => {
            const isExpanded = expandedId === session.id;
            const sessionItems = itemsBySession.get(session.id) ?? [];
            const code = shortId(session.customer_id ?? session.id);
            const isPaid = session.status === "paid";
            const isCancelled = session.status === "cancelled";
            const isOpen = session.status === "open";
            const isClosed = session.status === "closed";
            const isArchived = Boolean(session.archived_at);
            const canArchive = !isArchived && (isClosed || isPaid || isCancelled);
            // Lançamento cancelado que ainda tem itens é um cancelamento que travou antes de
            // devolver tudo ao estoque. Oferecer a ação de novo é o que permite terminá-lo — o
            // servidor trata a repetição como retomada, não como novo cancelamento.
            const cancelStalled = isCancelled && sessionItems.length > 0;
            const canCancel = !isArchived && (isOpen || isClosed || cancelStalled);

            return (
              <li key={session.id} className={isExpanded ? "col-span-3 sm:col-span-4" : ""}>
                <div className="rounded-2xl border border-border bg-card">
                  {isExpanded ? (
                    <div className="flex items-start gap-1 p-4">
                      <button
                        onClick={() => setExpandedId(null)}
                        className="flex min-w-0 flex-1 items-start justify-between gap-4 text-left"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {session.customer_name}
                            {code && (
                              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                                #{code}
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatPhone(session.phone)}
                            {session.started_at ? ` · abertura ${hhmm(session.started_at)}` : ""} ·{" "}
                            {elapsed(session.started_at, session.closed_at ?? session.paid_at, now)}
                          </p>
                          {session.payment_method && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              Pagamento: {session.payment_method}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <p className="font-bold">{brl(totals.get(session.id) ?? 0)}</p>
                          <StatusBadge status={session.status} />
                        </div>
                      </button>
                      {canArchive && (
                        <button
                          onClick={() => run(() => archiveOne({ data: { sessionId: session.id } }))}
                          disabled={busy}
                          title="Tirar da lista (não apaga)"
                          aria-label="Tirar da lista"
                          className="-mr-1 shrink-0 rounded-full px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => setExpandedId(session.id)}
                      className="flex aspect-square w-full flex-col items-center justify-center gap-1 p-2 text-center"
                    >
                      <p className="w-full truncate text-xs font-semibold">
                        {shortName(session.customer_name)}
                      </p>
                      {code && (
                        <p className="font-mono text-[10px] text-muted-foreground">#{code}</p>
                      )}
                      <p className="text-xs font-bold">{brl(totals.get(session.id) ?? 0)}</p>
                      <StatusBadge status={session.status} />
                    </button>
                  )}

                  {isExpanded && (
                    <div className="border-t border-border p-4">
                      {sessionItems.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nenhum lançamento ainda.</p>
                      ) : (
                        <ul className="space-y-2">
                          {sessionItems.map((item) => (
                            <li key={item.id} className="text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <span className="truncate">
                                  {item.quantity}× {item.name}
                                </span>
                                <span className="flex shrink-0 items-center gap-3">
                                  <span className="font-semibold">
                                    {brl(Number(item.unit_price) * item.quantity)}
                                  </span>
                                  {isOpen && (
                                    <button
                                      onClick={() =>
                                        setConfirming({
                                          kind: "removeItem",
                                          sessionId: session.id,
                                          itemId: item.id,
                                        })
                                      }
                                      className="text-xs text-muted-foreground transition-colors hover:text-destructive"
                                      title="Cancelar este item"
                                    >
                                      Cancelar
                                    </button>
                                  )}
                                </span>
                              </div>
                              {confirming?.kind === "removeItem" && confirming.itemId === item.id && (
                                <div className="mt-2">
                                  <PasswordConfirm
                                    message={`Remover "${item.name}" do lançamento? Confirme com a senha da equipe.`}
                                    confirmLabel="Remover"
                                    onCancel={() => setConfirming(null)}
                                    onConfirm={async (password) => {
                                      const result = await removeItem({
                                        data: { itemId: item.id, password },
                                      });
                                      if (result.ok) {
                                        setConfirming(null);
                                        await load();
                                      }
                                      return result;
                                    }}
                                  />
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}

                      {confirming?.kind === "clear" && confirming.sessionId === session.id && (
                        <div className="mt-4">
                          <PasswordConfirm
                            message="Zerar todos os itens? O lançamento continua aberto e o estoque volta. Confirme com a senha da equipe."
                            confirmLabel="Zerar"
                            onCancel={() => setConfirming(null)}
                            onConfirm={async (password) => {
                              const result = await clearItems({
                                data: { sessionId: session.id, password },
                              });
                              if (result.ok) {
                                setConfirming(null);
                                await load();
                              }
                              return result;
                            }}
                          />
                        </div>
                      )}

                      {confirming?.kind === "cancelSession" && confirming.sessionId === session.id && (
                        <div className="mt-4">
                          <PasswordConfirm
                            message={
                              cancelStalled
                                ? "Este lançamento foi cancelado, mas sobraram itens sem voltar ao estoque. Confirme com a senha da equipe para terminar de devolver."
                                : "Cancelar este lançamento inteiro? O estoque lançado volta e ele não entra no faturamento. Confirme com a senha da equipe."
                            }
                            confirmLabel={cancelStalled ? "Concluir cancelamento" : "Cancelar lançamento"}
                            onCancel={() => setConfirming(null)}
                            onConfirm={async (password) => {
                              const result = await cancelOne({
                                data: { sessionId: session.id, password },
                              });
                              if (result.ok) {
                                setConfirming(null);
                                await load();
                              }
                              return result;
                            }}
                          />
                        </div>
                      )}

                      {confirming?.kind === "undoLast" && confirming.sessionId === session.id && (
                        <div className="mt-4">
                          <PasswordConfirm
                            message="Desfazer o último item? O estoque volta. Confirme com a senha da equipe."
                            confirmLabel="Desfazer"
                            onCancel={() => setConfirming(null)}
                            onConfirm={async (password) => {
                              const result = await undoLast({
                                data: { sessionId: session.id, password },
                              });
                              if (result.ok) {
                                setConfirming(null);
                                await load();
                              }
                              return result;
                            }}
                          />
                        </div>
                      )}

                      {(!confirming ||
                        !["clear", "cancelSession", "undoLast"].includes(confirming.kind) ||
                        confirming.sessionId !== session.id) && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Link
                            to="/caixa/$sessionId"
                            params={{ sessionId: session.id }}
                            className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground"
                          >
                            Abrir lançamento
                          </Link>
                          {isOpen && sessionItems.length > 0 && (
                            <>
                              <button
                                onClick={() =>
                                  setConfirming({ kind: "undoLast", sessionId: session.id })
                                }
                                className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                              >
                                Desfazer último
                              </button>
                              <button
                                onClick={() => setConfirming({ kind: "clear", sessionId: session.id })}
                                className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                              >
                                Zerar
                              </button>
                            </>
                          )}
                          {canCancel && (
                            <button
                              onClick={() =>
                                setConfirming({ kind: "cancelSession", sessionId: session.id })
                              }
                              className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                            >
                              {cancelStalled ? "Concluir cancelamento" : "Cancelar lançamento"}
                            </button>
                          )}
                          {isArchived && (
                            <button
                              onClick={() => run(() => unarchiveOne({ data: { sessionId: session.id } }))}
                              disabled={busy}
                              className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                            >
                              Restaurar
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

function ConfirmBar(props: {
  message: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-border bg-muted/40 p-3">
      <p className="text-xs text-foreground">{props.message}</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={props.onConfirm}
          disabled={props.busy}
          className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60"
        >
          {props.busy ? "Salvando..." : props.confirmLabel}
        </button>
        <button
          onClick={props.onCancel}
          disabled={props.busy}
          className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
