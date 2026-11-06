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
