import { NextResponse } from "next/server";
import { buildForwardRaw, forwardToQonto } from "@/lib/gmail/forward";
import { GmailNotConfiguredError, GmailApiError } from "@/lib/gmail/server";

export const dynamic = "force-dynamic";

function receiptsInbox(): string | null {
  const v = process.env.QONTO_RECEIPTS_INBOX;
  if (!v || v.includes("xxxx") || !v.includes("@")) return null;
  return v;
}

// POST /api/gmail/forward  { messageId: string, dry?: boolean }
// Forwards the matched invoice email to the Qonto receipts inbox so Qonto
// auto-attaches it. dry:true builds the MIME and returns metadata without sending.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const messageId: string | undefined = body?.messageId;
    const dry: boolean = body?.dry === true;

    if (!messageId) {
      return NextResponse.json({ message: "messageId fehlt.", status: 400 }, { status: 400 });
    }
    const to = receiptsInbox();
    if (!to) {
      return NextResponse.json(
        { message: "QONTO_RECEIPTS_INBOX ist nicht gesetzt (Qonto → Beleg per E-Mail importieren).", status: 400 },
        { status: 400 },
      );
    }

    if (dry) {
      const { meta } = await buildForwardRaw(messageId, to);
      return NextResponse.json({ sent: false, ...meta });
    }

    const result = await forwardToQonto(messageId, to);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof GmailNotConfiguredError) {
      return NextResponse.json({ message: error.message, status: 503 }, { status: 503 });
    }
    if (error instanceof GmailApiError) {
      const status = typeof error.status === "number" ? error.status : 502;
      const message =
        status === 403
          ? "Gmail send-Scope fehlt — bitte `node scripts/gmail-auth.mjs` erneut ausführen und Token aktualisieren."
          : error.message;
      return NextResponse.json({ message, status: error.status }, { status });
    }
    return NextResponse.json({ message: "Interner Serverfehler." }, { status: 500 });
  }
}
