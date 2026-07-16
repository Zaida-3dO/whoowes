import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { balancesReport, foldTab, personView } from "../src/fold.js";
import { Tab, TabEvent } from "../src/types.js";

const zero = (tab: Tab) => {
  const sum = [...foldTab(tab).balances.values()].reduce((a, b) => a.plus(b), new Decimal(0));
  assert.ok(sum.isZero(), `balances must sum to zero, got ${sum}`);
};

// The scenario from the design conversation, in GBP/NGN:
// 1. convert £50 -> 100,000 NGN            (rate 0.0005)
// 2. hotel 200,000 NGN paid by ope, shares 20% timi / 80% george
// 3. george settles 20,000 NGN to ope       (locks at 0.0005 = £10)
// 4. convert £60 -> 150,000 NGN             (avg moves to 110/250,000 = 0.00044)
// Expenses revalue retroactively; the settlement stays £10.
const baseEvents: TabEvent[] = [
  {
    kind: "conversion", id: "c1", date: "2026-07-01",
    from_amount: "50", from_currency: "GBP", to_amount: "100000", to_currency: "NGN",
  },
  {
    kind: "expense", id: "e1", date: "2026-07-02", description: "hotel",
    amount: "200000", currency: "NGN", paid_by: "ope",
    shares: [
      { participant: "timi", pct: "20" },
      { participant: "george", pct: "80" },
    ],
  },
  {
    kind: "settlement", id: "s1", date: "2026-07-03",
    amount: "20000", currency: "NGN", from: "george", to: "ope",
  },
  {
    kind: "conversion", id: "c2", date: "2026-07-04",
    from_amount: "60", from_currency: "GBP", to_amount: "150000", to_currency: "NGN",
  },
];

const mkTab = (events: TabEvent[]): Tab => ({
  id: "t1",
  name: "lagos",
  base_currency: "GBP",
  status: "open",
  created_at: "2026-07-16T00:00:00Z",
  events,
});

// --- conversions-average behaviour ---
{
  const tab = mkTab([...baseEvents]);
  const fold = foldTab(tab);

  assert.equal(fold.settlementValues.get("s1")!.toString(), "10", "settlement locked at the rate when it happened");
  assert.equal(fold.balances.get("ope")!.toString(), "78", "ope: paid 88 (revalued), received 10");
  assert.equal(fold.balances.get("george")!.toString(), "-60.4");
  assert.equal(fold.balances.get("timi")!.toString(), "-17.6");
  zero(tab);

  const george = personView(tab, "george");
  assert.equal(george.owes[0]!.description, "80% of hotel");
  assert.equal(george.owes[0]!.base_value, "70.40");
  assert.equal(george.settlements_made[0]!.base_value, "10.00");
  assert.equal(george.net_base, "-60.40");

  const report = balancesReport(tab);
  assert.equal(report.rates["NGN"]!.effective, "0.00044");
  assert.equal(report.rates["NGN"]!.source, "conversions");
}

// --- declared rate overrides the average, retroactively for expenses ---
{
  const tab = mkTab([
    ...baseEvents,
    { kind: "rate", id: "r1", date: "2026-07-05", currency: "NGN", foreign_per_base: "2500" },
  ]);
  const fold = foldTab(tab);

  assert.equal(fold.balances.get("george")!.toString(), "-54", "expense share revalued at declared 0.0004, settlement stays 10");
  assert.equal(fold.balances.get("ope")!.toString(), "70");
  assert.equal(fold.balances.get("timi")!.toString(), "-16");
  assert.equal(fold.settlementValues.get("s1")!.toString(), "10", "earlier settlement not revalued by declaration");
  zero(tab);

  const report = balancesReport(tab);
  assert.equal(report.rates["NGN"]!.effective, "0.0004");
  assert.equal(report.rates["NGN"]!.source, "declared");
  assert.equal(report.rates["NGN"]!.declared_foreign_per_base, "2500");
  assert.equal(report.rates["NGN"]!.conversions_average, "0.00044", "average still reported alongside");
}

// --- settlements after a declaration lock at the declared rate ---
{
  const tab = mkTab([
    ...baseEvents,
    { kind: "rate", id: "r1", date: "2026-07-05", currency: "NGN", foreign_per_base: "2500" },
    { kind: "settlement", id: "s2", date: "2026-07-06", amount: "10000", currency: "NGN", from: "george", to: "ope" },
  ]);
  const fold = foldTab(tab);
  assert.equal(fold.settlementValues.get("s2")!.toString(), "4", "10,000 NGN at declared 2500/GBP = £4");
  assert.equal(fold.balances.get("george")!.toString(), "-50");
  zero(tab);
}

// --- clearing the declaration falls back to the conversions average; locked settlements stay locked ---
{
  const tab = mkTab([
    ...baseEvents,
    { kind: "rate", id: "r1", date: "2026-07-05", currency: "NGN", foreign_per_base: "2500" },
    { kind: "settlement", id: "s2", date: "2026-07-06", amount: "10000", currency: "NGN", from: "george", to: "ope" },
    { kind: "rate", id: "r2", date: "2026-07-07", currency: "NGN" },
  ]);
  const fold = foldTab(tab);
  assert.equal(fold.settlementValues.get("s1")!.toString(), "10");
  assert.equal(fold.settlementValues.get("s2")!.toString(), "4", "stays locked at the declared rate it was recorded under");
  assert.equal(fold.balances.get("george")!.toString(), "-56.4", "expense back to average 0.00044");
  assert.equal(fold.balances.get("ope")!.toString(), "74");
  assert.equal(fold.balances.get("timi")!.toString(), "-17.6");
  zero(tab);

  const report = balancesReport(tab);
  assert.equal(report.rates["NGN"]!.source, "conversions");
  assert.equal(report.rates["NGN"]!.declared_foreign_per_base, null);
}

// --- declared rate works with no conversions at all ---
{
  const tab = mkTab([
    { kind: "rate", id: "r1", date: "2026-07-01", currency: "EUR", foreign_per_base: "1.25" },
    {
      kind: "expense", id: "e1", date: "2026-07-02", description: "dinner",
      amount: "100", currency: "EUR", paid_by: "ope",
      shares: [{ participant: "george", pct: "100" }],
    },
    { kind: "settlement", id: "s1", date: "2026-07-03", amount: "25", currency: "EUR", from: "george", to: "ope" },
  ]);
  const fold = foldTab(tab);
  assert.equal(fold.balances.get("george")!.toString(), "-60", "owes £80, settled £20, no conversion needed");
  assert.equal(fold.balances.get("ope")!.toString(), "60");
  zero(tab);
}

// --- a settlement with no rate at all must be rejected ---
{
  const tab = mkTab([baseEvents[2]!]);
  assert.throws(() => foldTab(tab), /no rate available for NGN/);
}

console.log("smoke OK");
