// SERVER-ONLY paperless-ngx client. Holds the API token (process.env) and talks
// to a paperless-ngx instance's REST API directly via fetch — no SDK, mirroring
// the zero-dep style of the Qonto and Gmail clients. The token never reaches the
// browser; only the /api/paperless/* route handlers call this.
//
// Required env (server-side, .env):
//   PAPERLESS_URL    base URL of the instance, e.g. https://paperless.example.com
//                    (no trailing /api — the client appends it)
//   PAPERLESS_TOKEN  an API token (paperless-ngx: Settings → "My Profile" →
//                    API Auth Token, or POST /api/token/)
// Auth is a single header: `Authorization: Token <token>`.
// Verify with: GET /api/paperless/ping

export class PaperlessNotConfiguredError extends Error {
  constructor(message = "paperless-ngx ist nicht konfiguriert.") {
    super(message);
    this.name = "PaperlessNotConfiguredError";
  }
}

export class PaperlessApiError extends Error {
  status: number | string;
  data?: unknown;
  constructor(message: string, status: number | string, data?: unknown) {
    super(message);
    this.name = "PaperlessApiError";
    this.status = status;
    this.data = data;
  }
}

function creds(): { base: string; token: string } {
  const rawUrl = process.env.PAPERLESS_URL;
  const token = process.env.PAPERLESS_TOKEN;
  if (!rawUrl || !token) {
    throw new PaperlessNotConfiguredError(
      "Setze PAPERLESS_URL und PAPERLESS_TOKEN in .env (paperless-ngx → Einstellungen → API-Token).",
    );
  }
  // normalise: drop trailing slashes and a trailing /api if the user included it
  const base = rawUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  return { base, token };
}

/** Public base URL of the configured instance ("" when unconfigured). */
export function instanceBase(): string {
  try {
    return creds().base;
  } catch {
    return "";
  }
}

/** Deep link into the paperless web UI for one document. */
export function documentPermalink(id: number): string {
  const base = instanceBase();
  return base ? `${base}/documents/${id}/details` : "";
}

async function pget(path: string, params?: Record<string, string>): Promise<any> {
  const { base, token } = creds();
  const url = new URL(`${base}/api${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new PaperlessApiError(
      "Netzwerkfehler bei der Verbindung zu paperless-ngx.",
      "Network Error",
    );
  }
  if (!res.ok) {
    let data: any;
    try { data = await res.json(); } catch { data = { detail: res.statusText }; }
    throw new PaperlessApiError(
      data?.detail ?? `paperless API Fehler ${res.status}`,
      res.status,
      data,
    );
  }
  return res.json();
}

export interface PaperlessDocument {
  id: number;
  title: string;
  correspondent: number | null;
  document_type?: number | null;
  created: string; // ISO datetime (the document's own date)
  added: string; // ISO datetime (when it entered paperless)
  original_file_name: string | null;
  archived_file_name: string | null;
  mime_type?: string;
  // present on full-text (?query=) results
  __search_hit__?: { score?: number; rank?: number; highlights?: string };
}

interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface PaperlessStatus {
  host: string;
  documentsTotal: number;
}

/** Cheapest connectivity + auth check: returns the host and total doc count. */
export async function getStatus(): Promise<PaperlessStatus> {
  const data = (await pget("/documents/", { page_size: "1" })) as Paginated<PaperlessDocument>;
  return { host: instanceBase(), documentsTotal: data.count ?? 0 };
}

// only the fields we score/display — keeps the list payload small (paperless
// otherwise returns each document's full OCR `content`).
const LIST_FIELDS = "id,title,correspondent,created,added,original_file_name,archived_file_name,mime_type";

/**
 * Full-text document search (paperless whoosh index, ranked by relevance).
 * NB: the whoosh `created:[…]` date DSL is unreliable inside `?query=` (it does
 * not hard-filter), so callers must enforce any date window themselves — see
 * lib/paperless/match.ts. Pass just the vendor here.
 */
export async function searchDocuments(query: string, max = 40): Promise<PaperlessDocument[]> {
  const data = (await pget("/documents/", {
    query,
    page_size: String(max),
    fields: LIST_FIELDS,
  })) as Paginated<PaperlessDocument>;
  return data.results ?? [];
}

/** Full document record. */
export async function getDocument(id: number): Promise<PaperlessDocument> {
  return pget(`/documents/${id}/`) as Promise<PaperlessDocument>;
}

// --- correspondents: resolve numeric ids to names, cached in module scope -----
let correspondentCache: Map<number, string> | null = null;

async function loadCorrespondents(): Promise<Map<number, string>> {
  if (correspondentCache) return correspondentCache;
  const map = new Map<number, string>();
  let path: string | null = "/correspondents/";
  let params: Record<string, string> | undefined = { page_size: "250" };
  // follow pagination (usually a single page)
  for (let guard = 0; path && guard < 20; guard++) {
    const data = (await pget(path, params)) as Paginated<{ id: number; name: string }>;
    for (const c of data.results ?? []) map.set(c.id, c.name);
    if (!data.next) break;
    // `next` is an absolute URL; reduce it back to a path + reuse no extra params
    try {
      const u = new URL(data.next);
      path = u.pathname.replace(/^\/api/, "");
      params = Object.fromEntries(u.searchParams.entries());
    } catch {
      break;
    }
  }
  correspondentCache = map;
  return map;
}

/** Human name for a correspondent id (null when unknown / unset). */
export async function getCorrespondentName(id: number | null | undefined): Promise<string | null> {
  if (id == null) return null;
  const map = await loadCorrespondents();
  return map.get(id) ?? null;
}

export interface DownloadedDocument {
  data: ArrayBuffer;
  filename: string;
  mimeType: string;
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  // RFC 5987: filename*=UTF-8''name.pdf  (preferred, may be percent-encoded)
  const star = disposition.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { return star[1].trim(); }
  }
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

/**
 * Download a document's file bytes. By default returns the archived (OCR'd) PDF
 * paperless serves from /download/, falling back to the original upload.
 */
export async function downloadDocument(
  id: number,
  opts?: { original?: boolean },
): Promise<DownloadedDocument> {
  const { base, token } = creds();
  const url = new URL(`${base}/api/documents/${id}/download/`);
  if (opts?.original) url.searchParams.set("original", "true");
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
      cache: "no-store",
    });
  } catch {
    throw new PaperlessApiError("Netzwerkfehler beim Download aus paperless-ngx.", "Network Error");
  }
  if (!res.ok) {
    throw new PaperlessApiError(`Download fehlgeschlagen (${res.status}).`, res.status);
  }
  const data = await res.arrayBuffer();
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/pdf";
  const filename =
    filenameFromDisposition(res.headers.get("content-disposition")) || `paperless-${id}.pdf`;
  return { data, filename, mimeType };
}
