// Match ONE missing-attachment transaction to its invoice/receipt email.
// Server-side, deterministic (no LLM): build the Gmail query, search, score the
// candidates by sender/subject signals + date proximity, and return the best.

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
  permalink?: string;
  reason: string;
}

export interface MatchInput {
  counterparty: string;
  date: string; // YYYY-MM-DD
  amount?: number;
  beforeDays?: number;
  afterDays?: number;
  selfEmail?: string; // exclude the user's own forwarded copies
}

const RECEIPT_KW =
  /(receipt|invoice|rechnung|beleg|quittung|zahlung|payment|order|bestell|buchungsbest|auftrag)/i;
// strong "this is a billing mailbox" signal (local part of the sender address)
const BILLING_SENDER = /(invoice|receipts?|billing|statements?|rechnung|payments?)/i;
const DUNNING_KW = /(mahnung|offene forderung|zahlungserinnerung|inkasso|overdue|past due)/i;
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

function confidenceFor(s: Scored): GmailMatch["confidence"] {
  if (s.score >= 5) return "high";
  if (s.score >= 3) return "medium";
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

  // tight (must have an attachment) first, then loosen
  let usedQuery = q.tight;
  let fromTight = true;
  let candidates = await searchMessages(q.tight, 10);
  if (!candidates.length) {
    usedQuery = q.loose;
    fromTight = false;
    candidates = await searchMessages(q.loose, 10);
  }

  const scored = candidates
    .map((m) => scoreCandidate(m, vendor, input.date, fromTight, input.selfEmail))
    .filter((s): s is Scored => s !== null && s.score >= 3)
    .sort((a, b) => b.score - a.score || a.proximity - b.proximity);

  const best = scored[0];
  if (!best) {
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

  const from = best.msg.headers["from"] ?? "";
  const subject = best.msg.headers["subject"] ?? "";
  const date = best.msg.headers["date"] ?? "";

  // fetch the full message once to surface the attachment filename
  let attachment: string | null = null;
  try {
    const full = await getMessage(best.msg.id);
    attachment = firstAttachmentName(full.payload);
  } catch {
    /* non-fatal: keep the match without a filename */
  }

  return {
    found: true,
    confidence: confidenceFor(best),
    vendor,
    query: usedQuery,
    message_id: best.msg.id,
    thread_id: best.msg.threadId,
    sender: from,
    subject,
    date,
    attachment_filename: attachment,
    permalink: `https://mail.google.com/mail/u/0/#all/${best.msg.threadId}`,
    reason: `±${Math.round(best.proximity)} Tage zur Buchung, Score ${best.score}.`,
  };
}
