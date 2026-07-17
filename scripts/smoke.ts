import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

// --- rebasing GBP -> NGN: conversions re-read from the other side, everything revalues ---
{
  const tab = { ...mkTab([...baseEvents]), base_currency: "NGN" };
  const fold = foldTab(tab);

  // The same two conversions now read as NGN-per-GBP: 250,000 NGN for 110 GBP.
  const report = balancesReport(tab);
  assert.equal(report.rates["GBP"]!.effective, "2272.7273", "£110 bought ₦250,000");
  assert.equal(report.rates["GBP"]!.source, "conversions");
  assert.equal(report.rates["NGN"], undefined, "the base currency holds no rate against itself");

  // NGN is now native, so the hotel and the settlement need no rate at all.
  assert.equal(fold.balances.get("ope")!.toString(), "180000", "paid ₦200,000, received ₦20,000");
  assert.equal(fold.balances.get("george")!.toString(), "-140000", "owes ₦160,000, settled ₦20,000");
  assert.equal(fold.balances.get("timi")!.toString(), "-40000");
  assert.equal(fold.settlementValues.get("s1")!.toString(), "20000", "settlement is native, not converted");
  zero(tab);
}

// ── Tool-level: edit_event / remove_event driven through a real MCP client ──────────
// These go through the registered handlers (schema, validation, fold-then-save), not just
// the fold, because that is where the position-preserving guarantee actually lives.
{
  // store.ts reads WHOOWES_DIR at module load, so set it before importing anything that
  // pulls it in — hence the dynamic imports below.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whoowes-smoke-"));
  process.env.WHOOWES_DIR = dir;

  const { createServer } = await import("../src/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = createServer();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content[0]!.text, isError: r.isError === true };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    assert.ok(!r.isError, `${name} unexpectedly failed: ${r.text}`);
    return JSON.parse(r.text);
  };
  const refused = async (name: string, args: Record<string, unknown>, match: RegExp) => {
    const r = await raw(name, args);
    assert.ok(r.isError, `${name} should have been refused but succeeded: ${r.text}`);
    assert.match(r.text, match);
    return r.text;
  };
  const netOf = (report: any, who: string) =>
    report.balances.find((b: any) => b.participant === who)?.net;

  // Every tool is reachable, and the two new mutations plus the log listing are registered.
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.ok(listed.includes("edit_event"), "edit_event registered");
  assert.ok(listed.includes("remove_event"), "remove_event registered");
  assert.ok(listed.includes("list_events"), "list_events registered");
  assert.equal(listed.length, 16, `expected 16 tools, got ${listed.length}: ${listed.join(", ")}`);

  // Rebuild the GBP/NGN scenario through the real tools.
  await call("create_tab", { name: "lagos", base_currency: "GBP" });
  for (const p of ["ope", "timi", "george"]) await call("add_participant", { name: p });
  await call("add_conversion", {
    tab: "lagos", from_amount: "50", from_currency: "GBP",
    to_amount: "100000", to_currency: "NGN", date: "2026-07-01",
  });
  await call("add_expense", {
    tab: "lagos", description: "hotel", amount: "200000", currency: "NGN", paid_by: "ope",
    shares: [{ participant: "timi", pct: "20" }, { participant: "george", pct: "80" }],
    date: "2026-07-02",
  });
  await call("add_settlement", {
    tab: "lagos", from: "george", to: "ope", amount: "20000", currency: "NGN", date: "2026-07-03",
  });
  await call("add_conversion", {
    tab: "lagos", from_amount: "60", from_currency: "GBP",
    to_amount: "150000", to_currency: "NGN", date: "2026-07-04",
  });

  // list_events is the id-discovery path the mutations depend on.
  const log = await call("list_events", { tab: "lagos" });
  assert.equal(log.events.length, 4);
  assert.deepEqual(log.events.map((e: any) => e.kind), ["conversion", "expense", "settlement", "conversion"]);
  const [c1, e1, s1, c2] = log.events.map((e: any) => e.id) as string[];

  // Baseline matches the fold-level scenario above: settlement locked at £10.
  const before = await call("get_balances", { tab: "lagos" });
  assert.equal(netOf(before, "ope"), "78.00");
  assert.equal((await call("get_person", { tab: "lagos", participant: "george" })).settlements_made[0].base_value, "10.00");

  // ── The position-preserving guarantee ────────────────────────────────────────
  // Edit the FIRST conversion (£50 -> £100 for the same ₦100,000, so its rate becomes
  // 0.001). The settlement sits after it and before the second conversion, so it must
  // relock at 0.001 = £20. A remove-then-append edit would move c1 to the end of the log,
  // leaving no rate in force at the settlement's point at all — the fold would throw.
  const edited = await call("edit_event", { tab: "lagos", event_id: c1, from_amount: "100" });
  assert.equal(edited.position, "1 of 4", "edited event stays at its original index");
  assert.equal(edited.before.from_amount, "50");
  assert.equal(edited.after.from_amount, "100");
  assert.equal(edited.after.id, c1, "id is immutable across an edit");
  assert.equal(edited.after.kind, "conversion", "kind is immutable across an edit");

  const george = await call("get_person", { tab: "lagos", participant: "george" });
  assert.equal(george.settlements_made[0].base_value, "20.00", "settlement relocked at the edited rate IN ITS OWN POSITION");

  // ...and the expense revalued retroactively at the new average (160/250,000 = 0.00064).
  const after = await call("get_balances", { tab: "lagos" });
  assert.equal(after.rates["NGN"].effective, "0.00064");
  assert.equal(netOf(after, "ope"), "108.00", "paid £128, received £20");
  assert.equal(netOf(after, "george"), "-82.40", "owes £102.40, settled £20");
  assert.equal(netOf(after, "timi"), "-25.60");

  // ── Removing a conversion a later settlement depends on is refused ───────────
  // c1 is the only rate in force when the settlement happens; dropping it strands it.
  await refused("remove_event", { tab: "lagos", event_id: c1 }, /no rate available for NGN/);

  // ...and the refusal left nothing behind: the log and every balance are untouched.
  const afterRefusal = await call("get_balances", { tab: "lagos" });
  assert.deepEqual(afterRefusal, after, "a refused remove must not mutate the tab");
  assert.equal((await call("list_events", { tab: "lagos" })).events.length, 4, "refused remove kept the log intact");

  // ── Notes are carried on expenses and surface on the person view ─────────────
  await call("edit_event", { tab: "lagos", event_id: e1, note: "provisional — not yet booked" });
  const noted = await call("get_person", { tab: "lagos", participant: "george" });
  assert.equal(noted.owes[0].note, "provisional — not yet booked");
  assert.equal(noted.owes[0].id, e1, "person view exposes the event id to edit by");

  // ── Validation is shared with add_expense, and re-run when only the amount moves ──
  // Percentage shares rescale, so changing the total alone is valid.
  const rescaled = await call("edit_event", { tab: "lagos", event_id: e1, amount: "100000" });
  assert.equal(netOf(rescaled, "ope"), "44.00", "half the hotel: paid £64, received £20");
  assert.equal(netOf(rescaled, "george"), "-31.20");
  assert.equal(netOf(rescaled, "timi"), "-12.80");
  await call("edit_event", { tab: "lagos", event_id: e1, amount: "200000" });
  assert.equal(netOf(await call("get_balances", { tab: "lagos" }), "ope"), "108.00", "restored");

  // Fixed shares stop summing when the total changes -> refused by the shared validator.
  await call("edit_event", {
    tab: "lagos", event_id: e1,
    shares: [{ participant: "timi", amount: "40000" }, { participant: "george", amount: "160000" }],
  });
  await refused("edit_event", { tab: "lagos", event_id: e1, amount: "300000" }, /shares sum to 200000 NGN but must sum to 300000 NGN/);

  // A field that belongs to another kind is rejected, not silently ignored.
  await refused("edit_event", { tab: "lagos", event_id: s1, shares: [{ participant: "timi", pct: "100" }] }, /cannot set shares on a settlement event/);
  await refused("edit_event", { tab: "lagos", event_id: e1 }, /nothing to edit/);
  await refused("edit_event", { tab: "lagos", event_id: "nope" }, /no event with id "nope"/);

  // ── Removing a safe event works, by id, from the middle of the log ────────────
  const removed = await call("remove_event", { tab: "lagos", event_id: s1 });
  assert.equal(removed.removed.id, s1);
  assert.equal(removed.removed.kind, "settlement");
  const logAfter = await call("list_events", { tab: "lagos" });
  assert.deepEqual(logAfter.events.map((e: any) => e.id), [c1, e1, c2], "middle event gone, order kept");
  assert.equal(netOf(removed, "george"), "-102.40", "settlement no longer credits george");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("smoke OK");
