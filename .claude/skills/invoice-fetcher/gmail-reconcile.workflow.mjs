// gmail-reconcile.workflow.mjs — match each "missing attachment" Qonto
// transaction to its invoice/receipt email in Gmail, then adversarially verify.
//
// Run via the Workflow tool (NOT plain node — it needs the agent runtime + the
// Gmail MCP). Feed it the output of:
//   invoice-fetcher.mjs --from … --to … --required-only --gmail --json
// flattened to an array of { id, account, date, amount, currency,
// counterparty, vendor, amount_de, q_tight, q_loose } and passed as `args`.
//
// Returns a reconciliation: per transaction, the best-matching Gmail invoice
// (sender/subject/date/threadId, attachment present?) with a verified verdict.

export const meta = {
  name: 'gmail-reconcile',
  description: 'Match missing-attachment Qonto transactions to invoice/receipt emails in Gmail and verify each match',
  phases: [
    { title: 'Match', detail: 'one Gmail-search agent per transaction' },
    { title: 'Verify', detail: 'adversarially confirm each candidate is really that vendor\'s invoice' },
  ],
}

// args may arrive as a parsed array/object OR as a JSON string — handle both.
let parsedArgs = args
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch { parsedArgs = [] }
}
const items = Array.isArray(parsedArgs) ? parsedArgs : (parsedArgs?.transactions ?? [])
if (!items.length) {
  log('no transactions passed in args — nothing to reconcile')
  return { reconciliation: [], summary: { total: 0, matched: 0, unmatched: 0 } }
}

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'confidence', 'has_attachment', 'reason'],
  properties: {
    found: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    thread_id: { type: ['string', 'null'] },
    message_id: { type: ['string', 'null'] },
    sender: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    mail_date: { type: ['string', 'null'] },
    has_attachment: { type: 'boolean' },
    attachment_filename: { type: ['string', 'null'] },
    query_used: { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'rejected', 'uncertain'] },
    reason: { type: 'string' },
  },
}

const matchPrompt = (t) => `You match ONE bank transaction to its invoice/receipt email in the user's Gmail.

Transaction:
- counterparty: ${t.counterparty}  (cleaned vendor: "${t.vendor}")
- amount: ${t.amount} ${t.currency}  (German format: ${t.amount_de})
- charge date: ${t.date}
- account: ${t.account}

Load the Gmail search tool first: call ToolSearch with query "gmail search_threads" and select it (its name looks like mcp__<id>__search_threads). You may also load mcp__<id>__get_thread the same way.

Procedure:
1. Run search_threads with this query (already date-windowed):
     ${t.q_tight}
   A hit here means the email HAS an attachment (the query requires it).
2. If nothing relevant, run the looser query:
     ${t.q_loose}
3. If still nothing, try just "${t.vendor}" with the same after:/before: window.
Pick the thread whose sender domain or subject clearly belongs to "${t.vendor}" and that looks like a receipt/invoice/order confirmation (sender like invoice@, receipts@, billing@, noreply@<vendor>, or a Stripe receipt "Your receipt from <vendor>"). Ignore marketing, rate-limit notices, dunning/Mahnung, and the user's own SENT forwards.

Token discipline: rely on search_threads metadata (sender, subject, snippet, date). Only call get_thread (FULL_CONTENT) if you must read the attachment filename, and know receipt bodies can be large — if it errors as too large, proceed using the search metadata and set has_attachment from whether the tight query matched.

Currency note: the email amount may be in a DIFFERENT currency than the charge (card conversion), so do NOT require an exact amount match — vendor + date proximity is the primary signal.

Return the best match. If no credible invoice email exists, found=false, confidence="none". has_attachment=true only if the tight query matched or you saw an attachment.`

const verifyPrompt = (t, m) => `Skeptically verify this proposed transaction→email match. Default to "rejected" unless the evidence is clear.

Transaction: ${t.counterparty} | ${t.amount} ${t.currency} | ${t.date}
Proposed email: sender="${m.sender}" subject="${m.subject}" date="${m.mail_date}" thread=${m.thread_id}

Is this email genuinely an invoice/receipt/order-confirmation issued by (or on behalf of) "${t.vendor}", dated within a few days of ${t.date}? Reject if it is marketing, a balance/threshold alert, a dunning notice, a different vendor, or the user's own forwarded copy. You may re-run the Gmail search tool (ToolSearch "gmail search_threads") to double-check sender/subject. Keep it to metadata. Verdict confirmed / rejected / uncertain with a one-line reason.`

phase('Match')
const reconciliation = await pipeline(
  items,
  (t) => agent(matchPrompt(t), {
    label: `match:${(t.vendor || t.counterparty || '?').slice(0, 18)}`,
    phase: 'Match',
    schema: MATCH_SCHEMA,
  }).then((m) => ({ tx: t, match: m })),
  ({ tx, match }) => {
    if (!match || !match.found) return { tx, match, verify: null }
    return agent(verifyPrompt(tx, match), {
      label: `verify:${(tx.vendor || tx.counterparty || '?').slice(0, 18)}`,
      phase: 'Verify',
      schema: VERIFY_SCHEMA,
    }).then((v) => ({ tx, match, verify: v }))
  },
)

const rows = reconciliation.filter(Boolean)
const confirmed = rows.filter((r) => r.match?.found && r.verify?.verdict === 'confirmed')
const rejected = rows.filter((r) => r.match?.found && r.verify?.verdict !== 'confirmed')
const unmatched = rows.filter((r) => !r.match?.found)

log(`reconciled ${rows.length}: ${confirmed.length} confirmed, ${rejected.length} match-but-unverified, ${unmatched.length} no email found`)

return {
  reconciliation: rows.map((r) => ({
    id: r.tx.id,
    account: r.tx.account,
    date: r.tx.date,
    amount: r.tx.amount,
    currency: r.tx.currency,
    counterparty: r.tx.counterparty,
    matched: !!(r.match?.found && r.verify?.verdict === 'confirmed'),
    confidence: r.match?.confidence ?? 'none',
    verdict: r.verify?.verdict ?? (r.match?.found ? 'unverified' : 'no-email'),
    sender: r.match?.sender ?? null,
    subject: r.match?.subject ?? null,
    mail_date: r.match?.mail_date ?? null,
    thread_id: r.match?.thread_id ?? null,
    has_attachment: r.match?.has_attachment ?? false,
    attachment_filename: r.match?.attachment_filename ?? null,
    reason: r.verify?.reason ?? r.match?.reason ?? '',
  })),
  summary: {
    total: rows.length,
    confirmed: confirmed.length,
    match_unverified: rejected.length,
    no_email: unmatched.length,
  },
}
