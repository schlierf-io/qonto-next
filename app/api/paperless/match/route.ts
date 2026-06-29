import { NextResponse } from "next/server";
import { matchTransaction } from "@/lib/paperless/match";
import { PaperlessNotConfiguredError, PaperlessApiError } from "@/lib/paperless/server";

export const dynamic = "force-dynamic";

// GET /api/paperless/match?counterparty=…&date=YYYY-MM-DD&amount=…&before=10&after=5
// Returns the best paperless-ngx invoice/receipt document for one transaction.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const counterparty = searchParams.get("counterparty");
    const date = searchParams.get("date");

    if (!counterparty || !date) {
      return NextResponse.json(
        { message: "Parameter counterparty und date sind erforderlich.", status: 400 },
        { status: 400 },
      );
    }

    const amount = searchParams.get("amount");
    const before = searchParams.get("before");
    const after = searchParams.get("after");

    const match = await matchTransaction({
      counterparty,
      date,
      amount: amount != null ? Number(amount) : undefined,
      beforeDays: before != null ? Number(before) : undefined,
      afterDays: after != null ? Number(after) : undefined,
    });
    return NextResponse.json(match);
  } catch (error) {
    if (error instanceof PaperlessNotConfiguredError) {
      return NextResponse.json({ message: error.message, status: 503 }, { status: 503 });
    }
    if (error instanceof PaperlessApiError) {
      const status = typeof error.status === "number" ? error.status : 502;
      return NextResponse.json({ message: error.message, status: error.status }, { status });
    }
    return NextResponse.json({ message: "Interner Serverfehler." }, { status: 500 });
  }
}
