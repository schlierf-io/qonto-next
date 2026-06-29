// SERVER-ONLY Qonto client. Holds the API key (process.env) and talks to the
// Qonto third-party API directly — the browser never sees the credentials.
// This replaces the Angular QontoApiService + proxy.conf.json + window.__env.

import { NextResponse } from "next/server";
import type {
  Organization,
  TransactionsResponse,
} from "@/lib/qonto/types";
import { formatISODate } from "@/lib/format";

const BASE_URL = process.env.QONTO_API_BASE_URL ?? "https://thirdparty.qonto.com";
const API_PREFIX = "/v2";

function authHeaders(): Record<string, string> {
  const slug = process.env.QONTO_ORG_SLUG ?? "";
  const key = process.env.QONTO_API_KEY ?? "";
  return { Authorization: `${slug}:${key}` };
}

export class QontoApiError extends Error {
  status: number | string;
  data?: unknown;
  constructor(message: string, status: number | string, data?: unknown) {
    super(message);
    this.name = "QontoApiError";
    this.status = status;
    this.data = data;
  }
}

async function qontoFetch(path: string, init?: RequestInit): Promise<any> {
  const url = `${BASE_URL}${API_PREFIX}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new QontoApiError(
      "Netzwerkfehler bei der Verbindung zu Qonto.",
      "CORS/Network Error",
    );
  }

  if (!res.ok) {
    let data: any;
    try {
      data = await res.json();
    } catch {
      data = { message: res.statusText };
    }
    throw new QontoApiError(
      data?.message ?? `HTTP error! status: ${res.status}`,
      res.status,
      data,
    );
  }

  if (res.status === 204) return {};
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return res.json();
  const text = await res.text();
  return text ? { raw: text } : {};
}

export async function getAccounts(): Promise<Organization> {
  const data = await qontoFetch("/organization?include_external_accounts=true");
  if (!data?.organization) {
    throw new QontoApiError("Unerwartete API-Antwort: organization fehlt.", 502);
  }
  const org = data.organization as Organization;
  // cents -> main units
  org.bank_accounts.forEach((acc) => {
    acc.balance = acc.balance_cents / 100;
    acc.authorized_balance = acc.authorized_balance_cents / 100;
  });
  return org;
}

export async function getTransactions(
  iban: string,
  startDate: Date,
  endDate: Date,
  sortBy = "settled_at:desc",
  page = 1,
  perPage = 100,
): Promise<TransactionsResponse> {
  // settled_at_to is inclusive of the end day -> add one day (matches Angular).
  const settledAtTo = new Date(endDate);
  settledAtTo.setDate(settledAtTo.getDate() + 1);

  const params = new URLSearchParams({
    iban,
    settled_at_from: formatISODate(startDate),
    settled_at_to: formatISODate(settledAtTo),
    sort_by: sortBy,
    current_page: String(page),
    per_page: String(perPage),
  });

  const data = (await qontoFetch(`/transactions?${params.toString()}`)) as TransactionsResponse;
  if (!data.transactions) data.transactions = [];

  data.transactions.forEach((tx) => {
    tx.amount = tx.amount_cents / 100;
    tx.local_amount = tx.local_amount_cents / 100;
    // keep NaN to signal "missing" — balance.ts falls back to calculation.
    tx.settled_balance =
      tx.settled_balance_cents !== null && tx.settled_balance_cents !== undefined
        ? tx.settled_balance_cents / 100
        : NaN;
    tx.vat_amount = tx.vat_amount_cents !== null ? tx.vat_amount_cents / 100 : null;
    if (tx.operation_type === "card") tx.reference = "Kreditkartenzahlung";
    tx.has_attachment = !!tx.attachment_ids && tx.attachment_ids.length > 0;
  });

  return data;
}

export async function uploadAttachment(
  transactionId: string,
  file: File,
): Promise<void> {
  const safeName = file.name.toLowerCase().endsWith(".pdf")
    ? file.name
    : `${file.name}.pdf`;

  const form = new FormData();
  form.append("file", file, safeName);

  await qontoFetch(`/transactions/${transactionId}/attachments`, {
    method: "POST",
    headers: { "X-Qonto-Idempotency-Key": crypto.randomUUID() },
    body: form,
  });
}

/** Maps a thrown error to a JSON response for the route handlers. */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof QontoApiError) {
    const httpStatus = typeof error.status === "number" ? error.status : 502;
    return NextResponse.json(
      { message: error.message, status: error.status },
      { status: httpStatus },
    );
  }
  return NextResponse.json(
    { message: "Interner Serverfehler.", status: 500 },
    { status: 500 },
  );
}
