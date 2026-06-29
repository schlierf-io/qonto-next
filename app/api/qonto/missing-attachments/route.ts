import { NextResponse } from "next/server";
import { getMissingAttachments } from "@/lib/qonto/missing";
import { toErrorResponse } from "@/lib/qonto/server";

export const dynamic = "force-dynamic";

/** Parse "yyyy-MM-dd" as a LOCAL date (avoids UTC day-shift). */
function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

// GET /api/qonto/missing-attachments?from=…&to=…&required_only=1&debit_only=1&account=…
// Returns the cross-account "missing receipt" worklist for the date range.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    if (!from || !to) {
      return NextResponse.json(
        { message: "Parameter from und to sind erforderlich.", status: 400 },
        { status: 400 },
      );
    }

    const report = await getMissingAttachments(
      parseLocalDate(from),
      parseLocalDate(to),
      {
        requiredOnly: searchParams.get("required_only") === "1",
        debitOnly: searchParams.get("debit_only") === "1",
        account: searchParams.get("account") ?? undefined,
      },
    );
    return NextResponse.json(report);
  } catch (error) {
    return toErrorResponse(error);
  }
}
