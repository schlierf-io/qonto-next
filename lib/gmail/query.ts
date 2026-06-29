// Build a Gmail search query from a transaction's counterparty + date.
// TypeScript port of the same logic in the invoice-fetcher CLI driver
// (.claude/skills/invoice-fetcher/invoice-fetcher.mjs) — keep the two in sync.
// The vendor-cleaning + date math lives in lib/vendor.ts (shared with paperless).

import { addDays, cleanVendor } from "@/lib/vendor";

export { cleanVendor };

// Some vendors' bank counterparty bears no resemblance to the sender of their
// invoice email (a "Claude.ai" card charge is receipted by "Anthropic"), and
// their receipts are link-only (no PDF attachment). For those we route the
// Gmail search by sender domain + the real brand instead of the cleaned label.
export interface VendorRoute {
  vendor: string; // brand as it appears in the receipt subject
  senders: string[]; // from: domains that issue the receipt
  linkOnly?: boolean; // receipt has no PDF attachment -> don't require has:attachment
  // require an in-body amount match to accept (the receipt prints the total in
  // the email AND the vendor bills often). Off when the amount lives only in an
  // attached PDF (e.g. Google), where requiring it would reject real invoices.
  requireAmount?: boolean;
}

const VENDOR_ROUTES: { test: RegExp; route: VendorRoute }[] = [
  {
    // "Claude.ai", "ANTHROPIC", "Claude (Anthropic)" → receipts from
    // invoice+statements@mail.anthropic.com (PBC/USD) and
    // invoice+statements+...@stripe.com (Anthropic Ireland/EUR), link-only,
    // amount printed in the body (bills often -> amount disambiguates).
    test: /\b(anthropic|claude)\b/i,
    route: { vendor: "Anthropic", senders: ["anthropic.com", "stripe.com"], linkOnly: true, requireAmount: true },
  },
  {
    // "Google Workspace/Cloud/One/Wallet" → invoices from payments-noreply@google.com
    // ("… Ihre Rechnung …", PDF attached). The amount is in the PDF, not the body,
    // so don't require an in-body amount match. NB: consumer Google One/Play
    // receipts may be sent to a different mailbox and won't be found here.
    test: /\bgoogle\b/i,
    route: { vendor: "Google", senders: ["google.com"], linkOnly: true },
  },
];

export function resolveVendorRoute(counterparty: string): VendorRoute | null {
  for (const { test, route } of VENDOR_ROUTES) if (test.test(counterparty)) return route;
  return null;
}

export interface GmailQueries {
  vendor: string;
  route: VendorRoute | null;
  amountEn: string;
  amountDe: string;
  dateFrom: string; // Gmail YYYY/MM/DD
  dateTo: string; // Gmail YYYY/MM/DD (exclusive)
  tight: string; // (sender +) vendor [+ has:attachment] + window
  loose: string; // (sender +) vendor + window
}

export function buildGmailQueries(
  counterparty: string,
  day: string, // YYYY-MM-DD (the charge/settled date)
  amount?: number,
  beforeDays = 10,
  afterDays = 5,
): GmailQueries {
  const route = resolveVendorRoute(counterparty);
  const vendor = route ? route.vendor : cleanVendor(counterparty);
  const after = day ? addDays(day, -beforeDays).replace(/-/g, "/") : "";
  const before = day ? addDays(day, afterDays + 1).replace(/-/g, "/") : ""; // before: is exclusive
  const win = after && before ? ` after:${after} before:${before}` : "";
  const v = vendor ? `"${vendor}"` : "";
  const senderQ = route?.senders.length ? `from:(${route.senders.join(" OR ")}) ` : "";
  // link-only vendors (e.g. Anthropic) have no PDF attached, so don't require it
  const attach = route?.linkOnly ? "" : " has:attachment";
  const amountEn = typeof amount === "number" ? amount.toFixed(2) : "";
  return {
    vendor,
    route,
    amountEn,
    amountDe: amountEn.replace(".", ","),
    dateFrom: after,
    dateTo: before,
    tight: `${senderQ}${v}${attach}${win}`.trim(),
    loose: `${senderQ}${v}${win}`.trim(),
  };
}
