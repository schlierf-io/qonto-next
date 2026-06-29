"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, fetchAccounts } from "@/lib/api";
import type { BankAccount } from "@/lib/qonto/types";

interface Props {
  onAccountSelected: (account: BankAccount | null) => void;
}

export function AccountSelector({ onAccountSelected }: Props) {
  const [accounts, setAccounts] = React.useState<BankAccount[]>([]);
  const [selectedIban, setSelectedIban] = React.useState<string>("");
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    fetchAccounts()
      .then((all) => {
        if (!active) return;
        // Filter out "Privatentnahme" (matches the Angular component).
        const filtered = all.filter((a) => a.name !== "Privatentnahme");
        setAccounts(filtered);
        if (filtered.length > 0) {
          setSelectedIban(filtered[0].iban);
          onAccountSelected(filtered[0]);
        } else {
          onAccountSelected(null);
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        const status = err instanceof ApiError ? err.status : "?";
        let msg = `Konten konnten nicht geladen werden. Status: ${status}`;
        if (status === 401 || status === 403) {
          msg += " (Authentifizierung fehlgeschlagen)";
        }
        setError(msg);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (iban: string) => {
    setSelectedIban(iban);
    onAccountSelected(accounts.find((a) => a.iban === iban) ?? null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-muted-foreground">Konto</span>
      <div className="flex items-center gap-2">
        <Select
          value={selectedIban}
          onValueChange={handleChange}
          disabled={isLoading || accounts.length === 0}
        >
          <SelectTrigger className="w-[320px]">
            <SelectValue placeholder="Konto auswählen" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.iban} value={a.iban}>
                {a.name} — {a.iban}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isLoading && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
