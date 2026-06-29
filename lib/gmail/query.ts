// Build a Gmail search query from a transaction's counterparty + date.
// TypeScript port of the same logic in the invoice-fetcher CLI driver
// (.claude/skills/invoice-fetcher/invoice-fetcher.mjs) — keep the two in sync.

// Strip legal forms, payment-processor wrappers and geo/branch noise so the
// counterparty collapses to a searchable brand.
const LEGAL =
  /\b(gmbh|mbh|ag|se|kg|kgaa|ohg|ug|e\.?\s?k\.?|inc|incorporated|llc|l\.?l\.?c\.?|ltd|limited|plc|pbc|co|corp|corporation|company|s\.?a\.?r\.?l\.?|s\.?c\.?a\.?|s\.?a\.?|b\.?v\.?|n\.?v\.?|oy|ab|as|sas|sl|srl|spa|et\s+cie)\b\.?/gi;
const GEO =
  /\b(europe|ireland|deutschland|germany|niederlassung|international|holding|group|payments?|services?|technologies|digital|media|eu|us|uk|usa)\b/gi;

export function cleanVendor(counterparty: string): string {
  if (!counterparty) return "";
  let s = String(counterparty);
  s = s.replace(/^\s*paypal\s*\*+\s*/i, "");
  s = s.replace(/^\s*\*+\s*/, "");
  s = s.split("*")[0];
  s = s.split(",")[0];
  s = s.replace(LEGAL, " ").replace(GEO, " ");
  s = s.replace(/\b([a-z]\.?){1,3}[a-z]?\.\B|\b([a-z]\.){1,3}[a-z]?\.?\b/gi, " ");
  s = s.replace(/[^\p{L}\p{N}\s&-]/gu, " ").replace(/\s+/g, " ").trim();
  const words = s.split(" ").filter((w) => w.length > 1);
  return (words.slice(0, 3).join(" ") || String(counterparty)).trim();
}

/** Shift a YYYY-MM-DD date by n days. */
function addDays(yyyyMmDd: string, n: number): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export interface GmailQueries {
  vendor: string;
  amountEn: string;
  amountDe: string;
  dateFrom: string; // Gmail YYYY/MM/DD
  dateTo: string; // Gmail YYYY/MM/DD (exclusive)
  tight: string; // vendor + has:attachment + window
  loose: string; // vendor + window
}

export function buildGmailQueries(
  counterparty: string,
  day: string, // YYYY-MM-DD (the charge/settled date)
  amount?: number,
  beforeDays = 10,
  afterDays = 5,
): GmailQueries {
  const vendor = cleanVendor(counterparty);
  const after = day ? addDays(day, -beforeDays).replace(/-/g, "/") : "";
  const before = day ? addDays(day, afterDays + 1).replace(/-/g, "/") : ""; // before: is exclusive
  const win = after && before ? ` after:${after} before:${before}` : "";
  const v = vendor ? `"${vendor}"` : "";
  const amountEn = typeof amount === "number" ? amount.toFixed(2) : "";
  return {
    vendor,
    amountEn,
    amountDe: amountEn.replace(".", ","),
    dateFrom: after,
    dateTo: before,
    tight: `${v} has:attachment${win}`.trim(),
    loose: `${v}${win}`.trim(),
  };
}
