"use client";

import * as React from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Download,
  FileDown,
  Loader2,
  Paperclip,
  UploadCloud,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ApiError, fetchTransactions, uploadAttachment } from "@/lib/api";
import { computeBalances, getSettledBalance } from "@/lib/balance";
import { formatCurrency, formatDate, formatISODate } from "@/lib/format";
import { exportReceiptPdf } from "@/lib/pdf/receipt";
import { exportStatementPdf } from "@/lib/pdf/statement";
import type { BankAccount, DateRange, Transaction } from "@/lib/qonto/types";

const PAGE_SIZE_OPTIONS = [100, 10, 25, 50];

interface Props {
  account: BankAccount | null;
  dateRange: DateRange | null;
}

function uploadId(tx: Transaction): string {
  return tx.id || tx.transaction_id;
}

export function TransactionTable({ account, dateRange }: Props) {
  const [transactions, setTransactions] = React.useState<Transaction[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(0); // 0-based
  const [perPage, setPerPage] = React.useState(PAGE_SIZE_OPTIONS[0]);
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uploadingIds, setUploadingIds] = React.useState<Set<string>>(
    new Set(),
  );

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const pendingTxRef = React.useRef<Transaction | null>(null);

  // Reset to the first page when the account or date range changes.
  React.useEffect(() => {
    setPage(0);
  }, [account, dateRange]);

  React.useEffect(() => {
    if (!account || !dateRange?.start || !dateRange?.end) {
      setTransactions([]);
      setTotal(0);
      setError(null);
      setIsLoading(false);
      return;
    }
    let active = true;
    setIsLoading(true);
    setError(null);
    fetchTransactions({
      iban: account.iban,
      from: formatISODate(dateRange.start),
      to: formatISODate(dateRange.end),
      sortBy: "settled_at:desc",
      page: page + 1, // API is 1-based
      perPage,
    })
      .then((res) => {
        if (!active) return;
        setTransactions(res.transactions);
        setTotal(res.meta?.total_count ?? res.transactions.length);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const status = err instanceof ApiError ? err.status : "?";
        let msg = `Transaktionen konnten nicht geladen werden. Status: ${status}`;
        if (status === 401 || status === 403) {
          msg += " (Authentifizierung fehlgeschlagen)";
        }
        setError(msg);
        setTransactions([]);
        setTotal(0);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [account, dateRange, page, perPage]);

  const balances = React.useMemo(
    () => computeBalances(transactions, account?.balance ?? 0),
    [transactions, account],
  );

  const pageBalances = React.useMemo(() => {
    if (!transactions.length) {
      return {
        startBalance: null as number | null,
        endBalance: null as number | null,
        balanceCurrency: null as string | null,
      };
    }
    const first = transactions[0];
    const last = transactions[transactions.length - 1];
    const end = getSettledBalance(first, balances);
    const lastBal = getSettledBalance(last, balances);
    // settled_balance is AFTER the tx -> reverse the last tx to get the opening.
    const start =
      last.side === "debit"
        ? lastBal + (last.amount ?? 0)
        : lastBal - (last.amount ?? 0);
    return { startBalance: start, endBalance: end, balanceCurrency: first.currency };
  }, [transactions, balances]);

  const markUploaded = (tx: Transaction) => {
    setTransactions((prev) =>
      prev.map((t) =>
        uploadId(t) === uploadId(tx)
          ? { ...t, has_attachment: true, attachment_ids: t.attachment_ids ?? [] }
          : t,
      ),
    );
  };

  const triggerUpload = (tx: Transaction) => {
    if (uploadingIds.has(uploadId(tx))) return;
    pendingTxRef.current = tx;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  };

  const onFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const tx = pendingTxRef.current;
    pendingTxRef.current = null;
    if (!file || !tx) return;

    const id = uploadId(tx);
    setUploadingIds((prev) => new Set(prev).add(id));
    try {
      await uploadAttachment(id, file);
      markUploaded(tx);
    } catch (err: unknown) {
      const status = err instanceof ApiError ? err.status : "?";
      let msg = "Fehler beim Hochladen des Belegs.";
      if (status === 401 || status === 403) {
        msg = "Authentifizierungsfehler beim Hochladen.";
      } else if (status === 400) {
        msg = "Ungültige Datei. Bitte eine gültige PDF-Datei wählen.";
      } else if (status === "CORS/Network Error") {
        msg = "Netzwerkfehler. Bitte Verbindung prüfen.";
      }
      setError(msg);
    } finally {
      setUploadingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const columns = React.useMemo<ColumnDef<Transaction>[]>(
    () => [
      {
        id: "logo",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.original.logo_url}
              alt=""
              className="size-6 rounded-full object-contain"
            />
          ) : null,
      },
      {
        id: "settled_at",
        header: "Datum",
        accessorFn: (tx) => (tx.settled_at ? new Date(tx.settled_at).getTime() : 0),
        cell: ({ row }) => formatDate(row.original.settled_at),
      },
      {
        id: "description",
        header: "Beschreibung",
        accessorFn: (tx) => `${tx.reference || ""} ${tx.note || ""}`,
        cell: ({ row }) => {
          const tx = row.original;
          if (!tx.label && !tx.reference && !tx.note) return "-";
          return (
            <div className="flex flex-col">
              {tx.label && <span className="font-semibold">{tx.label}</span>}
              {tx.reference && (
                <span className="text-muted-foreground">{tx.reference}</span>
              )}
              {tx.note && (
                <span className="text-muted-foreground">{tx.note}</span>
              )}
            </div>
          );
        },
      },
      {
        id: "attachment",
        header: "Beleg",
        enableSorting: false,
        cell: ({ row }) => {
          const tx = row.original;
          if (tx.has_attachment) {
            return <Paperclip className="size-4 text-muted-foreground" />;
          }
          if (uploadingIds.has(uploadId(tx))) {
            return (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            );
          }
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => triggerUpload(tx)}
                  aria-label="Beleg hochladen"
                >
                  <UploadCloud className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Beleg hochladen</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "amount",
        header: "Betrag",
        accessorFn: (tx) => tx.local_amount,
        cell: ({ row }) => {
          const tx = row.original;
          const signed = tx.side === "debit" ? -tx.amount : tx.amount;
          return (
            <div
              className={tx.side === "credit" ? "text-positive" : "text-negative"}
            >
              <div className="font-medium">
                {formatCurrency(signed, tx.currency)}
              </div>
              {tx.local_currency === "USD" && (
                <div className="text-xs opacity-80">
                  (
                  {formatCurrency(
                    tx.side === "debit" ? -tx.local_amount : tx.local_amount,
                    "USD",
                    "en-US",
                  )}
                  )
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "balance",
        header: "Kontostand",
        accessorFn: (tx) => getSettledBalance(tx, balances),
        cell: ({ row }) =>
          formatCurrency(
            getSettledBalance(row.original, balances),
            row.original.currency,
          ),
      },
      {
        id: "actions",
        header: "PDF",
        enableSorting: false,
        cell: ({ row }) => {
          const tx = row.original;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    exportReceiptPdf({
                      account,
                      transaction: tx,
                      settledBalance: getSettledBalance(tx, balances),
                    })
                  }
                  aria-label="PDF-Beleg herunterladen"
                >
                  <Download className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>PDF-Beleg herunterladen</TooltipContent>
            </Tooltip>
          );
        },
      },
    ],
    [account, balances, uploadingIds],
  );

  const table = useReactTable({
    data: transactions,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: true,
  });

  const handleExportStatement = () => {
    if (!account || !dateRange || !transactions.length) return;
    const sorted = table.getSortedRowModel().rows.map((r) => r.original);
    exportStatementPdf({
      account,
      dateRange,
      transactions: sorted,
      startBalance: pageBalances.startBalance,
      endBalance: pageBalances.endBalance,
      balanceCurrency: pageBalances.balanceCurrency,
      getBalance: (tx) => getSettledBalance(tx, balances),
    });
  };

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const hasData = transactions.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={onFileSelected}
      />

      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-wrap gap-4 text-sm">
          {pageBalances.startBalance !== null &&
            pageBalances.balanceCurrency &&
            !isLoading &&
            !error && (
              <>
                <span>
                  Startsaldo:{" "}
                  <strong>
                    {formatCurrency(
                      pageBalances.startBalance,
                      pageBalances.balanceCurrency,
                    )}
                  </strong>
                </span>
                <span>
                  Endsaldo:{" "}
                  <strong>
                    {formatCurrency(
                      pageBalances.endBalance!,
                      pageBalances.balanceCurrency,
                    )}
                  </strong>
                </span>
              </>
            )}
        </div>
        <Button
          onClick={handleExportStatement}
          disabled={!hasData || isLoading}
          className="gap-2"
        >
          <FileDown className="size-4" />
          PDF Exportieren
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  return (
                    <TableHead key={header.id}>
                      {canSort ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={(e) =>
                            header.column.getToggleSortingHandler()?.(e)
                          }
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          <ChevronsUpDown className="size-3.5 opacity-50" />
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : hasData ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {account && dateRange
                    ? "Keine Transaktionen für den ausgewählten Zeitraum gefunden."
                    : "Konto und Zeitraum wählen."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Pro Seite</span>
          <Select
            value={String(perPage)}
            onValueChange={(v) => {
              setPerPage(Number(v));
              setPage(0);
            }}
          >
            <SelectTrigger className="w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>{total} Transaktionen</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Seite {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || isLoading}
            aria-label="Vorherige Seite"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1 || isLoading}
            aria-label="Nächste Seite"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
