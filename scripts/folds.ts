/**
 * Tests for the folded MCP surface: add_entry, tab, view (plus the five tools kept as-is).
 *
 * What these prove, and what each would catch:
 *  - the tool list is exactly eight names (a lingering old name or a new tool fails it);
 *  - every field of every folded verb reaches the op and lands in ledger.json (drop a field
 *    from a dispatch and its assertion fails);
 *  - a field that belongs to a different verb is refused BY NAME and the ledger file is
 *    byte-identical afterwards (without the foreign-field check the SDK would accept and
 *    ignore it);
 *  - events written through the fold have exactly the old key set (a format change fails).
 *
 * Runs against a scratch WHOOWES_DIR. It never touches a real ledger.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whoowes-folds-"));
process.env.WHOOWES_DIR = dir;
process.env.WHOOWES_DISPLAY_DIR = path.join(dir, "display");

const { createServer } = await import("../src/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = createServer();
const client = new Client({ name: "folds", version: "0.0.0" });
const [c, s] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(s), client.connect(c)]);

const raw = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true };
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await raw(name, args);
  assert.ok(!r.isError, `${name} ${JSON.stringify(args)} unexpectedly failed: ${r.text}`);
  return JSON.parse(r.text);
};
const ledgerPath = path.join(dir, "ledger.json");
const ledgerText = () => (fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "");
const ledger = () => JSON.parse(ledgerText());
/** Refused, with the named fragments in the message, and the ledger file untouched. */
const refused = async (name: string, args: Record<string, unknown>, ...fragments: string[]) => {
  const before = ledgerText();
  const r = await raw(name, args);
  assert.ok(r.isError, `${name} ${JSON.stringify(args)} should have been refused: ${r.text}`);
  for (const f of fragments) assert.ok(r.text.includes(f), `refusal should name "${f}": ${r.text}`);
  assert.equal(ledgerText(), before, "a refused call must not touch the ledger");
  return r.text;
};

// ── 1. The tool list ─────────────────────────────────────────────────────────────
const tools = (await client.listTools()).tools;
const names = tools.map((t) => t.name).sort();
assert.deepEqual(
  names,
  ["add_entry", "delete_tab", "display", "edit_event", "remove_event", "tab", "undo_last_event", "view"],
  "exactly the eight tools"
);
const OLD = [
  "create_tab", "add_participant", "set_tab_status", "set_base_currency", "add_expense", "add_settlement",
  "add_conversion", "declare_rate", "get_balances", "get_person", "list_events", "list_tabs",
];
{
  // Descriptions and field docs must not send a model to a tool that no longer exists.
  const blob = JSON.stringify(tools);
  for (const o of OLD) {
    // set_base_currency / add_participant survive as ACTION values of `tab`; they may appear
    // only inside its enum, never as a tool to call. Everything else must be gone entirely.
    if (o === "set_base_currency" || o === "add_participant") continue;
    assert.ok(!blob.includes(o), `old tool name ${o} still appears in the tool list`);
  }
}
for (const o of OLD) {
  const r = await raw(o, {});
  assert.ok(r.isError, `old tool ${o} must not be callable`);
}

// ── 2. tab: every action reaches its op ───────────────────────────────────────────
await call("tab", { action: "create", name: "  Lagos  ", base_currency: "gbp" });
{
  const l = ledger();
  assert.equal(l.tabs[0].name, "Lagos", "name is trimmed and stored");
  assert.equal(l.tabs[0].base_currency, "GBP", "base_currency reached the op (and was normalised)");
  assert.equal(l.tabs[0].status, "open");
}
for (const p of ["Ope", "timi", "george"]) await call("tab", { action: "add_participant", name: p });
assert.deepEqual(ledger().participants, ["ope", "timi", "george"], "add_participant stored normalised names");
await refused("tab", { action: "create", name: "lagos", base_currency: "GBP" }, "already exists");

// ── 3. add_entry: every field of every type lands in ledger.json ───────────────────
await call("add_entry", {
  type: "conversion", tab: "Lagos", from_amount: "50", from_currency: "GBP",
  to_amount: "100000", to_currency: "NGN", note: "airport kiosk", date: "2026-07-01",
});
await call("add_entry", {
  type: "expense", tab: "Lagos", description: "  hotel ", amount: "200000", currency: "NGN", paid_by: "ope",
  shares: [{ participant: "timi", pct: "20" }, { participant: "george", pct: "80" }],
  note: "provisional", date: "2026-07-02",
});
await call("add_entry", {
  type: "settlement", tab: "Lagos", from: "george", to: "ope", amount: "20000", currency: "NGN",
  note: "bank transfer", date: "2026-07-03",
});
await call("add_entry", { type: "rate", tab: "Lagos", currency: "NGN", rate: "2500", note: "pinned", date: "2026-07-04" });
{
  const [conv, exp, set, rate] = ledger().tabs[0].events;
  assert.deepEqual(
    { ...conv, id: "x" },
    {
      kind: "conversion", id: "x", date: "2026-07-01", from_amount: "50", from_currency: "GBP",
      to_amount: "100000", to_currency: "NGN", note: "airport kiosk",
    },
    "conversion fields all landed, in the old shape"
  );
  assert.deepEqual(
    { ...exp, id: "x" },
    {
      kind: "expense", id: "x", date: "2026-07-02", description: "hotel", amount: "200000", currency: "NGN",
      paid_by: "ope",
      shares: [{ participant: "timi", pct: "20" }, { participant: "george", pct: "80" }],
      note: "provisional",
    },
    "expense fields all landed, in the old shape"
  );
  assert.deepEqual(
    { ...set, id: "x" },
    {
      kind: "settlement", id: "x", date: "2026-07-03", amount: "20000", currency: "NGN",
      from: "george", to: "ope", note: "bank transfer",
    },
    "settlement fields all landed, in the old shape"
  );
  assert.deepEqual(
    { ...rate, id: "x" },
    { kind: "rate", id: "x", date: "2026-07-04", currency: "NGN", foreign_per_base: "2500", note: "pinned" },
    "rate fields all landed, in the old shape"
  );
  for (const e of [conv, exp, set, rate]) assert.match(e.id, /^[0-9a-f-]{36}$/, "events get a uuid id");
}
// Omitting rate clears the declaration: the event carries no foreign_per_base.
await call("add_entry", { type: "rate", tab: "Lagos", currency: "NGN" });
{
  const ev = ledger().tabs[0].events[4];
  assert.equal(ev.kind, "rate");
  assert.ok(!("foreign_per_base" in ev), "a rate entry without rate is a clearing");
  assert.match(ev.date, /^\d{4}-\d{2}-\d{2}$/, "date defaults to today");
}

// ── 4. tab set_status / set_base_currency reach their ops ──────────────────────────
await call("tab", { action: "set_status", tab: "Lagos", status: "closed" });
assert.equal(ledger().tabs[0].status, "closed");
await refused(
  "add_entry",
  { type: "settlement", tab: "Lagos", from: "george", to: "ope", amount: "1", currency: "NGN" },
  "closed"
);
await call("tab", { action: "set_status", tab: "Lagos", status: "open" });
assert.equal(ledger().tabs[0].status, "open");

await call("tab", { action: "create", name: "Abuja", base_currency: "GBP" });
await call("add_entry", {
  type: "conversion", tab: "Abuja", from_amount: "10", from_currency: "GBP", to_amount: "20000", to_currency: "NGN",
});
await call("tab", { action: "set_base_currency", tab: "Abuja", base_currency: "ngn" });
assert.equal(ledger().tabs[1].base_currency, "NGN", "set_base_currency reached the op");
// The op's own refusal (a declared rate blocks a rebase) comes through the fold unchanged.
await call("tab", { action: "create", name: "Kano", base_currency: "GBP" });
await call("add_entry", { type: "rate", tab: "Kano", currency: "NGN", rate: "2000" });
await refused("tab", { action: "set_base_currency", tab: "Kano", base_currency: "NGN" }, "rate is declared");
await call("tab", { action: "set_base_currency", tab: "Kano", base_currency: "USD" });
await call("delete_tab", { tab: "Kano", confirm: true });

// ── 5. view: every `what` returns its own payload ──────────────────────────────────
{
  const tabsView = await call("view", { what: "tabs" });
  assert.deepEqual(tabsView.tabs.map((t: any) => t.name), ["Lagos", "Abuja"]);
  assert.deepEqual(tabsView.participants, ["ope", "timi", "george"]);
  assert.equal(tabsView.tabs[0].events, 5);

  const bal = await call("view", { what: "balances", tab: "Lagos" });
  assert.ok(Array.isArray(bal.balances) && bal.rates, "balances report");

  const person = await call("view", { what: "person", tab: "Lagos", participant: "George" });
  assert.equal(person.settlements_made.length, 1, "participant reached personView");

  const events = await call("view", { what: "events", tab: "Lagos" });
  assert.deepEqual(events.events.map((e: any) => e.kind), ["conversion", "expense", "settlement", "rate", "rate"]);
  assert.equal(events.events[0].id, ledger().tabs[0].events[0].id);
}

// ── 6. Foreign fields are refused by name; the ledger is untouched ─────────────────
await refused("add_entry", { type: "settlement", tab: "Lagos", from: "george", to: "ope", amount: "1", currency: "NGN", paid_by: "ope" }, "paid_by", 'type "settlement"');
await refused("add_entry", { type: "rate", tab: "Lagos", currency: "NGN", rate: "2", shares: [{ participant: "ope", pct: "100" }], description: "x" }, "shares", "description");
await refused("add_entry", { type: "conversion", tab: "Lagos", from_amount: "1", from_currency: "GBP", to_amount: "2", to_currency: "NGN", amount: "5" }, "amount");
await refused("add_entry", { type: "expense", tab: "Lagos", description: "x", amount: "1", currency: "GBP", paid_by: "ope", shares: [{ participant: "ope", pct: "100" }], rate: "3" }, "rate");
await refused("tab", { action: "set_status", tab: "Lagos", status: "open", base_currency: "USD" }, "base_currency");
await refused("tab", { action: "create", name: "Z", base_currency: "GBP", tab: "Lagos" }, "tab");
await refused("tab", { action: "add_participant", name: "ada", status: "open" }, "status");
await refused("view", { what: "balances", tab: "Lagos", participant: "ope" }, "participant");
await refused("view", { what: "tabs", tab: "Lagos" }, "tab");
await refused("view", { what: "events", tab: "Lagos", bogus: 1 }, "bogus");
await refused("add_entry", { type: "rate", tab: "Lagos", currency: "NGN", not_a_field: "x" }, "not_a_field");

// ── 7. Missing required fields are named; so is a missing discriminator ─────────────
await refused("add_entry", { type: "expense", tab: "Lagos", amount: "1" }, "description", "currency", "paid_by", "shares");
await refused("add_entry", { type: "settlement", tab: "Lagos", from: "george" }, "to", "amount", "currency");
await refused("add_entry", { type: "conversion", tab: "Lagos" }, "from_amount", "to_currency");
await refused("add_entry", { type: "rate", tab: "Lagos" }, "currency");
await refused("tab", { action: "create", name: "Q" }, "base_currency");
await refused("tab", { action: "set_status", tab: "Lagos" }, "status");
await refused("view", { what: "person", tab: "Lagos" }, "participant");
await refused("view", { what: "balances" }, "tab");
await refused("add_entry", { tab: "Lagos" }, "type");
await refused("tab", { name: "Q" }, "action");
await refused("view", { what: "everything" }, "what");

// ── 8. Field-level validation survives the fold ────────────────────────────────────
await refused("add_entry", { type: "settlement", tab: "Lagos", from: "george", to: "ope", amount: "1", currency: "pounds" }, "currency");
await refused("add_entry", { type: "settlement", tab: "Lagos", from: "george", to: "ope", amount: "-5", currency: "NGN" }, "amount");
await refused("add_entry", { type: "settlement", tab: "Lagos", from: "george", to: "ope", amount: "1", currency: "NGN", date: "yesterday" }, "date");
await refused("tab", { action: "set_status", tab: "Lagos", status: "paused" }, "status");

// ── 9. The kept tools still work and edit_event reaches its op ──────────────────────
{
  const id = ledger().tabs[0].events[1].id;
  const edited = await call("edit_event", { tab: "Lagos", event_id: id, note: "confirmed" });
  assert.equal(edited.after.note, "confirmed");
  assert.ok((await call("display", { tab: "Lagos" })).path.endsWith(".html"));
  await call("undo_last_event", { tab: "Lagos" });
  assert.equal(ledger().tabs[0].events.length, 4);
  await call("remove_event", { tab: "Lagos", event_id: ledger().tabs[0].events[3].id });
  assert.equal(ledger().tabs[0].events.length, 3);
  await refused("delete_tab", { tab: "Abuja" }, "confirm");
  await call("delete_tab", { tab: "Abuja", confirm: true });
  assert.deepEqual(ledger().tabs.map((t: any) => t.name), ["Lagos"]);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("folds OK");
process.exit(0);
