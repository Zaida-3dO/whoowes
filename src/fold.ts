import { Decimal } from "decimal.js";
import { LedgerError, Share, Tab, TabEvent } from "./types.js";

Decimal.set({ precision: 40 });

export interface RateState {
  /** Running totals per foreign currency from real conversions: base spent vs foreign received. */
  conversions: Map<string, { base: Decimal; foreign: Decimal }>;
  /** Manually declared rates, as units of foreign per 1 base. Latest declaration wins; overrides conversions. */
  declared: Map<string, Decimal>;
}

export interface FoldResult {
  rates: RateState;
  /** participant -> net position in base currency (positive = is owed money) */
  balances: Map<string, Decimal>;
  /** participant -> currency -> raw amount that cannot be valued (no declared rate and no conversion yet) */
  unvalued: Map<string, Map<string, Decimal>>;
  /** settlement event id -> base value locked at the rate in force when it happened */
  settlementValues: Map<string, Decimal>;
}

export function shareAmount(total: Decimal, share: Share): Decimal {
  if (share.pct !== undefined) return total.times(share.pct).div(100);
  return new Decimal(share.amount!);
}

/** Base-per-foreign rate for a currency: a declared rate if one is in force, else the conversions average. */
export function effectiveRate(
  rates: RateState,
  currency: string
): { rate: Decimal; source: "declared" | "conversions" } | undefined {
  const declared = rates.declared.get(currency);
  if (declared !== undefined) return { rate: new Decimal(1).div(declared), source: "declared" };
  const r = rates.conversions.get(currency);
  if (!r || r.foreign.isZero()) return undefined;
  return { rate: r.base.div(r.foreign), source: "conversions" };
}

function valueIn(base: string, rates: RateState, amount: Decimal, currency: string): Decimal {
  if (currency === base) return amount;
  const eff = effectiveRate(rates, currency);
  if (eff === undefined) {
    throw new LedgerError(
      `no rate available for ${currency}; add a conversion or declare a rate first`
    );
  }
  return amount.times(eff.rate);
}

export function foldTab(tab: Tab): FoldResult {
  const base = tab.base_currency;
  const rates: RateState = { conversions: new Map(), declared: new Map() };
  const locked = new Map<string, Decimal>();
  const floating = new Map<string, Map<string, Decimal>>();
  const settlementValues = new Map<string, Decimal>();

  const bump = (m: Map<string, Decimal>, k: string, d: Decimal) =>
    m.set(k, (m.get(k) ?? new Decimal(0)).plus(d));
  const bumpFloating = (participant: string, currency: string, d: Decimal) => {
    let byCcy = floating.get(participant);
    if (!byCcy) {
      byCcy = new Map();
      floating.set(participant, byCcy);
    }
    bump(byCcy, currency, d);
  };

  for (const ev of tab.events) {
    switch (ev.kind) {
      case "conversion": {
        const toBase = ev.to_currency === base;
        const foreignCcy = toBase ? ev.from_currency : ev.to_currency;
        const baseAmt = new Decimal(toBase ? ev.to_amount : ev.from_amount);
        const foreignAmt = new Decimal(toBase ? ev.from_amount : ev.to_amount);
        const r = rates.conversions.get(foreignCcy) ?? { base: new Decimal(0), foreign: new Decimal(0) };
        rates.conversions.set(foreignCcy, { base: r.base.plus(baseAmt), foreign: r.foreign.plus(foreignAmt) });
        break;
      }
      case "rate": {
        if (ev.foreign_per_base !== undefined) {
          rates.declared.set(ev.currency, new Decimal(ev.foreign_per_base));
        } else {
          rates.declared.delete(ev.currency);
        }
        break;
      }
      case "settlement": {
        const value = valueIn(base, rates, new Decimal(ev.amount), ev.currency);
        settlementValues.set(ev.id, value);
        bump(locked, ev.from, value);
        bump(locked, ev.to, value.neg());
        break;
      }
      case "expense": {
        const amount = new Decimal(ev.amount);
        bumpFloating(ev.paid_by, ev.currency, amount);
        for (const share of ev.shares) {
          bumpFloating(share.participant, ev.currency, shareAmount(amount, share).neg());
        }
        break;
      }
    }
  }

  const balances = new Map<string, Decimal>();
  const unvalued = new Map<string, Map<string, Decimal>>();
  const participants = new Set([...locked.keys(), ...floating.keys()]);
  for (const p of participants) {
    let total = locked.get(p) ?? new Decimal(0);
    for (const [ccy, amt] of floating.get(p) ?? []) {
      if (ccy === base) {
        total = total.plus(amt);
        continue;
      }
      const eff = effectiveRate(rates, ccy);
      if (eff === undefined) {
        if (!amt.isZero()) {
          let m = unvalued.get(p);
          if (!m) {
            m = new Map();
            unvalued.set(p, m);
          }
          m.set(ccy, amt);
        }
        continue;
      }
      total = total.plus(amt.times(eff.rate));
    }
    balances.set(p, total);
  }

  return { rates, balances, unvalued, settlementValues };
}

export interface PersonEntry {
  /** The originating event's id — pass to edit_event/remove_event to correct it. */
  id: string;
  date: string;
  description: string;
  amount: string;
  currency: string;
  base_value: string | null;
  note?: string;
}

export interface PersonView {
  participant: string;
  owes: PersonEntry[];
  paid: PersonEntry[];
  settlements_made: PersonEntry[];
  settlements_received: PersonEntry[];
  net_base: string;
  unvalued: Record<string, string>;
}

export function personView(tab: Tab, participant: string): PersonView {
  const fold = foldTab(tab);
  const base = tab.base_currency;
  const fmt = (d: Decimal) => d.toFixed(2);
  const val = (amount: Decimal, currency: string): string | null => {
    if (currency === base) return fmt(amount);
    const eff = effectiveRate(fold.rates, currency);
    return eff === undefined ? null : fmt(amount.times(eff.rate));
  };

  const view: PersonView = {
    participant,
    owes: [],
    paid: [],
    settlements_made: [],
    settlements_received: [],
    net_base: fmt(fold.balances.get(participant) ?? new Decimal(0)),
    unvalued: Object.fromEntries(
      [...(fold.unvalued.get(participant) ?? [])].map(([c, a]) => [c, a.toString()])
    ),
  };

  for (const ev of tab.events) {
    if (ev.kind === "expense") {
      const total = new Decimal(ev.amount);
      if (ev.paid_by === participant) {
        view.paid.push({
          id: ev.id,
          date: ev.date,
          description: ev.description,
          amount: total.toString(),
          currency: ev.currency,
          base_value: val(total, ev.currency),
          ...(ev.note ? { note: ev.note } : {}),
        });
      }
      const share = ev.shares.find((s) => s.participant === participant);
      if (share) {
        const amt = shareAmount(total, share);
        const label = share.pct !== undefined ? `${share.pct}% of ${ev.description}` : ev.description;
        view.owes.push({
          id: ev.id,
          date: ev.date,
          description: label,
          amount: amt.toString(),
          currency: ev.currency,
          base_value: val(amt, ev.currency),
          ...(ev.note ? { note: ev.note } : {}),
        });
      }
    } else if (ev.kind === "settlement" && (ev.from === participant || ev.to === participant)) {
      const entry: PersonEntry = {
        id: ev.id,
        date: ev.date,
        description: ev.from === participant ? `paid ${ev.to}` : `received from ${ev.from}`,
        amount: ev.amount,
        currency: ev.currency,
        base_value: fold.settlementValues.get(ev.id)?.toFixed(2) ?? null,
        ...(ev.note ? { note: ev.note } : {}),
      };
      (ev.from === participant ? view.settlements_made : view.settlements_received).push(entry);
    }
  }
  return view;
}

/** One human line for an event, for the log listing and the entries table. */
export function summarize(ev: TabEvent): string {
  switch (ev.kind) {
    case "expense":
      return `${ev.description} — ${ev.amount} ${ev.currency} paid by ${ev.paid_by}, split ${ev.shares
        .map((s) => `${s.participant} ${s.pct !== undefined ? `${s.pct}%` : s.amount}`)
        .join(" / ")}${ev.note ? ` (${ev.note})` : ""}`;
    case "settlement":
      return `${ev.from} paid ${ev.to} ${ev.amount} ${ev.currency}${ev.note ? ` (${ev.note})` : ""}`;
    case "conversion":
      return `converted ${ev.from_amount} ${ev.from_currency} to ${ev.to_amount} ${ev.to_currency}${
        ev.note ? ` (${ev.note})` : ""
      }`;
    case "rate":
      return ev.foreign_per_base !== undefined
        ? `declared ${ev.foreign_per_base} ${ev.currency} per 1 base${ev.note ? ` (${ev.note})` : ""}`
        : `cleared the declared rate for ${ev.currency}${ev.note ? ` (${ev.note})` : ""}`;
  }
}

export function balancesReport(tab: Tab) {
  const fold = foldTab(tab);
  const currencies = new Set([...fold.rates.conversions.keys(), ...fold.rates.declared.keys()]);
  return {
    tab: tab.name,
    status: tab.status,
    base_currency: tab.base_currency,
    rates: Object.fromEntries(
      [...currencies].map((ccy) => {
        const eff = effectiveRate(fold.rates, ccy);
        const conv = fold.rates.conversions.get(ccy);
        const declared = fold.rates.declared.get(ccy);
        return [
          ccy,
          {
            effective: eff ? eff.rate.toSignificantDigits(8).toString() : null,
            source: eff?.source ?? null,
            declared_foreign_per_base: declared?.toString() ?? null,
            conversions_average:
              conv && !conv.foreign.isZero()
                ? conv.base.div(conv.foreign).toSignificantDigits(8).toString()
                : null,
            base_converted: conv?.base.toString() ?? "0",
            foreign_received: conv?.foreign.toString() ?? "0",
          },
        ];
      })
    ),
    balances: [...fold.balances].map(([p, b]) => ({
      participant: p,
      net: b.toFixed(2),
      position: b.isZero() ? "settled" : b.isPositive() ? "is owed" : "owes",
      unvalued: Object.fromEntries(
        [...(fold.unvalued.get(p) ?? [])].map(([c, a]) => [c, a.toString()])
      ),
    })),
  };
}
