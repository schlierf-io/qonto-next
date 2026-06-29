import { NextResponse } from "next/server";
import { getProfile, GmailNotConfiguredError, GmailApiError } from "@/lib/gmail/server";

export const dynamic = "force-dynamic";

// GET /api/gmail/ping — connectivity check for the Gmail integration.
// 200 { connected, email, messagesTotal } when wired up,
// 503 when credentials are missing, 502 on an upstream Gmail error.
export async function GET() {
  try {
    const profile = await getProfile();
    return NextResponse.json({
      connected: true,
      email: profile.emailAddress,
      messagesTotal: profile.messagesTotal,
    });
  } catch (error) {
    if (error instanceof GmailNotConfiguredError) {
      return NextResponse.json(
        { connected: false, message: error.message },
        { status: 503 },
      );
    }
    if (error instanceof GmailApiError) {
      const status = typeof error.status === "number" ? error.status : 502;
      return NextResponse.json(
        { connected: false, message: error.message, status: error.status },
        { status },
      );
    }
    return NextResponse.json(
      { connected: false, message: "Unbekannter Fehler." },
      { status: 500 },
    );
  }
}
