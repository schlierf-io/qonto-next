---
name: invoice-fetcher
description: Fetch / list every Qonto transaction that is MISSING its invoice or receipt attachment within a date range, across all bank accounts, and source the missing invoices from Gmail. Use when asked to find transactions without an attachment, find missing receipts/invoices, build a worklist of receipts to collect, match Qonto transactions to invoice emails in Gmail, or check which Qonto transactions still need a document, for a given time frame.
---

# invoice-fetcher

Two capabilities:

1. **List** every Qonto transaction that has **no attachment** (no invoice /
   receipt) within a date range — a zero-dependency Node CLI,
   [`.claude/skills/invoice-fetcher/invoice-fetcher.mjs`](.claude/skills/invoice-fetcher/invoice-fetcher.mjs),
   that talks to the same Qonto third-party API the app's server uses
   ([lib/qonto/server.ts](lib/qonto/server.ts)) and reuses the `.env`
   credentials. The API key never leaves the machine.
2. **Source the missing invoices from Gmail** — the driver's `--gmail` mode
   emits a ready Gmail search query per transaction; the Gmail MCP then finds the
   matching invoice email, and you forward it to your Qonto receipts inbox so
   Qonto auto-attaches it. See **Run (Gmail as source)** below.

> Paths below are relative to the app root (`qonto-next/`). Run from there.

## Prerequisites

- **Node ≥ 18** (verified on v24.16.0). No `pnpm install` needed — the driver
  has zero dependencies.
- **Credentials in `.env`** (already present in this repo):
  `QONTO_API_KEY` and `QONTO_ORG_SLUG`. The loader reads `.env` then
  `.env.local` (the latter wins), and a real shell env var wins over both.
  No build, no dev server — the CLI calls Qonto directly.

## Run (agent path)

```bash
# Everything missing an attachment, all accounts, first half of 2026:
node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29
```

Output is a per-account table; the `id` column is the transaction UUID (the
handle you'd POST a PDF to via the app's upload route to attach the found
invoice). Common variations, all verified:

```bash
# Only the actionable worklist — transactions Qonto flags as needing a receipt:
node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29 --required-only

# One account (substring match on name or IBAN), outgoing payments only:
node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-06-01 --to 2026-06-29 --account C24 --debit-only

# Machine-readable, and also written to a file:
node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29 --json --out missing.json

# Flags:
node .claude/skills/invoice-fetcher/invoice-fetcher.mjs --help
```

Flags: `--from`/`--to` (YYYY-MM-DD, both inclusive, required), `--account <substr>`,
`--required-only`, `--debit-only`, `--gmail`, `--gmail-before <n>`,
`--gmail-after <n>`, `--json`, `--out <file>`, `--base <url>`.

The JSON shape (`--json` / `--out`) is `{ range, accounts: [{ name, iban,
currency, scanned, missing_count, transactions: [{ id, settled_at, side,
amount, currency, counterparty, attachment_required, attachment_lost, … }] }] }`.

## Run (Gmail as source)

Find the missing invoices in Gmail and let Qonto attach them. Three steps.

> Verified end-to-end on this account (June 2026, 18 transactions): the workflow
> confirmed **8** real invoice emails — 3 distinct Anthropic receipts correctly
> disambiguated to 3 charges by date, a Stripe receipt matched across a **$10 →
> €8.73** FX conversion, plus klarmobil / Coinbase / Deutsche Bahn / Microsoft —
> correctly returned **no-email** for groceries and for a vendor that had only a
> dunning notice, and the verifier **rejected** a marketing mail that merely
> contained the vendor's name.

**1 — Build the worklist with ready Gmail queries.** `--gmail` adds a `gmail`
object to each transaction (cleaned `vendor`, a date-windowed `tight` /
`loose` / `keywords` query, and `amount_en` / `amount_de` for body checks):

```bash
node .claude/skills/invoice-fetcher/invoice-fetcher.mjs \
  --from 2026-06-01 --to 2026-06-29 --required-only --gmail \
  --json --out missing.json
```

The `tight` query (`"<vendor>" has:attachment after:… before:…`) is also printed
under each row in table mode. Tune the search window with `--gmail-before` /
`--gmail-after` (defaults 10 / 5 days around the charge).

**2 — Match each transaction to its invoice email via the Gmail MCP.**

- *At scale — the committed workflow.* Flatten `missing.json` to an array of the
  per-transaction objects (`id, account, date, amount, currency, counterparty,
  vendor, amount_de, q_tight, q_loose`) and run
  [`gmail-reconcile.workflow.mjs`](.claude/skills/invoice-fetcher/gmail-reconcile.workflow.mjs)
  via the **Workflow tool**, passing that array as `args`. It fans out one
  Gmail-search agent per transaction, then an adversarial verifier per hit, and
  returns a reconciliation `{ id, counterparty, matched, confidence, verdict,
  sender, subject, mail_date, thread_id, has_attachment, reason }`.
- *Inline for a few.* For each transaction: `ToolSearch "gmail search_threads"`,
  run `gmail.tight`, fall back to `gmail.loose`; pick the thread whose **sender
  domain or subject** belongs to the vendor and looks like a receipt/invoice
  (`invoice@…`, `receipts@…`, Stripe "Your receipt from <vendor>"). Confirm by
  **date proximity, not exact amount** (see Gotchas).

**3 — Resolve: forward the matched email to your Qonto receipts inbox.** Qonto
auto-matches a forwarded receipt to its transaction and attaches it — verified
in this account: after a receipt was forwarded to `receipts-…@inbox.qonto.com`,
Qonto replied *"Wir haben Ihre Lieferantenrechnung … automatisch der
Transaktion zugeordnet."* Find your address in Qonto → *Einstellungen → Beleg
per E-Mail importieren*. The Gmail MCP cannot send/forward, so do this from your
mail client (or a filter); the matching above tells you exactly which mail.

## In the app (UI)

The worklist is also built into the Next.js app, so it works without the CLI:

- **Server logic** [`lib/qonto/missing.ts`](lib/qonto/missing.ts) — `getMissingAttachments(from, to, opts)`,
  the same paginate-all-accounts-then-filter logic as the driver, reusing the
  app's server-side Qonto client (key stays server-side).
- **API route** `GET /api/qonto/missing-attachments?from=…&to=…&required_only=1&debit_only=1&account=…`
  ([app/api/qonto/missing-attachments/route.ts](app/api/qonto/missing-attachments/route.ts))
  returns `{ range, accounts[], summary }` — the same JSON shape as the CLI.
- **UI panel** [`components/missing-attachments.tsx`](components/missing-attachments.tsx)
  ("Fehlende Belege"), rendered under the table in [app/page.tsx](app/page.tsx).
  It loads the cross-account worklist for the selected date range, with a
  "Nur erforderliche / Alle ohne Beleg" toggle, a count badge, and a refresh.

Verified live (`pnpm dev`, May 2026 default range): the panel shows the
Geschäftskonto worklist — 21 of 34 transactions without a receipt — matching
`curl /api/qonto/missing-attachments`. Note: in this org **every** missing
transaction is `attachment_required`, so the toggle count is identical in both
modes (correct, not a bug).

### Gmail matching in the app

Each worklist row has an **"In Gmail suchen"** button that finds its invoice
email server-side — same idea as the `gmail-reconcile` workflow, but with a
deterministic (no-LLM) matcher and the Gmail API instead of the MCP.

- **Connection** [`lib/gmail/server.ts`](lib/gmail/server.ts) — read-only Gmail
  client (OAuth refresh-token → access-token, `searchMessages`/`getMessage`/
  `getAttachment`), zero-dep `fetch`. One-time setup:
  [`scripts/gmail-auth.mjs`](scripts/gmail-auth.mjs) → `GOOGLE_*` in `.env`.
  Health check: `GET /api/gmail/ping`.
- **Query + match** [`lib/gmail/query.ts`](lib/gmail/query.ts) (TS port of the
  CLI's vendor-cleaning + windowed query) and [`lib/gmail/match.ts`](lib/gmail/match.ts)
  (`matchTransaction` — searches tight→loose, scores by sender/subject + date
  proximity). A candidate must carry a **receipt signal** (billing-mailbox
  sender, a receipt/Rechnung subject, or an attachment) — a plain mail from the
  vendor is rejected, so it returns "Kein Treffer" rather than a false positive.
- **Route** `GET /api/gmail/match?counterparty=…&date=…&amount=…`
  ([app/api/gmail/match/route.ts](app/api/gmail/match/route.ts)) → `GmailMatch`.
- **UI** the `GmailCell` in [`components/missing-attachments.tsx`](components/missing-attachments.tsx):
  confidence badge, subject, sender, attachment filename, and an **öffnen** deep
  link to the thread in Gmail.

Verified live: Tailscale / Railway / Skool → real receipts at `high`; a Google
Workspace **product-update** mail is correctly rejected (no receipt signal).

**One-click forward to Qonto** — each match has an **"An Qonto weiterleiten"**
button. [`lib/gmail/forward.ts`](lib/gmail/forward.ts) rebuilds the original
mail (body + all attachments) and sends it via `POST /api/gmail/forward`
([route](app/api/gmail/forward/route.ts)) to `QONTO_RECEIPTS_INBOX`, where Qonto
auto-attaches it. Needs the **`gmail.send`** scope (re-run `scripts/gmail-auth.mjs`)
and `QONTO_RECEIPTS_INBOX` in `.env`. Pass `{ dry: true }` to build the MIME
without sending. Verified: dry-run assembles the forward; a real send without the
scope returns a friendly 403 (no mail sent).

## Gotchas

- **End date is inclusive.** Qonto's `settled_at_to` is *exclusive* of the
  boundary day, so the driver adds +1 day internally (mirrors
  `getTransactions()` in [lib/qonto/server.ts](lib/qonto/server.ts)). Without
  this the last day silently drops out.
- **Pagination is mandatory.** `per_page` caps at 100; one account here has
  1000+ transactions. The driver follows `meta.next_page` until null — a
  single-page fetch would silently truncate the result.
- **Default scans all accounts, including external ones.** The org exposes
  more than the two obvious accounts (e.g. `GmbH-Konto`, `C24 Smartkonto`) only
  when called with `include_external_accounts=true`, which the driver does.
  Narrow with `--account`.
- **"Missing attachment" ≠ "needs an attachment".** Many transactions
  legitimately don't require a receipt (internal transfers, fees). The plain
  run lists *all* with no attachment; `--required-only` keeps just the ones
  Qonto marks `attachment_required: true` — that's the real to-do list.
- **Auth header is `slug:key`**, not `Bearer` — same convention as the app.
- **The driver cannot conjure a missing invoice.** "Missing" means the document
  isn't in Qonto. The CLI produces the *worklist*; **Run (Gmail as source)**
  finds the actual invoice email and forwards it to Qonto.

### Gmail sourcing

- **Qonto receipts inbox auto-matches.** Forwarding a receipt to
  `receipts-…@inbox.qonto.com` makes Qonto attach it to the right transaction
  automatically — the cleanest resolution, no download/upload. This is the
  recommended action, *not* `POST …/attachments`.
- **The Gmail MCP can search and read, but cannot download attachments or
  send/forward email.** So fully-automatic attach isn't possible through the MCP
  alone — the MCP does the *matching*; the *forward* is a manual/mail-client
  step. (`get_thread` does expose `attachments:[{filename}]` for display.)
- **Match on vendor + date, never exact amount.** Card charges are currency-
  converted: an Anthropic receipt of **$48.58** is the **41.02 EUR** Qonto line.
  Amounts won't equal; vendor + a few days' proximity is the reliable signal.
- **Vendors bill many times per period.** Anthropic API receipts arrive nearly
  daily, so several emails fall inside one window — disambiguate by date and
  approximate amount. `--gmail-before`/`--gmail-after` narrow the window.
- **Payment-processor opacity.** `PAYPAL *uboll40163` / `PAYPAL ** kaXll GmbH`
  hide the real merchant; vendor cleaning can't recover it and these usually
  return no match. Bank fees and cash withdrawals (`C24 Bank`, `VR BAYERN
  MITTE`) have no email invoice at all — expect (and accept) no-match there.
- **`get_thread` on HTML receipts can exceed the MCP token cap (~25k).** Prefer
  `search_threads` metadata; a `has:attachment` hit on the `tight` query already
  implies a PDF is attached, so you rarely need the full body.
- **Some invoices are link-only** (a "download your invoice" button, no PDF
  attached). The `tight` query misses these; fall back to `loose` and forward
  the email anyway — Qonto extracts the invoice on its side.

## Troubleshooting

- `QONTO_API_KEY / QONTO_ORG_SLUG not found …` → `.env` is missing the keys, or
  you're not running from the app root. `cd` into `qonto-next/` first.
- `Qonto API 401: …` → the key in `.env` is wrong or expired.
- `--from and --to are required (YYYY-MM-DD).` → pass both dates in that exact
  format; the tool exits 1.
- Empty report where you expected rows → the date window may predate the
  account's activity, or your `--account` substring excluded it. Drop
  `--account` to scan everything, and remember the range is inclusive on both
  ends.
- `gmail-reconcile.workflow.mjs` returns `summary.total: 0` with 0 agents → the
  transactions array didn't arrive. Pass it as `args` (the script also accepts
  a JSON **string** and parses it). It must be the flattened per-transaction
  array, not the whole `{ range, accounts }` object.
- A Gmail-match agent finds nothing for a real vendor → widen the window
  (`--gmail-before 21 --gmail-after 10`) and retry with `gmail.loose`; the
  invoice may be link-only (no `has:attachment`) or the vendor name in the mail
  differs from the bank's counterparty string.
