---
name: invoice-fetcher
description: Fetch / list every Qonto transaction that is MISSING its invoice or receipt attachment within a date range, across all bank accounts, and source the missing invoices from Gmail or a paperless-ngx document archive. Use when asked to find transactions without an attachment, find missing receipts/invoices, build a worklist of receipts to collect, match Qonto transactions to invoice emails in Gmail or documents in paperless-ngx, or check which Qonto transactions still need a document, for a given time frame.
---

# invoice-fetcher

Two capabilities:

1. **List** every Qonto transaction that has **no attachment** (no invoice /
   receipt) within a date range — a zero-dependency Node CLI,
   [`.Codex/skills/invoice-fetcher/invoice-fetcher.mjs`](.Codex/skills/invoice-fetcher/invoice-fetcher.mjs),
   that talks to the same Qonto third-party API the app's server uses
   ([lib/qonto/server.ts](lib/qonto/server.ts)) and reuses the `.env`
   credentials. The API key never leaves the machine.
2. **Source the missing invoices** from one of two places, both of which keep
   credentials on the machine:
   - **Gmail** — the driver's `--gmail` mode emits a ready Gmail search query per
     transaction; the Gmail MCP then finds the matching invoice email, and you
     forward it to your Qonto receipts inbox so Qonto auto-attaches it. See
     **Run (Gmail as source)** below.
   - **paperless-ngx** — the driver's `--paperless` mode searches your
     paperless-ngx archive directly (Token auth) and reports the best-matching
     document per transaction; in the app, one click downloads it and attaches it
     to the Qonto transaction. See **Run (paperless-ngx as source)** below.

> Paths below are relative to the app root (`qonto-next/`). Run from there.

## Prerequisites

- **Node ≥ 18** (verified on v24.16.0). No `pnpm install` needed — the driver
  has zero dependencies.
- **Credentials in `.env`** (already present in this repo):
  `QONTO_API_KEY` and `QONTO_ORG_SLUG`. The loader reads `.env` then
  `.env.local` (the latter wins), and a real shell env var wins over both.
  No build, no dev server — the CLI calls Qonto directly.
- **Optional, only for `--paperless`:** `PAPERLESS_URL` (instance base URL, no
  trailing `/api`) and `PAPERLESS_TOKEN` (paperless-ngx → user menu → *My
  Profile* → *API Auth Token*). Auth is a single header `Authorization: Token
  <token>`. The token never leaves the machine.

## Run (agent path)

```bash
# Everything missing an attachment, all accounts, first half of 2026:
node .Codex/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29
```

Output is a per-account table; the `id` column is the transaction UUID (the
handle you'd POST a PDF to via the app's upload route to attach the found
invoice). Common variations, all verified:

```bash
# Only the actionable worklist — transactions Qonto flags as needing a receipt:
node .Codex/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29 --required-only

# One account (substring match on name or IBAN), outgoing payments only:
node .Codex/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-06-01 --to 2026-06-29 --account C24 --debit-only

# Machine-readable, and also written to a file:
node .Codex/skills/invoice-fetcher/invoice-fetcher.mjs --from 2026-01-01 --to 2026-06-29 --json --out missing.json

# Flags:
node .Codex/skills/invoice-fetcher/invoice-fetcher.mjs --help
```

Flags: `--from`/`--to` (YYYY-MM-DD, both inclusive, required), `--account <substr>`,
`--required-only`, `--debit-only`, `--gmail`, `--paperless`, `--gmail-before <n>`,
`--gmail-after <n>`, `--before <n>`, `--after <n>`, `--json`, `--out <file>`,
`--base <url>`.

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
node .Codex/skills/invoice-fetcher/invoice-fetcher.mjs \
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
  [`gmail-reconcile.workflow.mjs`](.Codex/skills/invoice-fetcher/gmail-reconcile.workflow.mjs)
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

## Run (paperless-ngx as source)

If your invoices live in a [paperless-ngx](https://docs.paperless-ngx.com)
archive, the driver searches it **directly** — no MCP, no manual forward, because
paperless auth is a single `Authorization: Token <token>` header. Set
`PAPERLESS_URL` + `PAPERLESS_TOKEN` (see Prerequisites), then:

```bash
node .Codex/skills/invoice-fetcher/invoice-fetcher.mjs \
  --from 2026-06-01 --to 2026-06-29 --required-only --paperless
```

For each missing transaction the driver cleans the counterparty to a vendor,
full-text-searches paperless for it, resolves correspondents, keeps only
documents whose date is close to the charge, and prints the best one under the
row:

```
  2026-06-12 debit       -41.02 EUR  yes Anthropic                         <id>
             paperless: [high] Anthropic Invoice INV-1234 — 2026-06-10 (±2 d, score 5)
```

Tune the window with `--before` / `--after` (default 10 / 5 days). With `--json` /
`--out`, each transaction gains a `paperless` object: `{ matched, document_id,
title, correspondent, created, score, confidence, url, reason }`. `--gmail` and
`--paperless` can be combined — each annotates the row independently.

**Resolve in the app (one click).** The "Fehlende Belege" panel has an
**"An Qonto anhängen"** button per paperless match: it downloads the document's
PDF from paperless and uploads it straight onto the Qonto transaction — no mail
round-trip. See **In the app (UI)** below.

### How the match is scored

Deterministic, no LLM (identical logic in the CLI and
[lib/paperless/match.ts](lib/paperless/match.ts)): search by vendor (whoosh
phrase → terms), then for each candidate score **+3** if the paperless
*correspondent* contains the vendor (the document's issuer), **+2** for the
*title*, **+1** for the *original filename*. Candidates are then **filtered to a
date window** around the charge (`before + after + 21` days) and the best
remaining one with a structured signal (score ≥ 2) wins. Confidence: **high** =
score ≥ 3 *and* within the core `before+after` window, **medium** = score ≥ 2,
else low.

> The date window is enforced **in code**, not in the query: paperless's whoosh
> `created:[a to b]` DSL does **not** hard-filter when passed via `?query=` (a
> vendor search would otherwise return that vendor's invoice from any month). So
> the matcher searches by vendor and rejects documents dated too far from the
> charge — without this, an old invoice from the same vendor matches at "high".

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
  Dunning **and failed/declined-payment** notices ("… payment was unsuccessful")
  are excluded outright.
- **Vendor routing** — `VENDOR_ROUTES` in [lib/gmail/query.ts](lib/gmail/query.ts)
  maps a counterparty whose bank label ≠ its receipt sender to the real brand +
  sender domains (each route: `linkOnly` drops `has:attachment`; `requireAmount`
  demands an in-body amount match):
  - **Codex.ai / ANTHROPIC / "Codex (Anthropic)"** → `from:(anthropic.com OR
    stripe.com) "Anthropic"` (PBC/USD via `mail.anthropic.com`, the EUR Codex
    subscription via Stripe "Anthropic Ireland"). `linkOnly` + `requireAmount`
    (amount is in the body and they bill often, so it disambiguates).
  - **Google Workspace/Cloud/One/Wallet** → `from:(google.com) "Google"` (invoices
    from `payments-noreply@google.com`, e.g. *"… Ihre Rechnung …"* with a PDF).
    `linkOnly` only — **not** `requireAmount`, because Google prints the total in
    the attached PDF, not the email body. (Consumer Google One/Play receipts may
    go to a different mailbox and won't be found here.) An automated one-time
    backfill for exactly this route lives at
    [`n8n/workflows/google-invoices-to-qonto.json`](../../../n8n/workflows/google-invoices-to-qonto.json)
    (see the main [README](../../../README.md#workflow-google-rechnungen--qonto)).
- **Amount + date matching** — when the charge amount is known, the matcher reads
  the top date-closest candidates' bodies and prefers the one whose total equals
  the charge. It matches the **original/local amount** (a $25 API charge shows
  `$25.00`, not the booked €21.72), so `local_amount` is passed through. For
  routed vendors (Anthropic bills many times) the amount is **required** — no
  amount match ⇒ "Kein Treffer" rather than a wrong same-vendor receipt; a
  confirmed amount shows a green **Betrag** badge and lifts confidence to `high`.
- **Route** `GET /api/gmail/match?counterparty=…&date=…&amount=…&currency=…&local_amount=…&local_currency=…`
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
- **Sender must be the Qonto account owner.** Qonto's receipt inbox only ingests
  mail **from** the owner's address (here `juergen@schlierf.eu`). The forward sets
  `From:` to the authenticated mailbox (`getProfile().emailAddress`) — so the
  connected Gmail account *must be* that owner. The `ForwardResult.from` field
  echoes it; the dry-run shows it before you send.

### paperless-ngx matching in the app

Each worklist row also has an **"In Paperless suchen"** button — the paperless
analog of the Gmail one, but the resolution is simpler because the app can pull
the file itself.

- **Connection** [`lib/paperless/server.ts`](lib/paperless/server.ts) — read-only
  paperless client (`Authorization: Token <token>`, zero-dep `fetch`):
  `searchDocuments` (whoosh `?query=`), `getDocument`, `downloadDocument`, and a
  cached correspondent id→name map. Env: `PAPERLESS_URL` + `PAPERLESS_TOKEN`.
  Health check: `GET /api/paperless/ping` → `{ connected, host, documentsTotal }`.
- **Query + match** [`lib/paperless/query.ts`](lib/paperless/query.ts) (vendor +
  `created:[…]` window, reusing the shared `cleanVendor` in
  [lib/vendor.ts](lib/vendor.ts)) and [`lib/paperless/match.ts`](lib/paperless/match.ts)
  (`matchTransaction` — tight→loose, scores correspondent/title/filename + date
  proximity).
- **Route** `GET /api/paperless/match?counterparty=…&date=…&amount=…`
  ([app/api/paperless/match/route.ts](app/api/paperless/match/route.ts)) →
  `PaperlessMatch`.
- **UI** the `PaperlessCell` in [`components/missing-attachments.tsx`](components/missing-attachments.tsx):
  confidence badge, title, correspondent, document date, original filename, and an
  **öffnen** deep link into the paperless web UI.

**One-click attach to Qonto** — each match has an **"An Qonto anhängen"** button.
[`lib/paperless/attach.ts`](lib/paperless/attach.ts) downloads the document's PDF
(`GET /api/documents/{id}/download/`) and uploads it via `POST /api/paperless/attach`
([route](app/api/paperless/attach/route.ts)) straight onto the transaction, reusing
the Qonto client's `uploadAttachment`. No receipts inbox, no forwarding — the bytes
go directly to Qonto.

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
- **"Privatentnahme" is always exempt.** Transactions whose label / reference /
  note / counterparty contains *Privatentnahme* (owner's draw) never need a
  receipt, so they're dropped from the worklist unconditionally — in both the CLI
  and the app ([lib/qonto/missing.ts](lib/qonto/missing.ts) `exemptFromInvoice`).
  Add more exempt patterns to the `NO_INVOICE_NEEDED` regex in both files.
- **Auth header is `slug:key`**, not `Bearer` — same convention as the app.
- **The driver cannot conjure a missing invoice.** "Missing" means the document
  isn't in Qonto. The CLI produces the *worklist*; **Run (Gmail as source)** and
  **Run (paperless-ngx as source)** find the actual invoice and get it onto Qonto.

### Gmail sourcing

- **Qonto receipts inbox auto-matches.** Forwarding a receipt to
  `receipts-…@inbox.qonto.com` makes Qonto attach it to the right transaction
  automatically — the cleanest resolution, no download/upload. This is the
  recommended action, *not* `POST …/attachments`.
- **The Gmail MCP can search and read, but cannot download attachments or
  send/forward email.** So fully-automatic attach isn't possible through the MCP
  alone — the MCP does the *matching*; the *forward* is a manual/mail-client
  step. (`get_thread` does expose `attachments:[{filename}]` for display.)
- **Match the ORIGINAL (local) amount, not the booked €.** Card charges are
  currency-converted: an Anthropic receipt of **$25.00** is the **21.72 EUR**
  Qonto line, so the booked € won't equal the receipt — but the receipt does show
  the original `$25.00`, which is the transaction's `local_amount`. The matcher
  compares against `local_amount` (and the booked amount as a fallback); the CLI's
  `--gmail` emits `amount_local` + `local_currency` for the reconcile workflow.
- **Vendors bill many times per period → disambiguate by amount.** Anthropic API
  receipts arrive nearly daily, so several land in one window. Date proximity
  alone can't tell them apart; the amount does (each receipt shows its own total).
  The app matcher reads the date-closest candidate bodies and picks the
  amount-match. `--gmail-before`/`--gmail-after` (or `--before`/`--after`) also
  narrow the window.
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

### paperless-ngx sourcing

- **paperless is searched directly, then attached directly.** Token auth means
  the driver/app can both *search* and *download*, so resolution is one click
  (`An Qonto anhängen`) — no receipts-inbox round-trip and no `gmail.send`-style
  scope dance. This is the key advantage over the Gmail path.
- **`PAPERLESS_URL` is the base, without `/api`.** The client appends `/api`
  itself (and tolerates a trailing slash or an accidental `/api`). A wrong host
  or token surfaces as a 503 ("nicht verbunden") on `GET /api/paperless/ping`.
- **Matching keys on the *correspondent*.** paperless usually assigns each invoice
  a correspondent (the issuer); that's the strongest signal (+3). If your archive
  doesn't use correspondents, matches still work off the title/filename and OCR'd
  content, just with lower confidence.
- **Matching uses the document's `created` date** (its own date, ideally the
  invoice date) for the proximity window. If your OCR didn't detect a date,
  paperless falls back to the scan date — if a known invoice is filed with an
  off date, widen the window with `--before` / `--after`.
- **Whoosh, not exact amount.** Like the Gmail path, match on vendor + date
  proximity; the document's amount may differ from the converted Qonto line.
- **`download/` serves the archived (OCR'd) PDF**, falling back to the original
  upload — exactly what Qonto wants. The filename comes from the
  `Content-Disposition` header (or `paperless-<id>.pdf`).
- **Generic / short vendor names can yield a `medium` false positive.** Vendor
  cleaning (shared with Gmail) strips geo/legal words, so e.g. *Plan
  International* collapses to *Plan*, which substring-matches an unrelated *“Max
  Plan Abonnement”* receipt. Such hits land at `medium` (title-only, no
  correspondent), and the title/correspondent are shown before you click
  *An Qonto anhängen* — so review medium matches; only `high` (correspondent +
  near date) is safe to attach unseen.

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
- `PAPERLESS_URL / PAPERLESS_TOKEN not found …` → set both in `.env` (only needed
  for `--paperless`); see Prerequisites.
- `paperless API 401/403: …` → the token is wrong/expired, or `PAPERLESS_URL`
  points at the wrong host. Confirm with `GET /api/paperless/ping`.
- `--paperless` reports "kein Treffer" for a vendor you know is filed → widen the
  window (`--before 21 --after 10`); the document's correspondent/title may not
  contain the cleaned vendor (it still searches OCR content, but scores lower).
- "An Qonto anhängen" fails with 503 → paperless not configured; with a Qonto
  4xx → the same upload limits as a manual receipt upload apply (PDF, size).
