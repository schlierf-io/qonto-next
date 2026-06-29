// Build a paperless-ngx full-text query from a transaction's counterparty.
// We search by vendor only and enforce the date window in code (lib/paperless/
// match.ts), because the paperless whoosh `created:[…]` DSL does not reliably
// hard-filter when passed via `?query=`. The vendor cleaning is shared with the
// Gmail matcher (lib/vendor.ts).

import { addDays, cleanVendor } from "@/lib/vendor";

export interface PaperlessQueries {
  vendor: string;
  createdAfter: string; // YYYY-MM-DD (window start, inclusive) — for display/debug
  createdBefore: string; // YYYY-MM-DD (window end, inclusive)
  phrase: string; // "vendor"  (whoosh phrase — stricter)
  terms: string; // vendor     (whoosh terms — looser fallback)
}

export function buildPaperlessQuery(
  counterparty: string,
  day: string, // YYYY-MM-DD (the charge/settled date)
  beforeDays = 10,
  afterDays = 5,
): PaperlessQueries {
  const vendor = cleanVendor(counterparty);
  const after = day ? addDays(day, -beforeDays) : "";
  const before = day ? addDays(day, afterDays) : "";
  return {
    vendor,
    createdAfter: after,
    createdBefore: before,
    phrase: vendor ? `"${vendor}"` : "",
    terms: vendor,
  };
}
