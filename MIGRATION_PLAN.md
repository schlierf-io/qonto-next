# Migrationsplan: Angular 22 → Next.js 15 + shadcn/ui + Tailwind v4

Ziel: Feature-Parität der Qonto-Transactions-App. Geschätzter Aufwand für einen erfahrenen Dev: **5–8 Arbeitstage** (ohne Test-Rewrite). Dieses Dokument beschreibt das Datei-für-Datei-Mapping, die empfohlene Reihenfolge und die bekannten Fallen. Das `qonto-next/`-Verzeichnis enthält bereits ein lauffähiges Grundgerüst, das diesem Plan folgt.

## Leitprinzipien

1. **Logik unverändert übernehmen.** Saldo-Berechnung, beide PDF-Generatoren und die Cents-Konvertierung sind framework-agnostisch und werden verbatim portiert — nicht neu geschrieben.
2. **Secrets serverseitig.** Der API-Key wandert aus dem Browser in Next.js Route Handlers (`process.env`). Damit entfällt die gesamte `window.__env`-/Proxy-Mechanik, und der Key wird nie mehr ausgeliefert.
3. **State minimal.** Der Datenfluss ist `props down / callbacks up` mit zwei Zustandswerten (Konto + Zeitraum). In React reicht `useState` im Page-Component; kein Redux/Zustand nötig.

## Architektur-Änderungen

| Thema | Angular (heute) | Next.js (neu) |
|---|---|---|
| HTTP zu Qonto | `window.fetch` im Client-Service, Key im Browser | Route Handlers `app/api/qonto/*` rufen Qonto serverseitig auf |
| CORS | `proxy.conf.json` schreibt `/api/qonto`→Qonto um | Route Handlers sind der Proxy; CORS-Problem verschwindet |
| Env/Secrets | `.env`→`generate-env.js`→`public/env.js`→`window.__env`→`config.ts` | `process.env.QONTO_*` direkt im Server-Code |
| Reaktivität | RxJS `Observable`, `from(fetch).pipe(map)` | `async/await`; Client-Fetch via `fetch('/api/...')` |
| Change Detection | Zone.js, `ngOnChanges` | React-Render, `useEffect([deps])` |
| Theme | `KdeThemeService` (Signals + matchMedia) | `next-themes` (`prefers-color-scheme` out of the box) |
| Komponenten | Angular Material | shadcn/ui (Radix) + Tailwind v4 |

## Datei-für-Datei-Mapping

Legende: 🟢 trivialer Port · 🟡 moderate Anpassung · 🔴 Hauptarbeit

| Angular | Next.js | Aufwand | Notiz |
|---|---|---|---|
| `src/app/models/qonto.model.ts` | `lib/qonto/types.ts` | 🟢 | 1:1 kopieren |
| `src/app/services/qonto-api.service.ts` | `lib/qonto/server.ts` + `app/api/qonto/**/route.ts` + `lib/api.ts` | 🟡 | Fetch-Logik + Cents-Konvertierung server­seitig; Client ruft eigene `/api`-Routen |
| `src/app/config.ts` | — | ⚫ entfällt | ersetzt durch `process.env` |
| `scripts/generate-env.js`, `public/env.js` | — | ⚫ entfällt | kein Runtime-Env-Inject mehr |
| `proxy.conf.json` | — | ⚫ entfällt | Route Handlers übernehmen |
| `src/app/interceptors/logging.interceptor.ts` | optional `middleware.ts` / Logging in `server.ts` | 🟢 | niedrige Priorität |
| `src/app/services/kde-theme.service.ts` | `next-themes` + `components/theme-provider.tsx` + Tokens in `globals.css` | 🟡 | KDE-CSS-Variablen übernehmen |
| `src/app/services/pdf-export.service.ts` | `lib/pdf/download.ts` | 🟢 | Browser-Download-Helper |
| `transaction-table` → `exportToPdf()` | `lib/pdf/statement.ts` | 🟡 | jsPDF-Code fast verbatim |
| `transaction-table` → `generateTransactionPdf()` | `lib/pdf/receipt.ts` | 🟡 | jsPDF-Code fast verbatim |
| `transaction-table` → Saldo-Methoden | `lib/balance.ts` | 🟢 | **verbatim portieren + testen** |
| Angular `CurrencyPipe`/`DatePipe` | `lib/format.ts` (Intl) | 🟢 | `de-DE`, USD-Sonderfall |
| `src/app/app.component.*` | `app/page.tsx` (State) + `app/layout.tsx` (Header) | 🟡 | `useState` für Konto+Zeitraum |
| `account-selector.component.*` | `components/account-selector.tsx` | 🟡 | shadcn `Select`, „Privatentnahme"-Filter |
| `date-range-picker.component.*` | `components/date-range-picker.tsx` | 🔴 | `react-day-picker` v9 + `Popover`; Default „Vormonat" |
| `transaction-table.component.*` | `components/transaction-table.tsx` | 🔴 | shadcn `Table` + TanStack Table (Client-Sort, Server-Pagination) |
| `src/styles.scss`, `tailwind.config.js` | `app/globals.css` | 🟡 | Tailwind v4 `@theme`, KDE-Tokens |
| `*.spec.ts` (Karma/Jasmine) | optional Vitest + React Testing Library | 🟡 | nicht im Skelett enthalten |

## Empfohlene Reihenfolge

1. **Scaffold**: Next App Router, Tailwind v4, shadcn-Primitives, `next-themes`. *(im Skelett erledigt)*
2. **Typen + Formatierung**: `types.ts`, `format.ts`. Fundament, blockiert alles andere.
3. **Server-/API-Schicht**: `lib/qonto/server.ts` + drei Route Handlers. Erst mit echtem Key gegen die Live-API testen, bevor UI gebaut wird.
4. **Reine Logik**: `lib/balance.ts`, `lib/pdf/*`. Lässt sich isoliert (mit Unit-Tests) verifizieren.
5. **Account-Selector**: einfachste interaktive Komponente, prüft End-to-End-Fetch-Flow.
6. **Date-Range-Picker**: Datepicker-Parität herstellen.
7. **Transaction-Table**: größter Brocken; Sortierung, Pagination, Upload-States, Export-Buttons.
8. **Page-Komposition + Polish**: Layout/Header, Lade-/Fehlerzustände, deutsche Strings, Theme.
9. **(Optional) Tests** neu in Vitest/RTL.

## Bekannte Fallen

- **Saldo-Rekonstruktion** (`calculateMissingBalances`): anchor-basiert, alles in Cents, Vorwärts-/Rückwärts-Iteration. Verbatim portieren und mit den Originaldaten gegentesten — nicht „aufräumen".
- **Attachment-Upload**: `multipart/form-data` muss durch einen Route Handler geproxiet werden (Browser kann den Key nicht halten). `X-Qonto-Idempotency-Key`-Header mitgeben. Next-Route-Handler bekommen `FormData` via `await request.formData()`; an Qonto mit `fetch` + neuem `FormData` weiterreichen. Fummeligster Teil.
- **`params` ist ein Promise** (Next 15): in `app/api/qonto/transactions/[id]/attachments/route.ts` `const { id } = await params`.
- **Datums-Offset**: der Service addiert für `settled_at_to` einen Tag (inklusive Enddatum). Beim Port beibehalten, sonst fehlt der letzte Tag.
- **Datepicker-UX**: Material-Range-Picker (zwei Felder, ein Kalender) vs. `react-day-picker` v9 (`mode="range"`). Nicht pixelgleich; v9-API beachten (`Chevron` statt `IconLeft/IconRight`).
- **jsPDF ist Client-only**: PDF-Generierung + Download in `"use client"`-Code, da `Blob`/`<a download>` Browser-APIs sind.
- **Logo-Bilder**: `next/image` braucht `remotePatterns` (in `next.config.ts` gesetzt) — oder einfach natives `<img>` verwenden.
- **Locale**: USD-Beträge mit `en-US`, alles andere `de-DE` (wie im Original).

## Was wegfällt

`config.ts`, `scripts/generate-env.js`, `public/env.js`, `window.__env`, `proxy.conf.json`, Zone.js, RxJS, Angular Material. Netto weniger Konfigurations-Overhead und ein Sicherheitsgewinn (Key nicht mehr im Browser-Bundle).

## Skelett-Status

Im `qonto-next/`-Verzeichnis sind bereits enthalten: Projekt-Config, shadcn-Primitives, Theme-Provider, Typen, Formatierung, Server-/API-Schicht (alle drei Routen inkl. Upload-Proxy), Saldo-Logik, beide PDF-Generatoren sowie funktionsfähige Versionen von Account-Selector, Date-Range-Picker und Transaction-Table. Setup-Schritte stehen in `README.md`. Offen für volle Parität: Feinschliff von Styling/Edge-Cases und der optionale Test-Rewrite.
