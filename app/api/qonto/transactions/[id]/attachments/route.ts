import { NextResponse } from "next/server";
import { uploadAttachment, toErrorResponse } from "@/lib/qonto/server";

export const dynamic = "force-dynamic";

// Proxies a multipart PDF upload to Qonto. The browser posts to this route
// (no credentials); the server attaches the auth header + idempotency key.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params; // Next 15: params is async
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { message: "Keine Datei übermittelt.", status: 400 },
        { status: 400 },
      );
    }

    await uploadAttachment(id, file);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
