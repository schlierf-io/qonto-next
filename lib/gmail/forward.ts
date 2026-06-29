// Forward a matched invoice email to the Qonto "receipt by email" inbox so
// Qonto auto-attaches it to the transaction. Builds a real MIME forward
// (original body + all attachments) and sends it via the Gmail API.

import { getMessage, getAttachment, sendRawMessage } from "@/lib/gmail/server";

interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

interface ExtractedAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// base64url (Gmail) -> Buffer
function fromB64Url(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

// walk the payload tree: collect the best body (html > plain) and attachments
function walk(payload: Part): { html?: string; text?: string; attachments: ExtractedAttachment[] } {
  const attachments: ExtractedAttachment[] = [];
  let html: string | undefined;
  let text: string | undefined;

  const stack: Part[] = [payload];
  while (stack.length) {
    const p = stack.shift()!;
    const isAttachment = !!p.filename && !!p.body?.attachmentId;
    if (isAttachment) {
      attachments.push({
        filename: p.filename!,
        mimeType: p.mimeType || "application/octet-stream",
        attachmentId: p.body!.attachmentId!,
      });
    } else if (p.mimeType === "text/html" && p.body?.data && !html) {
      html = fromB64Url(p.body.data).toString("utf8");
    } else if (p.mimeType === "text/plain" && p.body?.data && !text) {
      text = fromB64Url(p.body.data).toString("utf8");
    }
    if (Array.isArray(p.parts)) stack.push(...p.parts);
  }
  return { html, text, attachments };
}

// wrap base64 at 76 chars (RFC 2045)
function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function encodeHeaderWord(value: string): string {
  // RFC 2047 encode non-ASCII subject lines
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface ForwardResult {
  sent: boolean;
  id?: string;
  to: string;
  subject: string;
  attachments: number;
  bytes: number;
}

/**
 * Build the forwarded MIME for `messageId` addressed to `to`.
 * Returns the base64url raw plus metadata (does NOT send).
 */
export async function buildForwardRaw(
  messageId: string,
  to: string,
): Promise<{ raw: string; meta: Omit<ForwardResult, "sent" | "id"> }> {
  const msg = await getMessage(messageId);
  const headers = msg.payload?.headers as { name: string; value: string }[] | undefined;
  const origSubject = header(headers, "Subject");
  const origFrom = header(headers, "From");
  const origDate = header(headers, "Date");

  const { html, text, attachments } = walk(msg.payload);

  // download attachment bytes
  const files: { filename: string; mimeType: string; b64: string }[] = [];
  for (const a of attachments) {
    const data = await getAttachment(messageId, a.attachmentId);
    files.push({ filename: a.filename, mimeType: a.mimeType, b64: fromB64Url(data).toString("base64") });
  }

  const boundary = "qn_" + Buffer.from(messageId).toString("hex").slice(0, 24);
  const subject = origSubject.toLowerCase().startsWith("fwd:") ? origSubject : `Fwd: ${origSubject}`;

  const intro =
    `<p>Weitergeleiteter Beleg (qonto-next).</p>` +
    `<hr><p><b>Von:</b> ${origFrom}<br><b>Datum:</b> ${origDate}<br><b>Betreff:</b> ${origSubject}</p><hr>`;
  const bodyHtml = intro + (html ?? (text ? `<pre>${text}</pre>` : "(kein Textkörper)"));

  const lines: string[] = [];
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${encodeHeaderWord(subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push("");
  // body part (base64 to be encoding-safe)
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(wrap76(Buffer.from(bodyHtml, "utf8").toString("base64")));
  // attachment parts
  for (const f of files) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${f.mimeType}; name="${f.filename}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: attachment; filename="${f.filename}"`);
    lines.push("");
    lines.push(wrap76(f.b64));
  }
  lines.push(`--${boundary}--`);
  lines.push("");

  const mime = lines.join("\r\n");
  const raw = Buffer.from(mime, "utf8").toString("base64url");
  return {
    raw,
    meta: { to, subject, attachments: files.length, bytes: Buffer.byteLength(mime, "utf8") },
  };
}

/** Build and send the forward. Needs the gmail.send scope. */
export async function forwardToQonto(messageId: string, to: string): Promise<ForwardResult> {
  const { raw, meta } = await buildForwardRaw(messageId, to);
  const sent = await sendRawMessage(raw);
  return { sent: true, id: sent.id, ...meta };
}
