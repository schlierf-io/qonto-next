#!/usr/bin/env node
// invoice-fetcher — lists every Qonto transaction that is MISSING its
// attachment (invoice / receipt) within a date range, so the missing
// invoices can be chased up and uploaded.
//
// Pure Node (>=18), zero dependencies. Talks to the same Qonto third-party
// API the Next.js app uses (lib/qonto/server.ts), reusing the credentials
// from .env / .env.local. The key never leaves the machine.
//
// Usage:
//   node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29
//   node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-06-01 --to 2026-06-29 --account Geschaeft
//   node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29 --required-only --json
//
// Flags:
//   --from <YYYY-MM-DD>   start of range (inclusive)            [required]
//   --to   <YYYY-MM-DD>   end of range   (inclusive)            [required]
//   --account <substr>    only accounts whose name/IBAN contains substr (case-insensitive)
//   --required-only       only transactions where attachment_required === true
//   --debit-only          only outgoing (side === "debit") transactions
//   --json                emit JSON instead of the human table
//   --out <file>          also write the JSON result to <file>
//   --base <url>          override API base (default env QONTO_API_BASE_URL or prod)
//   --help                show this help

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The app root is three levels up from .claude/skills/invoice-fetcher/.
const APP_ROOT = resolve(__dirname, "..", "..", "..");

// ---- tiny .env loader (.env then .env.local override, then real env) -------
function loadEnv() {
  const env = {};
  for (const name of [".env", ".env.local"]) {
    const p = resolve(APP_ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
  // real process.env wins (lets CI / shell override the files)
  for (const k of ["QONTO_API_KEY", "QONTO_ORG_SLUG", "QONTO_API_BASE_URL"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--required-only") out.requiredOnly = true;
    else if (a === "--debit-only") out.debitOnly = true;
    else if (a === "--json") out.json = true;
    else if (a === "--gmail") out.gmail = true;
    else if (a === "--gmail-before") out.gmailBefore = Number(argv[++i]);
    else if (a === "--gmail-after") out.gmailAfter = Number(argv[++i]);
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--account") out.account = argv[++i];
    else if (a === "--out") out.outFile = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else out._.push(a);
  }
  return out;
}

const HELP = `invoice-fetcher — Qonto transactions missing their invoice/receipt attachment

  --from <YYYY-MM-DD>   start of range (inclusive)   [required]
  --to   <YYYY-MM-DD>   end of range   (inclusive)   [required]
  --account <substr>    filter accounts by name/IBAN substring (case-insensitive)
  --required-only       only where attachment_required === true
  --debit-only          only outgoing (debit) transactions
  --gmail               add a Gmail search query + match signals to each row
                        (feed these to the Gmail MCP search_threads step)
  --gmail-before <n>    days before the charge to search Gmail (default 10)
  --gmail-after <n>     days after the charge to search Gmail (default 5)
  --json                emit JSON instead of a table
  --out <file>          also write JSON result to <file>
  --base <url>          override API base URL
  --help                this help`;

function die(msg) {
  console.error("error: " + msg);
  process.exit(1);
}

function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// inclusive end -> Qonto's settled_at_to is exclusive of the boundary day,
// so add one day (matches lib/qonto/server.ts getTransactions()).
function plusOneDay(yyyyMmDd) {
  return addDays(yyyyMmDd, 1);
}

// shift a YYYY-MM-DD date by n days, return YYYY-MM-DD
function addDays(yyyyMmDd, n) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// ---- Gmail query building (for --gmail; consumed by the Gmail MCP step) -----
// Strip legal forms, payment-processor wrappers and geo/branch noise so the
// counterparty collapses to a searchable brand. Heuristic on purpose — the
// matching agent verifies; over-narrowing is worse than a loose query.
const LEGAL = /\b(gmbh|mbh|ag|se|kg|kgaa|ohg|ug|e\.?\s?k\.?|inc|incorporated|llc|l\.?l\.?c\.?|ltd|limited|plc|pbc|co|corp|corporation|company|s\.?a\.?r\.?l\.?|s\.?c\.?a\.?|s\.?a\.?|b\.?v\.?|n\.?v\.?|oy|ab|as|sas|sl|srl|spa|et\s+cie)\b\.?/gi;
const GEO = /\b(europe|ireland|deutschland|germany|niederlassung|international|holding|group|payments?|services?|technologies|digital|media|eu|us|uk|usa)\b/gi;

function cleanVendor(counterparty) {
  if (!counterparty) return "";
  let s = String(counterparty);
  // payment-processor wrappers: "PAYPAL *foo", "PAYPAL ** foo,", leading "*"
  s = s.replace(/^\s*paypal\s*\*+\s*/i, "");
  s = s.replace(/^\s*\*+\s*/, "");
  // card-descriptor tails like "OPENAI *CHATGPT SUBSCR" -> keep head before "*"
  s = s.split("*")[0];
  // drop everything after a comma (branch/addr noise)
  s = s.split(",")[0];
  s = s.replace(LEGAL, " ").replace(GEO, " ");
  // kill leftover dotted abbreviations: "r.l.", "s.a", "s.c.a." (incl. spaced "S.A R.L")
  s = s.replace(/\b([a-z]\.?){1,3}[a-z]?\.\B|\b([a-z]\.){1,3}[a-z]?\.?\b/gi, " ");
  s = s.replace(/[^\p{L}\p{N}\s&-]/gu, " ").replace(/\s+/g, " ").trim();
  // keep the first 3 significant words, drop 1-char and bare-abbrev leftovers
  const words = s.split(" ").filter((w) => w.length > 1);
  return (words.slice(0, 3).join(" ") || String(counterparty)).trim();
}

function buildGmailQueries(tx, beforeDays, afterDays) {
  const day = (tx.settled_at || tx.emitted_at || "").slice(0, 10);
  const vendor = cleanVendor(tx.counterparty || tx.label);
  const after = day ? addDays(day, -beforeDays).replace(/-/g, "/") : "";
  const before = day ? addDays(day, afterDays + 1).replace(/-/g, "/") : ""; // before: is exclusive
  const win = after && before ? ` after:${after} before:${before}` : "";
  const v = vendor ? `"${vendor}"` : "";
  return {
    vendor,
    amount_en: tx.amount?.toFixed ? tx.amount.toFixed(2) : String(tx.amount),
    amount_de: (tx.amount?.toFixed ? tx.amount.toFixed(2) : String(tx.amount)).replace(".", ","),
    date_from: after,
    date_to: before,
    // try tight first (vendor + an attachment in window), then loosen
    tight: `${v} has:attachment${win}`.trim(),
    loose: `${v}${win}`.trim(),
    keywords: `${v} (Rechnung OR invoice OR receipt OR Beleg OR Quittung)${win}`.trim(),
  };
}

// ---- Qonto client ----------------------------------------------------------
function makeClient(env, baseOverride) {
  const base = baseOverride || env.QONTO_API_BASE_URL || "https://thirdparty.qonto.com";
  const auth = `${env.QONTO_ORG_SLUG ?? ""}:${env.QONTO_API_KEY ?? ""}`;
  async function get(path, params) {
    const url = new URL(`${base}/v2${path}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: auth }, cache: "no-store" });
    if (!res.ok) {
      let body;
      try { body = await res.json(); } catch { body = { message: res.statusText }; }
      throw new Error(`Qonto API ${res.status}: ${body?.message ?? res.statusText}`);
    }
    return res.json();
  }
  return { base, get };
}

async function listAccounts(client) {
  const data = await client.get("/organization", { include_external_accounts: "true" });
  return data?.organization?.bank_accounts ?? [];
}

// page through every transaction in [from, to] for one IBAN
async function listTransactions(client, iban, from, toExclusive) {
  const all = [];
  let page = 1;
  for (;;) {
    const data = await client.get("/transactions", {
      iban,
      settled_at_from: from,
      settled_at_to: toExclusive,
      sort_by: "settled_at:desc",
      current_page: String(page),
      per_page: "100",
    });
    all.push(...(data.transactions ?? []));
    const next = data.meta?.next_page;
    if (!next) break;
    page = next;
  }
  return all;
}

// ---- formatting ------------------------------------------------------------
function fmtAmount(cents, currency) {
  const v = (cents / 100).toFixed(2);
  return `${v} ${currency}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

// ---- main ------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (!isDate(args.from) || !isDate(args.to)) die("--from and --to are required (YYYY-MM-DD).\n\n" + HELP);
  if (args.from > args.to) die("--from must be on or before --to.");

  const env = loadEnv();
  if (!env.QONTO_API_KEY || !env.QONTO_ORG_SLUG) {
    die("QONTO_API_KEY / QONTO_ORG_SLUG not found in .env, .env.local, or the environment.");
  }
  const client = makeClient(env, args.base);
  const toExclusive = plusOneDay(args.to);

  let accounts = await listAccounts(client);
  if (args.account) {
    const needle = args.account.toLowerCase();
    accounts = accounts.filter(
      (a) => (a.name ?? "").toLowerCase().includes(needle) || (a.iban ?? "").toLowerCase().includes(needle),
    );
    if (!accounts.length) die(`no account matches --account "${args.account}".`);
  }

  const report = { range: { from: args.from, to: args.to }, accounts: [] };
  let grandMissing = 0;
  let grandScanned = 0;

  for (const acc of accounts) {
    const txs = await listTransactions(client, acc.iban, args.from, toExclusive);
    let missing = txs.filter((t) => !t.attachment_ids || t.attachment_ids.length === 0);
    if (args.requiredOnly) missing = missing.filter((t) => t.attachment_required === true);
    if (args.debitOnly) missing = missing.filter((t) => t.side === "debit");

    grandScanned += txs.length;
    grandMissing += missing.length;

    report.accounts.push({
      name: acc.name,
      iban: acc.iban,
      currency: acc.currency,
      scanned: txs.length,
      missing_count: missing.length,
      transactions: missing.map((t) => {
        const row = {
          id: t.id,
          transaction_id: t.transaction_id,
          settled_at: t.settled_at,
          emitted_at: t.emitted_at,
          side: t.side,
          amount: t.amount_cents / 100,
          currency: t.currency,
          counterparty: t.clean_counterparty_name || t.label,
          label: t.label,
          operation_type: t.operation_type,
          attachment_required: t.attachment_required,
          attachment_lost: t.attachment_lost,
        };
        if (args.gmail) {
          row.gmail = buildGmailQueries(
            row,
            Number.isFinite(args.gmailBefore) ? args.gmailBefore : 10,
            Number.isFinite(args.gmailAfter) ? args.gmailAfter : 5,
          );
        }
        return row;
      }),
    });
  }

  if (args.outFile) {
    writeFileSync(resolve(process.cwd(), args.outFile), JSON.stringify(report, null, 2));
    console.error(`wrote JSON -> ${args.outFile}`);
  }
  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  // ---- human table ----
  console.log(`\nMissing-attachment report  ${args.from} … ${args.to}`);
  for (const a of report.accounts) {
    console.log(`\n▌ ${a.name}  (${a.iban})`);
    if (!a.transactions.length) {
      console.log(`  ✓ no missing attachments (${a.scanned} transactions scanned)`);
      continue;
    }
    console.log(
      `  ${pad("date", 11)}${pad("side", 7)}${padL("amount", 14)}  ${pad("req", 4)}${pad("counterparty", 34)}id`,
    );
    for (const t of a.transactions) {
      console.log(
        `  ${pad((t.settled_at || t.emitted_at || "").slice(0, 10), 11)}` +
          `${pad(t.side, 7)}` +
          `${padL(fmtAmount(Math.round(t.amount * 100), t.currency), 14)}  ` +
          `${pad(t.attachment_required ? "yes" : "no", 4)}` +
          `${pad((t.counterparty || "").slice(0, 32), 34)}` +
          `${t.id}`,
      );
      if (t.gmail) console.log(`             gmail: ${t.gmail.tight}`);
    }
    console.log(`  → ${a.missing_count} missing of ${a.scanned} scanned`);
  }
  console.log(
    `\nTotal: ${grandMissing} transaction(s) missing an attachment across ${report.accounts.length} account(s) (${grandScanned} scanned).`,
  );
}

main().catch((e) => {
  console.error("\n" + (e?.stack || e?.message || String(e)));
  process.exit(1);
});
