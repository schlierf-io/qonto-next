import type jsPDF from "jspdf";

/** Browser download of a generated jsPDF doc (replaces PdfExportService). */
export function downloadPdf(doc: jsPDF, fileName: string): void {
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
