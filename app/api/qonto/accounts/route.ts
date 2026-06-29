import { NextResponse } from "next/server";
import { getAccounts, toErrorResponse } from "@/lib/qonto/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const organization = await getAccounts();
    return NextResponse.json(organization);
  } catch (error) {
    return toErrorResponse(error);
  }
}
