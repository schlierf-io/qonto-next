"use client";

import * as React from "react";
import {
  Check,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  Paperclip,
  ReceiptText,
  RefreshCw,
  Search,
  SendHorizontal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ApiError,
  attachFromPaperless,
  fetchGmailMatch,
  fetchMissingAttachments,
  fetchPaperlessMatch,
  forwardToQonto,
  type GmailMatch,
  type MissingReport,
  type MissingTransaction,
  type PaperlessMatch,
} from "@/lib/api";
import { formatCurrency, formatDate, formatISODate } from "@/lib/format";
import type { DateRange } from "@/lib/qonto/types";

interface Props {
  dateRange: DateRange | null;
}

// The invoice-fetcher worklist, in the app: every transaction missing its
// invoice/receipt across ALL accounts for the selected date range.
export function MissingAttachments({ dateRange }: Props) {
  const [report, setReport] = React.useState<MissingReport | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [requiredOnly, setRequiredOnly] = React.useState(true);
  // per-transaction Gmail match state, keyed by transaction id
  const [matches, setMatches] = React.useState<
    Record<string, { loading?: boolean; data?: GmailMatch; error?: string }>
  >({});
  // per-transaction paperless-ngx match state, keyed by transaction id
  const [paperless, setPaperless] = React.useState<
    Record<string, { loading?: boolean; data?: PaperlessMatch; error?: string }>
  >({});

  const runMatch = React.useCallback(
    (t: MissingTransaction) => {
      const id = t.id;
      setMatches((m) => ({ ...m, [id]: { loading: true } }));
      fetchGmailMatch({
        counterparty: t.counterparty || t.label,
        date: (t.settled_at ?? t.emitted_at ?? "").slice(0, 10),
        amount: Math.abs(t.amount),
        currency: t.currency,
        localAmount: Math.abs(t.local_amount),
        localCurrency: t.local_currency,
      })
        .then((data) => setMatches((m) => ({ ...m, [id]: { data } })))
        .catch((err: unknown) => {
          const status = err instanceof ApiError ? err.status : "?";
          const msg =
            status === 503
              ? "Gmail nicht verbunden."
              : `Suche fehlgeschlagen (Status ${status}).`;
          setMatches((m) => ({ ...m, [id]: { error: msg } }));
        });
    },
    [],
  );

  const runPaperlessMatch = React.useCallback(
    (id: string, counterparty: string, date: string, amount: number) => {
      setPaperless((m) => ({ ...m, [id]: { loading: true } }));
      fetchPaperlessMatch({ counterparty, date, amount: Math.abs(amount) })
        .then((data) => setPaperless((m) => ({ ...m, [id]: { data } })))
        .catch((err: unknown) => {
          const status = err instanceof ApiError ? err.status : "?";
          const msg =
            status === 503
              ? "Paperless nicht verbunden."
              : `Suche fehlgeschlagen (Status ${status}).`;
          setPaperless((m) => ({ ...m, [id]: { error: msg } }));
        });
    },
    [],
  );

  const from = dateRange?.start ? formatISODate(dateRange.start) : null;
  const to = dateRange?.end ? formatISODate(dateRange.end) : null;

  const load = React.useCallback(() => {
    if (!from || !to) {
      setReport(null);
      return;
    }
    let active = true;
    setIsLoading(true);
    setError(null);
    fetchMissingAttachments({ from, to, requiredOnly })
      .then((r) => active && setReport(r))
      .catch((err: unknown) => {
        if (!active) return;
        const status = err instanceof ApiError ? err.status : "?";
        setError(`Fehlende Belege konnten nicht geladen werden. Status: ${status}`);
        setReport(null);
      })
      .finally(() => active && setIsLoading(false));
    return () => {
      active = false;
    };
  }, [from, to, requiredOnly]);

  React.useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  if (!from || !to) return null;

  const accountsWithMissing =
    report?.accounts.filter((a) => a.transactions.length > 0) ?? [];
  const total = report?.summary.missing ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-5 text-muted-foreground" />
            <CardTitle>Fehlende Belege</CardTitle>
            {report && !isLoading && (
              <span
                className={
                  "rounded-full px-2 py-0.5 text-xs font-medium " +
                  (total > 0
                    ? "bg-destructive/10 text-destructive"
                    : "bg-positive/10 text-positive")
                }
              >
                {total}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={requiredOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setRequiredOnly((v) => !v)}
            >
              {requiredOnly ? "Nur erforderliche" : "Alle ohne Beleg"}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={load}
              disabled={isLoading}
              aria-label="Aktualisieren"
            >
              <RefreshCw className={"size-4" + (isLoading ? " animate-spin" : "")} />
            </Button>
          </div>
        </div>
        <CardDescription>
          Transaktionen ohne Rechnung/Beleg im Zeitraum {report?.range.from ?? from} bis{" "}
          {report?.range.to ?? to}, über alle Konten.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}

        {isLoading && !report ? (
          <div className="flex h-20 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Keine fehlenden Belege im ausgewählten Zeitraum. 🎉
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {accountsWithMissing.map((acc) => (
              <div key={acc.iban} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">{acc.name}</h3>
                  <span className="text-xs text-muted-foreground">
                    {acc.missing_count} von {acc.scanned} ohne Beleg
                  </span>
                </div>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Datum</TableHead>
                        <TableHead>Empfänger</TableHead>
                        <TableHead className="text-right">Betrag</TableHead>
                        <TableHead>Pflicht</TableHead>
                        <TableHead>Beleg (Gmail)</TableHead>
                        <TableHead>Beleg (Paperless)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {acc.transactions.map((t) => {
                        const signed = t.side === "debit" ? -t.amount : t.amount;
                        return (
                          <TableRow key={t.id}>
                            <TableCell className="whitespace-nowrap">
                              {formatDate(t.settled_at ?? t.emitted_at)}
                            </TableCell>
                            <TableCell className="font-medium">
                              {t.counterparty || t.label || "-"}
                            </TableCell>
                            <TableCell
                              className={
                                "text-right " +
                                (t.side === "credit"
                                  ? "text-positive"
                                  : "text-negative")
                              }
                            >
                              {formatCurrency(signed, t.currency)}
                            </TableCell>
                            <TableCell>
                              {t.attachment_required ? (
                                <span className="text-xs text-destructive">
                                  erforderlich
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  optional
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <GmailCell
                                state={matches[t.id]}
                                onSearch={() => runMatch(t)}
                              />
                            </TableCell>
                            <TableCell>
                              <PaperlessCell
                                state={paperless[t.id]}
                                transactionId={t.id}
                                onSearch={() =>
                                  runPaperlessMatch(
                                    t.id,
                                    t.counterparty || t.label,
                                    (t.settled_at ?? t.emitted_at ?? "").slice(0, 10),
                                    t.amount,
                                  )
                                }
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const CONFIDENCE_STYLE: Record<GmailMatch["confidence"], string> = {
  high: "bg-positive/10 text-positive",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  low: "bg-muted text-muted-foreground",
  none: "bg-muted text-muted-foreground",
};

function GmailCell({
  state,
  onSearch,
}: {
  state?: { loading?: boolean; data?: GmailMatch; error?: string };
  onSearch: () => void;
}) {
  if (state?.loading) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  if (state?.error) {
    return (
      <button
        type="button"
        onClick={onSearch}
        className="text-xs text-destructive hover:underline"
      >
        {state.error} — erneut
      </button>
    );
  }

  const match = state?.data;
  if (!match) {
    return (
      <Button variant="outline" size="sm" className="gap-1.5" onClick={onSearch}>
        <Search className="size-3.5" />
        In Gmail suchen
      </Button>
    );
  }

  if (!match.found) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">Kein Treffer</span>
        <button
          type="button"
          onClick={onSearch}
          className="text-left text-xs text-muted-foreground/80 hover:underline"
          title={match.reason}
        >
          erneut suchen
        </button>
      </div>
    );
  }

  const senderShort = (match.sender ?? "").replace(/.*<([^>]+)>.*/, "$1");
  return (
    <div className="flex max-w-[22rem] flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          className={
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase " +
            CONFIDENCE_STYLE[match.confidence]
          }
        >
          {match.confidence}
        </span>
        <a
          href={match.permalink}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          öffnen <ExternalLink className="size-3" />
        </a>
        {match.amount_matched === true && (
          <span
            className="inline-flex items-center gap-0.5 rounded-full bg-positive/10 px-1.5 py-0.5 text-[10px] font-medium text-positive"
            title={
              match.matched_amount != null
                ? `Rechnungsbetrag ${match.matched_amount.toFixed(2)} stimmt mit der Buchung überein`
                : "Betrag stimmt überein"
            }
          >
            <Check className="size-2.5" /> Betrag
          </span>
        )}
      </div>
      <span className="truncate text-xs font-medium" title={match.subject}>
        {match.subject || "(ohne Betreff)"}
      </span>
      <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
        <Mail className="size-3 shrink-0" />
        {senderShort}
      </span>
      {match.attachment_filename && (
        <span className="truncate text-xs text-muted-foreground">
          📎 {match.attachment_filename}
        </span>
      )}
      {match.message_id && <ForwardButton messageId={match.message_id} />}
    </div>
  );
}

function ForwardButton({ messageId }: { messageId: string }) {
  const [state, setState] = React.useState<{
    loading?: boolean;
    done?: boolean;
    error?: string;
  }>({});

  if (state.done) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-positive">
        <Check className="size-3.5" /> an Qonto gesendet
      </span>
    );
  }

  const forward = () => {
    setState({ loading: true });
    forwardToQonto(messageId)
      .then(() => setState({ done: true }))
      .catch((err: unknown) => {
        const status = err instanceof ApiError ? err.status : "?";
        const msg =
          status === 403
            ? "Send-Scope fehlt — gmail-auth erneut ausführen"
            : status === 400
              ? "Qonto-Inbox nicht konfiguriert"
              : `Weiterleiten fehlgeschlagen (${status})`;
        setState({ error: msg });
      });
  };

  return (
    <div className="mt-0.5 flex flex-col gap-0.5">
      <Button
        variant="secondary"
        size="sm"
        className="h-7 gap-1.5 self-start"
        onClick={forward}
        disabled={state.loading}
      >
        {state.loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <SendHorizontal className="size-3.5" />
        )}
        An Qonto weiterleiten
      </Button>
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
    </div>
  );
}

function PaperlessCell({
  state,
  transactionId,
  onSearch,
}: {
  state?: { loading?: boolean; data?: PaperlessMatch; error?: string };
  transactionId: string;
  onSearch: () => void;
}) {
  if (state?.loading) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  if (state?.error) {
    return (
      <button
        type="button"
        onClick={onSearch}
        className="text-xs text-destructive hover:underline"
      >
        {state.error} — erneut
      </button>
    );
  }

  const match = state?.data;
  if (!match) {
    return (
      <Button variant="outline" size="sm" className="gap-1.5" onClick={onSearch}>
        <Search className="size-3.5" />
        In Paperless suchen
      </Button>
    );
  }

  if (!match.found) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">Kein Treffer</span>
        <button
          type="button"
          onClick={onSearch}
          className="text-left text-xs text-muted-foreground/80 hover:underline"
          title={match.reason}
        >
          erneut suchen
        </button>
      </div>
    );
  }

  return (
    <div className="flex max-w-[22rem] flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          className={
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase " +
            CONFIDENCE_STYLE[match.confidence]
          }
        >
          {match.confidence}
        </span>
        {match.permalink && (
          <a
            href={match.permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            öffnen <ExternalLink className="size-3" />
          </a>
        )}
        {match.created && (
          <span className="text-xs text-muted-foreground">{match.created}</span>
        )}
      </div>
      <span className="truncate text-xs font-medium" title={match.title}>
        {match.title || "(ohne Titel)"}
      </span>
      {match.correspondent && (
        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          <FileText className="size-3 shrink-0" />
          {match.correspondent}
        </span>
      )}
      {match.original_file_name && (
        <span className="truncate text-xs text-muted-foreground">
          📎 {match.original_file_name}
        </span>
      )}
      {match.document_id != null && (
        <AttachButton documentId={match.document_id} transactionId={transactionId} />
      )}
    </div>
  );
}

function AttachButton({
  documentId,
  transactionId,
}: {
  documentId: number;
  transactionId: string;
}) {
  const [state, setState] = React.useState<{
    loading?: boolean;
    done?: boolean;
    error?: string;
  }>({});

  if (state.done) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-positive">
        <Check className="size-3.5" /> an Qonto angehängt
      </span>
    );
  }

  const attach = () => {
    setState({ loading: true });
    attachFromPaperless(documentId, transactionId)
      .then(() => setState({ done: true }))
      .catch((err: unknown) => {
        const status = err instanceof ApiError ? err.status : "?";
        const msg =
          status === 503
            ? "Paperless nicht verbunden"
            : status === 404
              ? "Dokument/Transaktion nicht gefunden"
              : `Anhängen fehlgeschlagen (${status})`;
        setState({ error: msg });
      });
  };

  return (
    <div className="mt-0.5 flex flex-col gap-0.5">
      <Button
        variant="secondary"
        size="sm"
        className="h-7 gap-1.5 self-start"
        onClick={attach}
        disabled={state.loading}
      >
        {state.loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Paperclip className="size-3.5" />
        )}
        An Qonto anhängen
      </Button>
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
    </div>
  );
}
