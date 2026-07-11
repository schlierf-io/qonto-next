// Match ONE missing-attachment transaction to its invoice/receipt email.
// Server-side, deterministic (no LLM): build the Gmail query, search, score the
// candidates by sender/subject signals + date proximity, then — when the charge
// amount is known — read the top candidates' bodies and prefer the one whose
// receipt amount matches. The amount in the email is in the ORIGINAL currency
// (a $25 API charge shows "$25.00", not the converted €), so we match against
// the transaction's local_amount as well as its booked amount.

import { searchMessages, getMessage, type GmailMessageMeta } from "@/lib/gmail/server";
import { buildGmailQueries } from "@/lib/gmail/query";

export interface GmailMatch {
  found: boolean;
  confidence: "high" | "medium" | "low" | "none";
  vendor: string;
  query: string;
  message_id?: string;
  thread_id?: string;
  sender?: string;
  subject?: string;
  date?: string;
  attachment_filename?: string | null;
  amount_matched?: boolean; // receipt body contained the charge amount
  matched_amount?: number | null;
  permalink?: string;
  reason: string;
}

export interface MatchInput {
  counterparty: string;
  date: string; // YYYY-MM-DD
  amount?: number; // booked amount (e.g. EUR)
  currency?: string; // booked currency
  localAmount?: number; // original-currency amount (what the receipt shows)
  localCurrency?: string; // original currency, e.g. USD
  beforeDays?: number;
  afterDays?: number;
  selfEmail?: string; // exclude the user's own forwarded copies
}

const RECEIPT_KW =
  /(receipt|invoice|rechnung|beleg|quittung|zahlung|payment|order|bestell|buchungsbest|auftrag)/i;
// strong "this is a billing mailbox" signal (local part of the sender address)
const BILLING_SENDER = /(invoice|receipts?|billing|statements?|rechnung|payments?)/i;
const DUNNING_KW = /(mahnung|offene forderung|zahlungserinnerung|inkasso|overdue|past due)/i;
// payment-failure / action-required notices are NOT receipts
const FAILED_KW =
  /(unsuccessful|payment failed|payment was declined|failed payment|could not (be )?process|action required|fehlgeschlagen|nicht erfolgreich|wurde abgelehnt|zahlung.*(fehl|abgelehnt))/i;
const MARKETING_KW =
  /(newsletter|angebot|sale|rabatt|% off|ends (tomorrow|today)|webinar|kostenlos testen|produktupdate|product update|neue funktion|tipps)/i;

function senderEmail(from = ""): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).toLowerCase();
}

function daysApart(aIso: string, bRfc: string): number {
  const a = new Date(aIso).getTime();
  const b = new Date(bRfc).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 999;
  return Math.abs(a - b) / 86_400_000;
}

interface Scored {
  msg: GmailMessageMeta;
  score: number;
  proximity: number;
}

function scoreCandidate(
  msg: GmailMessageMeta,
  vendor: string,
  chargeDate: string,
  hasAttachment: boolean,
  selfEmail?: string,
): Scored | null {
  const from = msg.headers["from"] ?? "";
  const subject = msg.headers["subject"] ?? "";
  const date = msg.headers["date"] ?? "";
  const email = senderEmail(from);
  const senderLocal = email.split("@")[0] ?? "";
  const hay = `${from} ${subject} ${msg.snippet ?? ""}`;

  // hard excludes
  if (selfEmail && email.includes(selfEmail.toLowerCase())) return null; // own forwarded copy
  if (DUNNING_KW.test(hay)) return null; // dunning notice, not an invoice
  if (FAILED_KW.test(hay)) return null; // failed/declined payment notice, not a receipt

  const vendorTokens = vendor.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const senderHasVendor = vendorTokens.some((t) => email.includes(t));
  const subjectHasVendor = vendorTokens.some((t) => subject.toLowerCase().includes(t));
  if (!senderHasVendor && !subjectHasVendor) return null; // not this vendor

  // a candidate must look like a RECEIPT, not just any mail from the vendor.
  const receiptSubject = RECEIPT_KW.test(subject);
  const billingSender = BILLING_SENDER.test(senderLocal);
  const receiptSignal = receiptSubject || billingSender || hasAttachment;
  if (!receiptSignal) return null; // vendor mail, but not an invoice/receipt
  if (MARKETING_KW.test(hay) && !receiptSubject && !billingSender) return null;

  let score = 0;
  if (senderHasVendor) score += 3;
  if (subjectHasVendor) score += 2;
  if (receiptSubject) score += 2;
  if (billingSender) score += 2;
  if (hasAttachment) score += 1;

  const proximity = daysApart(chargeDate, date);
  return { msg, score, proximity };
}

function confidenceFor(
  score: number,
  amountMatched: boolean,
  requireAmount: boolean,
): GmailMatch["confidence"] {
  if (amountMatched && score >= 3) return "high"; // amount + vendor + date = strong
  // routed vendors (e.g. Anthropic) issue per-charge receipts that DO show the
  // amount and bill often — without an amount match we can't claim "high".
  if (requireAmount) return score >= 3 ? "medium" : "low";
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

/** Pull the first PDF/attachment filename from a full message payload. */
function firstAttachmentName(payload: any): string | null {
  const stack = [payload];
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    if (p.filename && p.body?.attachmentId) return p.filename as string;
    if (Array.isArray(p.parts)) stack.push(...p.parts);
  }
  return null;
}

// --- amount extraction from a receipt body -----------------------------------

/** Concatenate all text/plain + text/html parts of a message payload. */
function bodyText(payload: any): string {
  let out = "";
  const stack = [payload];
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    if ((p.mimeType === "text/plain" || p.mimeType === "text/html") && p.body?.data) {
      try {
        out += " " + Buffer.from(p.body.data, "base64url").toString("utf8");
      } catch {
        /* ignore undecodable part */
      }
    }
    if (Array.isArray(p.parts)) stack.push(...p.parts);
  }
  return out;
}

/** Normalise "1.234,56" / "1,234.56" / "90.00" / "90,00" -> number. */
function parseAmount(raw: string): number | null {
  let s = raw.trim();
  if (s.includes(".") && s.includes(",")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".") // 1.234,56
      : s.replace(/,/g, ""); // 1,234.56
  } else if (s.includes(",")) {
    s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** All currency-adjacent amounts in the text (symbol±value or value±code). */
function extractAmounts(text: string): number[] {
  const out = new Set<number>();
  const re = /(?:€|\$|£|EUR|USD|GBP)\s*([0-9][0-9.,]*[0-9])|([0-9][0-9.,]*[0-9])\s*(?:€|\$|£|EUR|USD|GBP)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseAmount(m[1] ?? m[2] ?? "");
    if (n != null) out.add(n);
  }
  return [...out];
}

function amountClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01;
}

/** The amounts a receipt for this transaction could legitimately show. */
function expectedAmounts(input: MatchInput): number[] {
  const xs: number[] = [];
  if (typeof input.localAmount === "number" && input.localAmount > 0) xs.push(input.localAmount);
  if (typeof input.amount === "number" && input.amount > 0) xs.push(input.amount);
  return [...new Set(xs.map((x) => Math.round(x * 100) / 100))];
}

export async function matchTransaction(input: MatchInput): Promise<GmailMatch> {
  const q = buildGmailQueries(
    input.counterparty,
    input.date,
    input.amount,
    input.beforeDays ?? 10,
    input.afterDays ?? 5,
  );
  const vendor = q.vendor;
  if (!vendor) {
    return { found: false, confidence: "none", vendor, query: "", reason: "Kein Händlername ableitbar." };
  }

  // routed vendors (e.g. Anthropic) bill often -> pull more candidates so the
  // amount-matching one is in the set; tight (has:attachment) first, then loosen.
  const limit = q.route ? 25 : 10;
  let usedQuery = q.tight;
  let fromTight = true;
  let candidates = await searchMessages(q.tight, limit);
  if (!candidates.length) {
    usedQuery = q.loose;
    fromTight = false;
    candidates = await searchMessages(q.loose, limit);
  }

  // fromTight only proves an attachment when the tight query actually included
  // `has:attachment` — linkOnly routes (e.g. Google) drop that clause, so
  // membership in the tight result set says nothing about a real PDF. Without
  // this, any google.com mail (a security alert, a product update — no receipt
  // signal otherwise) could ride "fromTight" into a false receiptSignal/score.
  const hasAttachmentSignal = fromTight && !q.route?.linkOnly;

  const scored = candidates
    .map((m) => scoreCandidate(m, vendor, input.date, hasAttachmentSignal, input.selfEmail))
    .filter((s): s is Scored => s !== null && s.score >= 3)
    .sort((a, b) => b.score - a.score || a.proximity - b.proximity);

  if (!scored.length) {
    return {
      found: false,
      confidence: "none",
      vendor,
      query: usedQuery,
      reason: candidates.length
        ? `${candidates.length} Treffer, aber keiner sieht nach Rechnung/Beleg von „${vendor}“ aus.`
        : `Keine E-Mail von „${vendor}“ im Zeitfenster gefunden.`,
    };
  }

  // amount disambiguation/verification: read the top candidates' bodies and look
  // for the charge amount (original currency preferred). Cache the fetched full
  // message so we can also surface the attachment filename without re-fetching.
  const expected = expectedAmounts(input);
  const fullCache = new Map<string, any>();
  let best = scored[0];
  let amountMatched = false;
  let matchedAmount: number | null = null;

  if (expected.length) {
    // Check the DATE-CLOSEST candidates first: the right receipt sits near the
    // charge date, and the amount then disambiguates among same-vendor receipts
    // (a monthly subscription receipt would otherwise be buried under daily API
    // receipts that score higher). Amount match wins over raw score.
    const byProximity = [...scored]
      .sort((a, b) => a.proximity - b.proximity || b.score - a.score)
      .slice(0, 12);
    for (const cand of byProximity) {
      let full: any;
      try {
        full = await getMessage(cand.msg.id);
      } catch {
        continue; // keep scanning others
      }
      fullCache.set(cand.msg.id, full);
      const amounts = extractAmounts(bodyText(full.payload));
      const hit = expected.find((e) => amounts.some((a) => amountClose(a, e)));
      if (hit != null) {
        best = cand; // closest-date amount match wins
        amountMatched = true;
        matchedAmount = hit;
        break;
      }
    }
  }

  // require-amount routes (Anthropic) issue one receipt per charge that always
  // shows the amount and bill frequently, so a candidate that doesn't carry the
  // charge amount is the wrong receipt — report no match rather than a misleading
  // one. (Google etc. keep the amount in a PDF, so they don't set requireAmount.)
  if (q.route?.requireAmount && expected.length && !amountMatched) {
    const amts = expected.map((e) => e.toFixed(2)).join(" / ");
    const cur = input.localCurrency || input.currency || "";
    return {
      found: false,
      confidence: "none",
      vendor,
      query: usedQuery,
      reason: `${scored.length} ${vendor}-Beleg(e) im Zeitfenster, aber keiner über ${amts} ${cur}.`,
    };
  }

  const from = best.msg.headers["from"] ?? "";
  const subject = best.msg.headers["subject"] ?? "";
  const date = best.msg.headers["date"] ?? "";

  // attachment filename (reuse the cached full message if we already fetched it)
  let attachment: string | null = null;
  try {
    const full = fullCache.get(best.msg.id) ?? (await getMessage(best.msg.id));
    attachment = firstAttachmentName(full.payload);
  } catch {
    /* non-fatal: keep the match without a filename */
  }

  const amountNote = expected.length
    ? amountMatched
      ? ` · Betrag ${matchedAmount?.toFixed(2)} passt`
      : " · Betrag nicht bestätigt"
    : "";

  return {
    found: true,
    confidence: confidenceFor(best.score, amountMatched, !!q.route?.requireAmount && expected.length > 0),
    vendor,
    query: usedQuery,
    message_id: best.msg.id,
    thread_id: best.msg.threadId,
    sender: from,
    subject,
    date,
    attachment_filename: attachment,
    amount_matched: expected.length ? amountMatched : undefined,
    matched_amount: matchedAmount,
    permalink: `https://mail.google.com/mail/u/0/#all/${best.msg.threadId}`,
    reason: `±${Math.round(best.proximity)} Tage zur Buchung, Score ${best.score}${amountNote}.`,
  };
}
