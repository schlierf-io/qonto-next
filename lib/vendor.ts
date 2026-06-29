// Shared vendor-name cleaning + date math, used by every "source" matcher
// (Gmail in lib/gmail/*, paperless-ngx in lib/paperless/*). Strip legal forms,
// payment-processor wrappers and geo/branch noise so a bank counterparty string
// collapses to a searchable brand.
//
// Keep this in sync with the standalone copy in the invoice-fetcher CLI driver
// (.claude/skills/invoice-fetcher/invoice-fetcher.mjs) — that file is zero-dep
// and cannot import TS, so the logic is intentionally duplicated there.

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

/** Shift a YYYY-MM-DD date by n days, returning YYYY-MM-DD. */
export function addDays(yyyyMmDd: string, n: number): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
