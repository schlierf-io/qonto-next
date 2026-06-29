// Ported 1:1 from the Angular app's src/app/models/qonto.model.ts

export interface BankAccount {
  slug: string;
  iban: string;
  bic: string;
  currency: string;
  balance_cents: number;
  balance: number; // Derived from balance_cents for easier use
  authorized_balance_cents: number;
  authorized_balance: number; // Derived
  name: string;
}

export interface Organization {
  slug: string;
  bank_accounts: BankAccount[];
}

export interface Transaction {
  id: string;
  transaction_id: string;
  amount_cents: number;
  amount: number; // Derived
  attachment_ids: string[];
  local_amount_cents: number;
  local_amount: number; // Derived
  side: "credit" | "debit";
  operation_type: string;
  currency: string;
  local_currency: string;
  label: string; // User-friendly label
  settled_at: string | null; // ISO 8601 Date String
  emitted_at: string; // ISO 8601 Date String
  updated_at: string; // ISO 8601 Date String
  status: string;
  note: string | null;
  reference: string | null;
  vat_amount_cents: number | null;
  vat_amount: number | null; // Derived
  vat_rate: number | null;
  initiator_id: string | null;
  label_ids: string[];
  attachment_lost: boolean;
  attachment_required: boolean;
  has_attachment?: boolean;
  clean_counterparty_name: string | null;
  logo_url?: string | null;
  settled_balance_cents: number;
  settled_balance: number; // Derived (NaN when missing from API)
}

export interface TransactionsResponse {
  transactions: Transaction[];
  meta: {
    current_page: number;
    next_page: number | null;
    prev_page: number | null;
    total_pages: number;
    total_count: number;
    per_page: number;
  };
}

export interface DateRange {
  start: Date | null;
  end: Date | null;
}
