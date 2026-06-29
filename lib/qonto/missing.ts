// SERVER-ONLY. The "invoice-fetcher" worklist, in the app: given a date range,
// find every transaction MISSING its attachment (invoice/receipt) across all
// bank accounts. Mirrors the CLI driver
// (.claude/skills/invoice-fetcher/invoice-fetcher.mjs) but reuses the app's
// own Qonto client so the API key stays server-side.

import { getAccounts, getTransactions } from "@/lib/qonto/server";
import type { Transaction } from "@/lib/qonto/types";

export interface MissingTransaction {
  id: string;
  transaction_id: string;
  settled_at: string | null;
  emitted_at: string;
  side: "credit" | "debit";
  amount: number;
  currency: string;
  local_amount: number; // original-currency amount (matches the receipt)
  local_currency: string;
  counterparty: string;
  label: string;
  operation_type: string;
  attachment_required: boolean;
  attachment_lost: boolean;
}

export interface MissingAccount {
  name: string;
  iban: string;
  currency: string;
  scanned: number;
  missing_count: number;
  transactions: MissingTransaction[];
}

export interface MissingReport {
  range: { from: string; to: string };
  accounts: MissingAccount[];
  summary: { accounts: number; scanned: number; missing: number };
}

export interface MissingOptions {
  requiredOnly?: boolean;
  debitOnly?: boolean;
  account?: string; // case-insensitive substring of name or IBAN
}

// Transactions that legitimately never need a receipt — e.g. "Privatentnahme"
// (owner's draw). Matched (case-insensitive) against the text fields a user
// would write that into. Excluded from the worklist entirely.
const NO_INVOICE_NEEDED = /privatentnahme/i;

function exemptFromInvoice(t: Transaction): boolean {
  return NO_INVOICE_NEEDED.test(
    `${t.label ?? ""} ${t.reference ?? ""} ${t.note ?? ""} ${t.clean_counterparty_name ?? ""}`,
  );
}

/** Page through every transaction in [from, to] for one IBAN. */
async function allTransactions(
  iban: string,
  from: Date,
  to: Date,
): Promise<Transaction[]> {
  const out: Transaction[] = [];
  let page = 1;
  for (;;) {
    const res = await getTransactions(iban, from, to, "settled_at:desc", page, 100);
    out.push(...res.transactions);
    const next = res.meta?.next_page;
    if (!next) break;
    page = next;
  }
  return out;
}

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getMissingAttachments(
  from: Date,
  to: Date,
  opts: MissingOptions = {},
): Promise<MissingReport> {
  let accounts = await getAccounts().then((org) => org.bank_accounts);
  if (opts.account) {
    const needle = opts.account.toLowerCase();
    accounts = accounts.filter(
      (a) =>
        (a.name ?? "").toLowerCase().includes(needle) ||
        (a.iban ?? "").toLowerCase().includes(needle),
    );
  }

  const reportAccounts: MissingAccount[] = [];
  let scanned = 0;
  let missing = 0;

  for (const acc of accounts) {
    const txs = await allTransactions(acc.iban, from, to);
    let miss = txs.filter((t) => !t.attachment_ids || t.attachment_ids.length === 0);
    miss = miss.filter((t) => !exemptFromInvoice(t)); // Privatentnahme etc. need no receipt
    if (opts.requiredOnly) miss = miss.filter((t) => t.attachment_required === true);
    if (opts.debitOnly) miss = miss.filter((t) => t.side === "debit");

    scanned += txs.length;
    missing += miss.length;

    reportAccounts.push({
      name: acc.name,
      iban: acc.iban,
      currency: acc.currency,
      scanned: txs.length,
      missing_count: miss.length,
      transactions: miss.map((t) => ({
        id: t.id,
        transaction_id: t.transaction_id,
        settled_at: t.settled_at,
        emitted_at: t.emitted_at,
        side: t.side,
        amount: t.amount,
        currency: t.currency,
        local_amount: t.local_amount,
        local_currency: t.local_currency,
        counterparty: t.clean_counterparty_name || t.label,
        label: t.label,
        operation_type: t.operation_type,
        attachment_required: t.attachment_required,
        attachment_lost: t.attachment_lost,
      })),
    });
  }

  return {
    range: { from: isoDay(from), to: isoDay(to) },
    accounts: reportAccounts,
    summary: { accounts: reportAccounts.length, scanned, missing },
  };
}
