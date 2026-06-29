// Ported verbatim from TransactionTableComponent.calculateMissingBalances /
// getSettledBalance. Subtle anchor-based reconstruction in main units — do NOT
// "simplify". Transactions are assumed newest-first (settled_at:desc).

import type { Transaction } from "@/lib/qonto/types";

/**
 * Computes a running settled balance per transaction when the API omits it.
 * Uses a transaction with a known settled_balance_cents as the anchor, or the
 * account's current balance as a fallback anchor.
 */
export function computeBalances(
  transactions: Transaction[],
  accountBalance: number,
): Map<string, number> {
  const balances = new Map<string, number>();
  if (transactions.length === 0) return balances;

  const anchorIndex = transactions.findIndex(
    (tx) =>
      tx.settled_balance_cents !== null &&
      tx.settled_balance_cents !== undefined &&
      !Number.isNaN(tx.settled_balance_cents),
  );

  if (anchorIndex !== -1) {
    const anchorTx = transactions[anchorIndex];
    const anchorBalance = anchorTx.settled_balance_cents / 100;
    balances.set(anchorTx.transaction_id, anchorBalance);

    // Backwards toward newer transactions (lower indices): reverse the op.
    let running = anchorBalance;
    for (let i = anchorIndex - 1; i >= 0; i--) {
      const tx = transactions[i];
      running = tx.side === "credit" ? running + tx.amount : running - tx.amount;
      balances.set(tx.transaction_id, running);
    }

    // Forwards toward older transactions (higher indices).
    running = anchorBalance;
    for (let i = anchorIndex + 1; i < transactions.length; i++) {
      const prevTx = transactions[i - 1];
      const tx = transactions[i];
      const prevBalance = balances.get(prevTx.transaction_id) ?? running;
      running =
        prevTx.side === "credit"
          ? prevBalance - prevTx.amount
          : prevBalance + prevTx.amount;
      balances.set(tx.transaction_id, running);
    }
  } else {
    // No anchor: account balance is the balance AFTER all transactions.
    let running = accountBalance;
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      balances.set(tx.transaction_id, running);
      running =
        tx.side === "credit" ? running - tx.amount : running + tx.amount;
    }
  }

  return balances;
}

/** settled_balance from API if valid, otherwise the pre-computed fallback. */
export function getSettledBalance(
  transaction: Transaction,
  calculated: Map<string, number>,
): number {
  if (
    transaction.settled_balance !== null &&
    transaction.settled_balance !== undefined &&
    !Number.isNaN(transaction.settled_balance)
  ) {
    return transaction.settled_balance;
  }
  const value = calculated.get(transaction.transaction_id);
  if (value !== undefined && !Number.isNaN(value)) return value;
  return 0;
}
