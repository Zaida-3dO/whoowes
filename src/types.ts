export interface Share {
  participant: string;
  /** Percentage of the expense (0-100). Exactly one of pct/amount per share; all shares in an expense use the same mode. */
  pct?: string;
  /** Fixed amount in the expense's currency. */
  amount?: string;
}

export interface ExpenseEvent {
  kind: "expense";
  id: string;
  date: string;
  description: string;
  amount: string;
  currency: string;
  paid_by: string;
  shares: Share[];
  /** Free-text context for the entry: caveats, what's provisional, why it's split this way. */
  note?: string;
}

export interface SettlementEvent {
  kind: "settlement";
  id: string;
  date: string;
  amount: string;
  currency: string;
  from: string;
  to: string;
  note?: string;
}

export interface ConversionEvent {
  kind: "conversion";
  id: string;
  date: string;
  from_amount: string;
  from_currency: string;
  to_amount: string;
  to_currency: string;
  note?: string;
}

export interface RateEvent {
  kind: "rate";
  id: string;
  date: string;
  currency: string;
  /** Units of this currency per 1 unit of the tab's base currency. Absent = clear the declaration and fall back to the conversions average. */
  foreign_per_base?: string;
  note?: string;
}

export type TabEvent = ExpenseEvent | SettlementEvent | ConversionEvent | RateEvent;

export interface Tab {
  id: string;
  name: string;
  base_currency: string;
  status: "open" | "closed";
  created_at: string;
  events: TabEvent[];
}

export interface Ledger {
  participants: string[];
  tabs: Tab[];
}

export class LedgerError extends Error {}
