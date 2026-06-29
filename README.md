# qonto-next

Next.js-Portierung der Angular-App „Qonto Transactions" (App Router + shadcn/ui + Tailwind v4).
Migrationsdetails siehe [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md).

## Setup

```bash
cd qonto-next
pnpm install          # oder npm install
cp .env.example .env.local
# QONTO_API_KEY und QONTO_ORG_SLUG eintragen
pnpm dev              # http://localhost:3000
```

Der API-Key bleibt **serverseitig** (`process.env`) und wird über die Route Handler
unter `app/api/qonto/*` verwendet — er landet nie im Browser-Bundle. Damit entfallen
`proxy.conf.json`, `generate-env.js`, `public/env.js` und `window.__env` aus der
Angular-Version.

## Struktur

```
app/
  layout.tsx                      Root-Layout, ThemeProvider, TooltipProvider
  page.tsx                        State (Konto + Zeitraum), komponiert die UI
  globals.css                     Tailwind v4 Tokens + KDE-Akzent + Dark Mode
  api/qonto/
    accounts/route.ts             GET  -> Qonto-Organisation/Konten
    transactions/route.ts         GET  -> Transaktionen (Zeitraum, Pagination)
    transactions/[id]/attachments/route.ts   POST -> Beleg-Upload (multipart-Proxy)
components/
  account-selector.tsx            shadcn Select
  date-range-picker.tsx           react-day-picker v9 + Popover
  transaction-table.tsx           shadcn Table + TanStack Table
  theme-provider.tsx              next-themes (ersetzt KdeThemeService)
  ui/                             shadcn-Primitives
lib/
  qonto/types.ts                  Modelle (1:1 aus der Angular-App)
  qonto/server.ts                 Server-only Qonto-Client (Key, cents->units)
  api.ts                          Client-Fetcher gegen die eigenen /api-Routen
  balance.ts                      Saldo-Rekonstruktion (verbatim portiert)
  format.ts                       Intl-Formatierung (de-DE)
  pdf/statement.ts                Kontoauszug-PDF (jsPDF)
  pdf/receipt.ts                  Einzelbeleg-PDF (jsPDF)
  pdf/download.ts                 Browser-Download-Helper
```

## Noch offen für volle Parität

- Feinschliff von Styling/Edge-Cases gegenüber dem Angular-Material-Original.
- Unit-Tests (das Original hat Karma/Jasmine-Specs) — Empfehlung: Vitest + React Testing Library, vor allem für `lib/balance.ts`.
- Optionale Animationen der Radix-Popovers/-Selects via `tw-animate-css`.
