---
name: invoice-fetcher
description: Fetch / list every Qonto transaction that is MISSING its invoice or receipt attachment within a date range, across all bank accounts. Use when asked to find transactions without an attachment, find missing receipts/invoices, build a worklist of receipts to collect, or check which Qonto transactions still need a document, for a given time frame.
---

# invoice-fetcher

Lists every Qonto transaction that has **no attachment** (no invoice / receipt
uploaded) within a date range, so the missing invoices can be chased up and
attached. It is a zero-dependency Node CLI —
[`.claude/skills/invoice-fetcher/invoice-fetcher.mjs`](.claude/skills/invoice-fetcher/invoice-fetcher.mjs) —
that talks to the same Qonto third-party API the app's server uses
([lib/qonto/server.ts](lib/qonto/server.ts)) and reuses the credentials from
`.env`. The API key never leaves the machine.

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
`--required-only`, `--debit-only`, `--json`, `--out <file>`, `--base <url>`.

The JSON shape (`--json` / `--out`) is `{ range, accounts: [{ name, iban,
currency, scanned, missing_count, transactions: [{ id, settled_at, side,
amount, currency, counterparty, attachment_required, attachment_lost, … }] }] }`.

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
  isn't in Qonto. The tool produces the *worklist* of transactions still
  needing one; uploading the PDF you collect is a separate step (the app's
  `POST app/api/qonto/transactions/[id]/attachments` route does that).

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
