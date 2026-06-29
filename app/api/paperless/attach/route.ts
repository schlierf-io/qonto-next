import { NextResponse } from "next/server";
import { attachDocumentToTransaction } from "@/lib/paperless/attach";
import { PaperlessNotConfiguredError, PaperlessApiError } from "@/lib/paperless/server";
import { toErrorResponse } from "@/lib/qonto/server";

export const dynamic = "force-dynamic";

// POST /api/paperless/attach  { documentId: number, transactionId: string }
// Downloads the document's PDF from paperless-ngx and attaches it to the Qonto
// transaction. One-click resolution: no mail forwarding, no manual upload.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const documentId = Number(body?.documentId);
    const transactionId: string | undefined = body?.transactionId;

    if (!Number.isFinite(documentId) || !transactionId) {
      return NextResponse.json(
        { message: "documentId (Zahl) und transactionId sind erforderlich.", status: 400 },
        { status: 400 },
      );
    }

    const result = await attachDocumentToTransaction(documentId, transactionId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PaperlessNotConfiguredError) {
      return NextResponse.json({ message: error.message, status: 503 }, { status: 503 });
    }
    if (error instanceof PaperlessApiError) {
      const status = typeof error.status === "number" ? error.status : 502;
      return NextResponse.json({ message: error.message, status: error.status }, { status });
    }
    // upload-side (Qonto) errors land here
    return toErrorResponse(error);
  }
}
