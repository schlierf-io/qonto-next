"use client";

import * as React from "react";
import { AccountSelector } from "@/components/account-selector";
import { DateRangePicker } from "@/components/date-range-picker";
import { TransactionTable } from "@/components/transaction-table";
import { MissingAttachments } from "@/components/missing-attachments";
import type { BankAccount, DateRange } from "@/lib/qonto/types";

export default function Home() {
  const [account, setAccount] = React.useState<BankAccount | null>(null);
  const [dateRange, setDateRange] = React.useState<DateRange | null>(null);

  const handleAccount = React.useCallback(
    (a: BankAccount | null) => setAccount(a),
    [],
  );
  const handleRange = React.useCallback((r: DateRange) => setDateRange(r), []);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Qonto Transaktionen
        </h1>
        {account && (
          <span className="text-sm text-muted-foreground">{account.name}</span>
        )}
      </header>

      <div className="flex flex-wrap gap-4">
        <AccountSelector onAccountSelected={handleAccount} />
        <DateRangePicker onDateRangeSelected={handleRange} />
      </div>

      <TransactionTable account={account} dateRange={dateRange} />

      <MissingAttachments dateRange={dateRange} />
    </main>
  );
}
