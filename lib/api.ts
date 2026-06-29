// Client-side fetchers that call our own Next.js Route Handlers.
// (The handlers talk to Qonto server-side; the key never reaches the browser.)

import type { BankAccount, TransactionsResponse } from "@/lib/qonto/types";

export class ApiError extends Error {
  status: number | string;
  constructor(message: string, status: number | string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return new ApiError(
    body?.message ?? `HTTP error! status: ${res.status}`,
    body?.status ?? res.status,
  );
}

export async function fetchAccounts(): Promise<BankAccount[]> {
  const res = await fetch("/api/qonto/accounts");
  if (!res.ok) throw await readError(res);
  const org = await res.json();
  return org.bank_accounts ?? [];
}

export interface FetchTransactionsParams {
  iban: string;
  from: string; // yyyy-MM-dd
  to: string; // yyyy-MM-dd
  sortBy?: string;
  page?: number;
  perPage?: number;
}

export async function fetchTransactions(
  p: FetchTransactionsParams,
): Promise<TransactionsResponse> {
  const params = new URLSearchParams({
    iban: p.iban,
    from: p.from,
    to: p.to,
    sort_by: p.sortBy ?? "settled_at:desc",
    page: String(p.page ?? 1),
    per_page: String(p.perPage ?? 100),
  });
  const res = await fetch(`/api/qonto/transactions?${params.toString()}`);
  if (!res.ok) throw await readError(res);
  return res.json();
}

export interface MissingTransaction {
  id: string;
  transaction_id: string;
  settled_at: string | null;
  emitted_at: string;
  side: "credit" | "debit";
  amount: number;
  currency: string;
  local_amount: number;
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

export interface FetchMissingParams {
  from: string; // yyyy-MM-dd
  to: string; // yyyy-MM-dd
  requiredOnly?: boolean;
  debitOnly?: boolean;
  account?: string;
}

export async function fetchMissingAttachments(
  p: FetchMissingParams,
): Promise<MissingReport> {
  const params = new URLSearchParams({ from: p.from, to: p.to });
  if (p.requiredOnly) params.set("required_only", "1");
  if (p.debitOnly) params.set("debit_only", "1");
  if (p.account) params.set("account", p.account);
  const res = await fetch(`/api/qonto/missing-attachments?${params.toString()}`);
  if (!res.ok) throw await readError(res);
  return res.json();
}

export interface GmailMatch {
  found: boolean;
  confidence: "high" | "medium" | "low" | "none";
  vendor: string;
  query: string;
  message_id?: string;
  thread_id?: string;
  sender?: string;
  subject?: string;
  date?: string;
  attachment_filename?: string | null;
  amount_matched?: boolean;
  matched_amount?: number | null;
  permalink?: string;
  reason: string;
}

export async function fetchGmailMatch(p: {
  counterparty: string;
  date: string; // yyyy-MM-dd
  amount?: number;
  currency?: string;
  localAmount?: number;
  localCurrency?: string;
}): Promise<GmailMatch> {
  const params = new URLSearchParams({ counterparty: p.counterparty, date: p.date });
  if (typeof p.amount === "number") params.set("amount", String(p.amount));
  if (p.currency) params.set("currency", p.currency);
  if (typeof p.localAmount === "number") params.set("local_amount", String(p.localAmount));
  if (p.localCurrency) params.set("local_currency", p.localCurrency);
  const res = await fetch(`/api/gmail/match?${params.toString()}`);
  if (!res.ok) throw await readError(res);
  return res.json();
}

export interface ForwardResult {
  sent: boolean;
  id?: string;
  from: string;
  to: string;
  subject: string;
  attachments: number;
  bytes: number;
}

export async function forwardToQonto(
  messageId: string,
  dry = false,
): Promise<ForwardResult> {
  const res = await fetch(`/api/gmail/forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId, dry }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export interface PaperlessMatch {
  found: boolean;
  confidence: "high" | "medium" | "low" | "none";
  vendor: string;
  query: string;
  document_id?: number;
  title?: string;
  correspondent?: string | null;
  created?: string; // yyyy-MM-dd (the document's own date)
  original_file_name?: string | null;
  permalink?: string;
  reason: string;
}

export async function fetchPaperlessMatch(p: {
  counterparty: string;
  date: string; // yyyy-MM-dd
  amount?: number;
}): Promise<PaperlessMatch> {
  const params = new URLSearchParams({ counterparty: p.counterparty, date: p.date });
  if (typeof p.amount === "number") params.set("amount", String(p.amount));
  const res = await fetch(`/api/paperless/match?${params.toString()}`);
  if (!res.ok) throw await readError(res);
  return res.json();
}

export interface PaperlessAttachResult {
  attached: boolean;
  transactionId: string;
  documentId: number;
  filename: string;
  bytes: number;
}

// Download the matched paperless document and attach it to the Qonto transaction.
export async function attachFromPaperless(
  documentId: number,
  transactionId: string,
): Promise<PaperlessAttachResult> {
  const res = await fetch(`/api/paperless/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, transactionId }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function uploadAttachment(
  transactionId: string,
  file: File,
): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(
    `/api/qonto/transactions/${transactionId}/attachments`,
    { method: "POST", body: form },
  );
  if (!res.ok) throw await readError(res);
}
