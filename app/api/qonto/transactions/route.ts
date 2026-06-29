import { NextResponse } from "next/server";
import { getTransactions, toErrorResponse } from "@/lib/qonto/server";

export const dynamic = "force-dynamic";

/** Parse "yyyy-MM-dd" as a LOCAL date (avoids UTC day-shift). */
function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const iban = searchParams.get("iban");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    if (!iban || !from || !to) {
      return NextResponse.json(
        { message: "Parameter iban, from und to sind erforderlich.", status: 400 },
        { status: 400 },
      );
    }

    const sortBy = searchParams.get("sort_by") ?? "settled_at:desc";
    const page = Number(searchParams.get("page") ?? "1");
    const perPage = Number(searchParams.get("per_page") ?? "100");

    const data = await getTransactions(
      iban,
      parseLocalDate(from),
      parseLocalDate(to),
      sortBy,
      page,
      perPage,
    );
    return NextResponse.json(data);
  } catch (error) {
    return toErrorResponse(error);
  }
}
