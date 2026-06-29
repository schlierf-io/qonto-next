// Ported from TransactionTableComponent.exportToPdf().
// `transactions` must arrive already sorted in display order.

import type { BankAccount, DateRange, Transaction } from "@/lib/qonto/types";
import { formatCurrency, formatDate } from "@/lib/format";
import { downloadPdf } from "@/lib/pdf/download";

export interface StatementParams {
  account: BankAccount;
  dateRange: DateRange;
  transactions: Transaction[];
  startBalance: number | null;
  endBalance: number | null;
  balanceCurrency: string | null;
  getBalance: (tx: Transaction, index: number) => number;
}

export async function exportStatementPdf({
  account,
  dateRange,
  transactions,
  startBalance,
  endBalance,
  balanceCurrency,
  getBalance,
}: StatementParams): Promise<void> {
  if (!transactions.length) return;

  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF();

  const startDateStr = formatDate(dateRange.start);
  const endDateStr = formatDate(dateRange.end);

  doc.setFontSize(16);
  doc.text(`${account.name} (${account.iban})`, 14, 20);
  doc.setFontSize(12);
  doc.text(`Zeitraum: ${startDateStr} - ${endDateStr}`, 14, 30);

  const currency = balanceCurrency || "EUR";
  doc.text(
    `Startsaldo: ${startBalance !== null ? formatCurrency(startBalance, currency) : "-"}`,
    14,
    40,
  );
  doc.text(
    `Endsaldo: ${endBalance !== null ? formatCurrency(endBalance, currency) : "-"}`,
    14,
    50,
  );

  const tableRows: string[][] = [];
  transactions.forEach((transaction, index) => {
    const date = formatDate(transaction.settled_at);

    let description = transaction.label || "";
    if (transaction.reference) description += "\n" + transaction.reference;
    if (transaction.note) description += "\n" + transaction.note;

    const amount =
      transaction.side === "debit" ? -transaction.amount : transaction.amount;
    let amountStr = formatCurrency(amount, transaction.currency);
    if (transaction.local_currency === "USD") {
      const usdAmount =
        transaction.side === "debit"
          ? -transaction.local_amount
          : transaction.local_amount;
      amountStr += ` (${formatCurrency(usdAmount, "USD", "en-US")})`;
    }

    const balanceStr = formatCurrency(getBalance(transaction, index), currency);
    tableRows.push([date, description, amountStr, balanceStr]);
  });

  autoTable(doc, {
    head: [["Datum", "Beschreibung", "Betrag", "Kontostand"]],
    body: tableRows,
    startY: 60,
    styles: { fontSize: 9, cellPadding: 3, lineColor: [0, 0, 0], lineWidth: 0.1 },
    columnStyles: {
      0: { cellWidth: 25 },
      1: { cellWidth: "auto" },
      2: { cellWidth: 30, halign: "right" },
      3: { cellWidth: 30, halign: "right" },
    },
    headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [240, 240, 240] },
    didParseCell: (data: any) => {
      if (
        data.column.index === 2 &&
        data.cell.text[0] &&
        data.cell.text[0].toString().includes("-")
      ) {
        data.cell.styles.textColor = [231, 76, 60]; // red for negatives
      }
    },
  });

  const fileName = `Kontoauszug_${account.name.replace(/\s+/g, "_")}_${startDateStr}-${endDateStr}.pdf`;
  downloadPdf(doc, fileName);
}
