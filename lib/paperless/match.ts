// Match ONE missing-attachment transaction to its invoice/receipt document in
// paperless-ngx. Server-side, deterministic (no LLM): build the full-text query,
// search the whoosh index, score candidates by correspondent/title/filename +
// date proximity, and return the best.
//
// paperless is a curated document archive (low noise vs. an inbox), so a vendor
// hit is already a strong signal; we still require a structured match
// (correspondent, title or filename) so a vendor merely mentioned in some other
// document's OCR text does not produce a false positive.

import {
  documentPermalink,
  getCorrespondentName,
  searchDocuments,
  type PaperlessDocument,
} from "@/lib/paperless/server";
import { buildPaperlessQuery } from "@/lib/paperless/query";

export interface PaperlessMatch {
  found: boolean;
  confidence: "high" | "medium" | "low" | "none";
  vendor: string;
  query: string;
  document_id?: number;
  title?: string;
  correspondent?: string | null;
  created?: string; // YYYY-MM-DD (the document's own date)
  original_file_name?: string | null;
  permalink?: string;
  reason: string;
}

export interface MatchInput {
  counterparty: string;
  date: string; // YYYY-MM-DD
  amount?: number; // unused for matching (kept for API symmetry with Gmail)
  beforeDays?: number;
  afterDays?: number;
}

function daysApart(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 999;
  return Math.abs(a - b) / 86_400_000;
}

interface Scored {
  doc: PaperlessDocument;
  correspondent: string | null;
  score: number;
  proximity: number;
}

function scoreCandidate(
  doc: PaperlessDocument,
  correspondent: string | null,
  vendor: string,
  chargeDate: string,
): Scored {
  const tokens = vendor.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const has = (s: string | null | undefined) =>
    !!s && tokens.some((t) => s.toLowerCase().includes(t));

  let score = 0;
  if (has(correspondent)) score += 3; // paperless correspondent == the issuer
  if (has(doc.title)) score += 2;
  if (has(doc.original_file_name)) score += 1;

  return { doc, correspondent, score, proximity: daysApart(chargeDate, doc.created) };
}

function confidenceFor(
  score: number,
  proximity: number,
  searchWindow: number,
): PaperlessMatch["confidence"] {
  if (score >= 3 && proximity <= searchWindow) return "high";
  if (score >= 2) return "medium";
  return "low";
}

async function scoreAll(
  docs: PaperlessDocument[],
  vendor: string,
  chargeDate: string,
): Promise<Scored[]> {
  const out: Scored[] = [];
  for (const doc of docs) {
    const correspondent = await getCorrespondentName(doc.correspondent);
    out.push(scoreCandidate(doc, correspondent, vendor, chargeDate));
  }
  return out.sort((a, b) => b.score - a.score || a.proximity - b.proximity);
}

export async function matchTransaction(input: MatchInput): Promise<PaperlessMatch> {
  const beforeDays = input.beforeDays ?? 10;
  const afterDays = input.afterDays ?? 5;
  const q = buildPaperlessQuery(input.counterparty, input.date, beforeDays, afterDays);
  const vendor = q.vendor;
  if (!vendor) {
    return { found: false, confidence: "none", vendor, query: "", reason: "Kein Händlername ableitbar." };
  }

  // Search by vendor (phrase first, then loosen). The whoosh `created:[…]` DSL
  // does NOT hard-filter via ?query=, so we enforce the date window in code.
  let usedQuery = q.phrase;
  let docs = await searchDocuments(q.phrase);
  if (!docs.length && q.terms && q.terms !== q.phrase) {
    usedQuery = q.terms;
    docs = await searchDocuments(q.terms);
  }

  // acceptance window around the charge (a little wider than the search window,
  // since a document's date can precede the charge / be the filing date).
  const windowDays = beforeDays + afterDays + 21;
  const scored = await scoreAll(docs, vendor, input.date);
  const inWindow = scored.filter((s) => s.proximity <= windowDays);
  const best = inWindow.find((s) => s.score >= 2); // need a structured signal, not just OCR content

  if (!best) {
    const near = scored.filter((s) => s.score >= 2).length;
    return {
      found: false,
      confidence: "none",
      vendor,
      query: usedQuery,
      reason: docs.length
        ? near
          ? `${near} Dokument(e) zu „${vendor}“, aber keins im ±${windowDays}-Tage-Fenster der Buchung.`
          : `Dokumente zu „${vendor}“ gefunden, aber keins sieht eindeutig nach dessen Rechnung aus.`
        : `Kein Dokument zu „${vendor}“ gefunden.`,
    };
  }

  const created = (best.doc.created || "").slice(0, 10);
  const corrPart = best.correspondent ? ` · Korrespondent „${best.correspondent}“` : "";
  return {
    found: true,
    confidence: confidenceFor(best.score, best.proximity, beforeDays + afterDays),
    vendor,
    query: usedQuery,
    document_id: best.doc.id,
    title: best.doc.title,
    correspondent: best.correspondent,
    created,
    original_file_name: best.doc.original_file_name,
    permalink: documentPermalink(best.doc.id),
    reason: `±${Math.round(best.proximity)} Tage zur Buchung${corrPart} · Score ${best.score}.`,
  };
}
