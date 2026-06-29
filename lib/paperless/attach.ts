// Resolve a paperless-ngx match into Qonto: download the document's PDF from
// paperless and upload it to the transaction via the existing Qonto client.
// Unlike the Gmail path (which forwards an email to the receipts inbox because
// the MCP can't download), here we have the bytes, so this is a direct attach.

import { downloadDocument } from "@/lib/paperless/server";
import { uploadAttachment } from "@/lib/qonto/server";

export interface AttachResult {
  attached: boolean;
  transactionId: string;
  documentId: number;
  filename: string;
  bytes: number;
}

export async function attachDocumentToTransaction(
  documentId: number,
  transactionId: string,
): Promise<AttachResult> {
  const { data, filename, mimeType } = await downloadDocument(documentId);
  // Qonto's uploadAttachment takes a web File; an ArrayBuffer is a valid BlobPart.
  const file = new File([data], filename, { type: mimeType || "application/pdf" });
  await uploadAttachment(transactionId, file);
  return {
    attached: true,
    transactionId,
    documentId,
    filename,
    bytes: data.byteLength,
  };
}
