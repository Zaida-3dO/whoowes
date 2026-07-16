import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { balancesReport, foldTab, personView, shareAmount } from "./fold.js";
import { ensureOpen, ensureParticipant, findTab, ledgerFilePath, load, normalizeName, save } from "./store.js";
import { LedgerError, Tab, TabEvent } from "./types.js";

const money = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((s) => {
    try {
      return new Decimal(s).isFinite() && new Decimal(s).isPositive();
    } catch {
      return false;
    }
  }, "must be a positive decimal amount");

const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "must be a 3-letter currency code like GBP or NGN");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "must be an ISO date (YYYY-MM-DD)")
  .optional();

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], isError: true };
}

/** Appends the event, verifies the whole tab still folds cleanly, and only then persists. */
function commitEvent(tab: Tab, event: TabEvent, ledgerSave: () => void) {
  tab.events.push(event);
  try {
    foldTab(tab);
  } catch (e) {
    tab.events.pop();
    throw e;
  }
  ledgerSave();
}

function run<T>(fn: () => T) {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof LedgerError) return fail(e.message);
    throw e;
  }
}

/**
 * Builds a fully-registered server. A factory rather than a singleton because the
 * HTTP transport is stateless: every request gets its own server + transport pair.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "whoowes", version: "0.1.0" });

  server.registerTool(
    "create_tab",
    {
      description:
        "Create a new tab (a self-contained event or trip ledger). All balances are reported in its base currency.",
      inputSchema: {
        name: z.string().trim().min(1),
        base_currency: currency,
      },
    },
    async ({ name, base_currency }) =>
      run(() => {
        const ledger = load();
        if (ledger.tabs.some((t) => normalizeName(t.name) === normalizeName(name))) {
          throw new LedgerError(`a tab named "${name}" already exists`);
        }
        const tab: Tab = {
          id: randomUUID(),
          name: name.trim(),
          base_currency,
          status: "open",
          created_at: new Date().toISOString(),
          events: [],
        };
        ledger.tabs.push(tab);
        save(ledger);
        return { created: tab.name, base_currency: tab.base_currency };
      })
  );

  server.registerTool(
    "add_participant",
    {
      description: "Register a participant. Participants are global and reusable across tabs.",
      inputSchema: { name: z.string().trim().min(1) },
    },
    async ({ name }) =>
      run(() => {
        const ledger = load();
        const n = normalizeName(name);
        if (!ledger.participants.includes(n)) {
          ledger.participants.push(n);
          save(ledger);
        }
        return { participants: ledger.participants };
      })
  );

  server.registerTool(
    "add_expense",
    {
      description:
        "Record a shared expense on a tab. Shares allocate the full expense: all pct (summing to 100) or all fixed amounts (summing to the total). Include the payer's own share if they consumed part of it (e.g. '20% timi, 80% george' means the payer consumed nothing).",
      inputSchema: {
        tab: z.string(),
        description: z.string().trim().min(1),
        amount: money,
        currency: currency,
        paid_by: z.string(),
        shares: z
          .array(
            z.object({
              participant: z.string(),
              pct: money.optional(),
              amount: money.optional(),
            })
          )
          .min(1),
        date: isoDate,
      },
    },
    async ({ tab: tabName, description, amount, currency: ccy, paid_by, shares, date }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        const payer = ensureParticipant(ledger, paid_by);

        const modes = new Set(shares.map((s) => (s.pct !== undefined ? "pct" : s.amount !== undefined ? "amount" : "none")));
        if (modes.has("none") || modes.size !== 1) {
          throw new LedgerError("every share needs either pct or amount, and all shares must use the same one");
        }
        const total = new Decimal(amount);
        const normalized = shares.map((s) => ({
          participant: ensureParticipant(ledger, s.participant),
          ...(s.pct !== undefined ? { pct: s.pct } : { amount: s.amount! }),
        }));
        const sum = normalized.reduce((acc, s) => acc.plus(shareAmount(total, s)), new Decimal(0));
        if (!sum.equals(total)) {
          const unit = modes.has("pct") ? "%" : ` ${ccy}`;
          const sumShown = modes.has("pct") ? sum.div(total).times(100).toString() : sum.toString();
          const expectedShown = modes.has("pct") ? "100" : total.toString();
          throw new LedgerError(`shares sum to ${sumShown}${unit} but must sum to ${expectedShown}${unit}`);
        }

        commitEvent(
          tab,
          {
            kind: "expense",
            id: randomUUID(),
            date: date ?? new Date().toISOString().slice(0, 10),
            description: description.trim(),
            amount,
            currency: ccy,
            paid_by: payer,
            shares: normalized,
          },
          () => save(ledger)
        );
        return balancesReport(tab);
      })
  );

  server.registerTool(
    "add_settlement",
    {
      description:
        "Record a payment from one participant to another (e.g. 'george transferred me 20k naira'). Its base-currency value locks at the tab's cumulative exchange rate at the moment it is recorded; a conversion for that currency must already exist.",
      inputSchema: {
        tab: z.string(),
        from: z.string(),
        to: z.string(),
        amount: money,
        currency: currency,
        note: z.string().optional(),
        date: isoDate,
      },
    },
    async ({ tab: tabName, from, to, amount, currency: ccy, note, date }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        const f = ensureParticipant(ledger, from);
        const t = ensureParticipant(ledger, to);
        if (f === t) throw new LedgerError("from and to must be different participants");

        commitEvent(
          tab,
          {
            kind: "settlement",
            id: randomUUID(),
            date: date ?? new Date().toISOString().slice(0, 10),
            amount,
            currency: ccy,
            from: f,
            to: t,
            ...(note ? { note } : {}),
          },
          () => save(ledger)
        );
        return balancesReport(tab);
      })
  );

  server.registerTool(
    "add_conversion",
    {
      description:
        "Record a real currency conversion you made (what you gave and what you received). One side must be the tab's base currency. The tab's cumulative rate is the weighted average over all conversions, and it retroactively revalues every expense in that currency.",
      inputSchema: {
        tab: z.string(),
        from_amount: money,
        from_currency: currency,
        to_amount: money,
        to_currency: currency,
        note: z.string().optional(),
        date: isoDate,
      },
    },
    async ({ tab: tabName, from_amount, from_currency, to_amount, to_currency, note, date }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        if (from_currency === to_currency) throw new LedgerError("from and to currencies must differ");
        if (from_currency !== tab.base_currency && to_currency !== tab.base_currency) {
          throw new LedgerError(`one side of a conversion must be the tab's base currency (${tab.base_currency})`);
        }

        commitEvent(
          tab,
          {
            kind: "conversion",
            id: randomUUID(),
            date: date ?? new Date().toISOString().slice(0, 10),
            from_amount,
            from_currency,
            to_amount,
            to_currency,
            ...(note ? { note } : {}),
          },
          () => save(ledger)
        );
        return balancesReport(tab);
      })
  );

  server.registerTool(
    "declare_rate",
    {
      description:
        "Manually declare the exchange rate for a currency on a tab, as units of that currency per 1 unit of the base currency (e.g. currency NGN, rate 2000 means 2000 NGN = 1 GBP). While declared, it overrides the conversions average everywhere: expenses revalue retroactively, and settlements recorded afterwards lock at it. Declare again to change it; omit rate to clear the declaration and fall back to the conversions average.",
      inputSchema: {
        tab: z.string(),
        currency: currency,
        rate: money.optional(),
        note: z.string().optional(),
        date: isoDate,
      },
    },
    async ({ tab: tabName, currency: ccy, rate, note, date }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        if (ccy === tab.base_currency) {
          throw new LedgerError(`cannot declare a rate for the base currency (${tab.base_currency})`);
        }
        commitEvent(
          tab,
          {
            kind: "rate",
            id: randomUUID(),
            date: date ?? new Date().toISOString().slice(0, 10),
            currency: ccy,
            ...(rate !== undefined ? { foreign_per_base: rate } : {}),
            ...(note ? { note } : {}),
          },
          () => save(ledger)
        );
        return balancesReport(tab);
      })
  );

  server.registerTool(
    "get_balances",
    {
      description:
        "Current state of a tab: per-participant net position in the base currency, cumulative exchange rates, and any amounts that cannot be valued yet.",
      inputSchema: { tab: z.string() },
    },
    async ({ tab: tabName }) => run(() => balancesReport(findTab(load(), tabName)))
  );

  server.registerTool(
    "get_person",
    {
      description:
        "Everything about one participant on a tab: what they were meant to pay (their expense shares), what they paid for, and settlements made/received, plus their net position.",
      inputSchema: { tab: z.string(), participant: z.string() },
    },
    async ({ tab: tabName, participant }) =>
      run(() => {
        const ledger = load();
        return personView(findTab(ledger, tabName), ensureParticipant(ledger, participant));
      })
  );

  server.registerTool(
    "list_tabs",
    {
      description: "List all tabs with status, base currency, and event count.",
      inputSchema: {},
    },
    async () =>
      run(() => {
        const ledger = load();
        return {
          ledger_file: ledgerFilePath(),
          participants: ledger.participants,
          tabs: ledger.tabs.map((t) => ({
            name: t.name,
            status: t.status,
            base_currency: t.base_currency,
            events: t.events.length,
            created_at: t.created_at,
          })),
        };
      })
  );

  server.registerTool(
    "set_tab_status",
    {
      description: "Close a tab (no further events) or reopen it.",
      inputSchema: { tab: z.string(), status: z.enum(["open", "closed"]) },
    },
    async ({ tab: tabName, status }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        tab.status = status;
        save(ledger);
        return { tab: tab.name, status: tab.status };
      })
  );

  server.registerTool(
    "undo_last_event",
    {
      description: "Remove the most recent event from a tab (use when an entry was recorded wrongly).",
      inputSchema: { tab: z.string() },
    },
    async ({ tab: tabName }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        const removed = tab.events.pop();
        if (!removed) throw new LedgerError(`tab "${tab.name}" has no events`);
        save(ledger);
        return { removed, ...balancesReport(tab) };
      })
  );

  return server;
}
