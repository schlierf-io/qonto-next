// Ported from TransactionTableComponent.generateTransactionPdf().
// Branded single-transaction "Transaktionsbeleg".

import type { BankAccount, Transaction } from "@/lib/qonto/types";
import { formatCurrency, formatDate, formatDateTime, formatISODate } from "@/lib/format";
import { downloadPdf } from "@/lib/pdf/download";

export interface ReceiptParams {
  account: BankAccount | null;
  transaction: Transaction;
  settledBalance: number;
}

export async function exportReceiptPdf({
  account,
  transaction,
  settledBalance,
}: ReceiptParams): Promise<void> {
  const { jsPDF } = await import("jspdf");

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;

  const qontoPurple = { r: 105, g: 65, b: 198 }; // #6941C6
  const qontoDarkPurple = { r: 83, g: 51, b: 158 };

  // ===== HEADER =====
  doc.setFillColor(qontoPurple.r, qontoPurple.g, qontoPurple.b);
  doc.rect(0, 0, pageWidth, 40, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.text("Qonto", 14, 18);

  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.text("Transaktionsbeleg", 14, 30);

  if (account) {
    doc.setFontSize(9);
    doc.text(account.name, pageWidth - 14, 14, { align: "right" });
    doc.setFontSize(8);
    doc.text(`IBAN: ${account.iban}`, pageWidth - 14, 22, { align: "right" });
    if (account.bic) {
      doc.text(`BIC: ${account.bic}`, pageWidth - 14, 30, { align: "right" });
    }
  }

  doc.setTextColor(0, 0, 0);

  let yPos = 52;
  const leftCol = 14;
  const rightCol = 70;
  const lineHeight = 7;
  const sectionSpacing = 12;

  const addDetailRow = (
    label: string,
    value: string | null | undefined,
    isBold = false,
  ) => {
    if (value === null || value === undefined || value === "") return;
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text(label, leftCol, yPos);
    doc.setFont("helvetica", isBold ? "bold" : "normal");
    doc.setTextColor(0, 0, 0);
    doc.text(value, rightCol, yPos);
    yPos += lineHeight;
  };

  const addDetailRowWrapped = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text(label, leftCol, yPos);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
    const lines = doc.splitTextToSize(value, pageWidth - rightCol - 14);
    doc.text(lines, rightCol, yPos);
    yPos += lineHeight * Math.max(1, lines.length);
  };

  const addSectionHeader = (title: string) => {
    yPos += 4;
    doc.setFillColor(qontoPurple.r, qontoPurple.g, qontoPurple.b);
    doc.rect(leftCol, yPos - 4, 3, 12, "F");
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(qontoDarkPurple.r, qontoDarkPurple.g, qontoDarkPurple.b);
    doc.text(title, leftCol + 6, yPos + 4);
    doc.setTextColor(0, 0, 0);
    yPos += sectionSpacing;
    doc.setFontSize(10);
  };

  // ===== DESCRIPTION =====
  addSectionHeader("Beschreibung");
  if (transaction.label) addDetailRowWrapped("Empfänger/Absender:", transaction.label);
  if (
    transaction.clean_counterparty_name &&
    transaction.clean_counterparty_name !== transaction.label
  ) {
    addDetailRow("Gegenpartei:", transaction.clean_counterparty_name);
  }
  if (transaction.reference) addDetailRowWrapped("Referenz:", transaction.reference);
  if (transaction.note) addDetailRowWrapped("Notiz:", transaction.note);
  yPos += 6;

  // ===== AMOUNT =====
  addSectionHeader("Betrag");
  const amount =
    transaction.side === "debit" ? -transaction.amount : transaction.amount;

  doc.setFont("helvetica", "bold");
  doc.setTextColor(80, 80, 80);
  doc.text("Betrag:", leftCol, yPos);
  doc.setFontSize(12);
  if (transaction.side === "credit") doc.setTextColor(39, 174, 96);
  else doc.setTextColor(218, 68, 83);
  doc.text(formatCurrency(amount, transaction.currency), rightCol, yPos);
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  yPos += lineHeight;

  if (transaction.local_currency !== transaction.currency) {
    const localAmount =
      transaction.side === "debit"
        ? -transaction.local_amount
        : transaction.local_amount;
    addDetailRow(
      "Originalbetrag:",
      formatCurrency(
        localAmount,
        transaction.local_currency,
        transaction.local_currency === "USD" ? "en-US" : "de-DE",
      ),
    );
  }

  addDetailRow(
    "Kontostand danach:",
    formatCurrency(settledBalance, transaction.currency),
  );
  yPos += 6;

  // ===== DETAILS =====
  addSectionHeader("Transaktionsdetails");
  addDetailRow("Transaktions-ID:", transaction.transaction_id);
  addDetailRow("Buchungsdatum:", formatDateTime(transaction.settled_at));
  addDetailRow("Ausführungsdatum:", formatDateTime(transaction.emitted_at));
  addDetailRow("Letzte Aktualisierung:", formatDateTime(transaction.updated_at));

  const statusMap: Record<string, string> = {
    completed: "Abgeschlossen",
    pending: "Ausstehend",
    declined: "Abgelehnt",
    reversed: "Storniert",
  };
  addDetailRow(
    "Status:",
    statusMap[transaction.status.toLowerCase()] || transaction.status,
  );

  const operationTypeMap: Record<string, string> = {
    transfer: "Überweisung",
    card: "Kartenzahlung",
    direct_debit: "Lastschrift",
    income: "Einnahme",
    qonto_fee: "Qonto-Gebühr",
    cheque: "Scheck",
    recall: "Rückruf",
    swift_income: "SWIFT-Eingang",
    swift_transfer: "SWIFT-Überweisung",
  };
  addDetailRow(
    "Transaktionsart:",
    operationTypeMap[transaction.operation_type.toLowerCase()] ||
      transaction.operation_type,
  );

  addDetailRow("Art:", transaction.side === "credit" ? "Gutschrift" : "Lastschrift");
  if (transaction.initiator_id) addDetailRow("Initiator-ID:", transaction.initiator_id);

  // ===== VAT =====
  if (transaction.vat_amount !== null && transaction.vat_rate !== null) {
    yPos += 6;
    addSectionHeader("Steuerinformationen");
    addDetailRow("MwSt.-Betrag:", formatCurrency(transaction.vat_amount, transaction.currency));
    addDetailRow("MwSt.-Satz:", `${(transaction.vat_rate * 100).toFixed(2)}%`);
  }

  // ===== ATTACHMENTS =====
  yPos += 6;
  addSectionHeader("Belege & Dokumente");
  const attachmentCount = transaction.attachment_ids.length;
  addDetailRow(
    "Anzahl Belege:",
    attachmentCount > 0 ? `${attachmentCount} Anhang/Anhänge` : "Keine",
  );
  if (attachmentCount > 0) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text("Beleg-IDs:", leftCol, yPos);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(
      transaction.attachment_ids.join(", "),
      pageWidth - rightCol - 14,
    );
    doc.text(lines, rightCol, yPos);
    yPos += lineHeight * Math.max(1, lines.length);
    doc.setFontSize(10);
  }
  addDetailRow("Beleg erforderlich:", transaction.attachment_required ? "Ja" : "Nein");
  if (transaction.attachment_lost) {
    doc.setTextColor(218, 68, 83);
    addDetailRow("Beleg verloren:", "Ja");
    doc.setTextColor(0, 0, 0);
  }

  // ===== CATEGORIES =====
  if (transaction.label_ids && transaction.label_ids.length > 0) {
    yPos += 6;
    addSectionHeader("Kategorien");
    addDetailRow("Anzahl Labels:", `${transaction.label_ids.length}`);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(80, 80, 80);
    doc.text("Label-IDs:", leftCol, yPos);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(
      transaction.label_ids.join(", "),
      pageWidth - rightCol - 14,
    );
    doc.text(lines, rightCol, yPos);
    yPos += lineHeight * Math.max(1, lines.length);
    doc.setFontSize(10);
  }

  // ===== FOOTER =====
  doc.setFillColor(qontoPurple.r, qontoPurple.g, qontoPurple.b);
  doc.rect(0, pageHeight - 25, pageWidth, 25, "F");
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(255, 255, 255);
  doc.text(`Erstellt am: ${formatDateTime(new Date())}`, 14, pageHeight - 14);
  doc.text("Dieses Dokument wurde automatisch generiert.", 14, pageHeight - 8);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("Qonto", pageWidth - 14, pageHeight - 10, { align: "right" });

  const txDate = transaction.settled_at
    ? formatISODate(transaction.settled_at)
    : "unknown";
  const sanitizedLabel = (transaction.label || "Transaktion")
    .replace(/[^a-zA-Z0-9äöüÄÖÜß]/g, "_")
    .substring(0, 30);
  downloadPdf(doc, `Beleg_${txDate}_${sanitizedLabel}.pdf`);
}
