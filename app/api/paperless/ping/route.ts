import { NextResponse } from "next/server";
import { getStatus, PaperlessNotConfiguredError, PaperlessApiError } from "@/lib/paperless/server";

export const dynamic = "force-dynamic";

// GET /api/paperless/ping — connectivity check for the paperless-ngx integration.
// 200 { connected, host, documentsTotal } when wired up,
// 503 when credentials are missing, 502 on an upstream paperless error.
export async function GET() {
  try {
    const status = await getStatus();
    return NextResponse.json({
      connected: true,
      host: status.host,
      documentsTotal: status.documentsTotal,
    });
  } catch (error) {
    if (error instanceof PaperlessNotConfiguredError) {
      return NextResponse.json({ connected: false, message: error.message }, { status: 503 });
    }
    if (error instanceof PaperlessApiError) {
      const status = typeof error.status === "number" ? error.status : 502;
      return NextResponse.json(
        { connected: false, message: error.message, status: error.status },
        { status },
      );
    }
    return NextResponse.json({ connected: false, message: "Unbekannter Fehler." }, { status: 500 });
  }
}
