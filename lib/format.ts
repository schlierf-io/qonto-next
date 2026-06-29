// Replaces Angular's CurrencyPipe / DatePipe with framework-agnostic Intl helpers.

const DE_LOCALE = "de-DE";

export function formatCurrency(
  value: number,
  currency: string,
  locale: string = DE_LOCALE,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** dd.MM.yyyy */
export function formatDate(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "-";
  return new Intl.DateTimeFormat(DE_LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/** dd.MM.yyyy HH:mm */
export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "-";
  return new Intl.DateTimeFormat(DE_LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** yyyy-MM-dd using LOCAL date parts (matches the Angular service). */
export function formatISODate(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
