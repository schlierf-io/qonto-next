// SERVER-ONLY, READ-ONLY Gmail client. Uses an OAuth2 refresh token to mint
// short-lived access tokens and calls the Gmail REST API directly via fetch —
// no googleapis dependency (mirrors the zero-dep style of the Qonto client).
//
// Required scope: https://www.googleapis.com/auth/gmail.readonly
// Required env (server-side, .env): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_REFRESH_TOKEN. Obtain the refresh token once with
//   node scripts/gmail-auth.mjs
// The Gmail query syntax here is identical to what the invoice-fetcher driver's
// `--gmail` mode emits, so those queries plug straight in.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailNotConfiguredError extends Error {
  constructor(message = "Gmail is not configured.") {
    super(message);
    this.name = "GmailNotConfiguredError";
  }
}

export class GmailApiError extends Error {
  status: number | string;
  data?: unknown;
  constructor(message: string, status: number | string, data?: unknown) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.data = data;
  }
}

function creds() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new GmailNotConfiguredError(
      "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN in .env (run `node scripts/gmail-auth.mjs` once).",
    );
  }
  return { clientId, clientSecret, refreshToken };
}

// cache the access token in module scope until shortly before it expires
let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const { clientId, clientSecret, refreshToken } = creds();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GmailApiError("Gmail token refresh failed.", res.status, text);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

async function gget(path: string, params?: Record<string, string>): Promise<any> {
  const token = await accessToken();
  const url = new URL(`${GMAIL_BASE}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    let data: any;
    try { data = await res.json(); } catch { data = { message: res.statusText }; }
    throw new GmailApiError(
      data?.error?.message ?? `Gmail API error ${res.status}`,
      res.status,
      data,
    );
  }
  return res.json();
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
}

/** The connected mailbox — also the cheapest connectivity check. */
export async function getProfile(): Promise<GmailProfile> {
  return gget("/profile");
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  snippet?: string;
  headers: Record<string, string>;
}

/** Search messages with Gmail `q` syntax; returns lightweight metadata. */
export async function searchMessages(q: string, max = 10): Promise<GmailMessageMeta[]> {
  const list = await gget("/messages", { q, maxResults: String(max) });
  const ids: { id: string; threadId: string }[] = list.messages ?? [];
  const out: GmailMessageMeta[] = [];
  for (const { id } of ids) {
    const msg = await gget(`/messages/${id}`, {
      format: "metadata",
      // metadataHeaders repeats; URLSearchParams can't, so request a sensible default set
    });
    const headers: Record<string, string> = {};
    for (const h of (msg.payload?.headers ?? []) as GmailHeader[]) {
      headers[h.name.toLowerCase()] = h.value;
    }
    out.push({ id: msg.id, threadId: msg.threadId, snippet: msg.snippet, headers });
  }
  return out;
}

/** Full message (use to read attachment metadata / body). */
export async function getMessage(id: string): Promise<any> {
  return gget(`/messages/${id}`, { format: "full" });
}

/** Download one attachment's bytes (base64url). */
export async function getAttachment(messageId: string, attachmentId: string): Promise<string> {
  const data = await gget(`/messages/${messageId}/attachments/${attachmentId}`);
  return data.data as string; // base64url-encoded
}

/** Send a raw RFC822 message (base64url-encoded). Needs the gmail.send scope. */
export async function sendRawMessage(
  rawBase64Url: string,
): Promise<{ id: string; threadId: string }> {
  const token = await accessToken();
  const res = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: rawBase64Url }),
    cache: "no-store",
  });
  if (!res.ok) {
    let data: any;
    try { data = await res.json(); } catch { data = { message: res.statusText }; }
    throw new GmailApiError(
      data?.error?.message ?? `Gmail send error ${res.status}`,
      res.status,
      data,
    );
  }
  return res.json();
}
