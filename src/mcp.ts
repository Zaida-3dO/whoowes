import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { balancesReport, foldTab, personView, shareAmount, summarize } from "./fold.js";
import { ensureOpen, ensureParticipant, findEvent, findTab, ledgerFilePath, load, normalizeName, save } from "./store.js";
import { Ledger, LedgerError, Share, Tab, TabEvent } from "./types.js";

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

/**
 * Applies a change to the event log, verifies the whole tab still folds cleanly, and only
 * then persists. The fold is the validator: it is what catches a removed conversion that a
 * later settlement depended on. A rejected change leaves no trace — the log is restored from
 * a snapshot, which is why edits must replace a slot with a new object rather than mutate the
 * event in place (a shallow snapshot shares the object, so an in-place mutation would survive
 * the restore).
 */
function commitLog(tab: Tab, mutate: () => void, ledgerSave: () => void) {
  const snapshot = [...tab.events];
  try {
    mutate();
    foldTab(tab);
  } catch (e) {
    tab.events = snapshot;
    throw e;
  }
  ledgerSave();
}

function commitEvent(tab: Tab, event: TabEvent, ledgerSave: () => void) {
  commitLog(tab, () => tab.events.push(event), ledgerSave);
}

/**
 * Resolves participants, enforces one share mode, and checks the shares allocate exactly the
 * total. Shared by add_expense and edit_event so an edited expense is held to the same rule —
 * and re-checked even when only the amount moved, since fixed shares no longer sum to it.
 */
function normalizeShares(
  ledger: Ledger,
  shares: { participant: string; pct?: string; amount?: string }[],
  total: Decimal,
  ccy: string
): Share[] {
  const modes = new Set(
    shares.map((s) => (s.pct !== undefined ? "pct" : s.amount !== undefined ? "amount" : "none"))
  );
  if (modes.has("none") || modes.size !== 1) {
    throw new LedgerError("every share needs either pct or amount, and all shares must use the same one");
  }
  const normalized: Share[] = shares.map((s) => ({
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
  return normalized;
}

function run<T>(fn: () => T) {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof LedgerError) return fail(e.message);
    throw e;
  }
}

/** What edit_event may patch per kind. `kind` and `id` are immutable — an edit corrects an
 *  entry, it does not turn one kind of event into another. */
const EDITABLE_FIELDS: Record<TabEvent["kind"], string[]> = {
  expense: ["date", "description", "amount", "currency", "paid_by", "shares", "note"],
  settlement: ["date", "amount", "currency", "from", "to", "note"],
  conversion: ["date", "from_amount", "from_currency", "to_amount", "to_currency", "note"],
  rate: ["date", "currency", "rate", "note"],
};

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
        "Record a shared expense on a tab. Shares allocate the full expense: all pct (summing to 100) or all fixed amounts (summing to the total). Include the payer's own share if they consumed part of it (e.g. '20% timi, 80% george' means the payer consumed nothing). Use note for context that isn't the description: what's provisional, why it's split this way, what it assumes.",
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
        note: z.string().optional(),
        date: isoDate,
      },
    },
    async ({ tab: tabName, description, amount, currency: ccy, paid_by, shares, note, date }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        const payer = ensureParticipant(ledger, paid_by);

        const normalized = normalizeShares(ledger, shares, new Decimal(amount), ccy);

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
            ...(note ? { note } : {}),
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
    "set_base_currency",
    {
      description:
        "Change the currency a tab reports balances in. Everything revalues retroactively, and conversions re-read themselves from the new side (a GBP->NGN conversion means 'NGN per GBP' or 'GBP per NGN' depending on the base). Refused if any conversion has no side in the new base, or if a rate is declared for it.",
      inputSchema: { tab: z.string(), base_currency: currency },
    },
    async ({ tab: tabName, base_currency }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        const previous = tab.base_currency;
        if (previous === base_currency) {
          throw new LedgerError(`tab "${tab.name}" already reports in ${base_currency}`);
        }
        // A conversion only carries a rate if one of its sides is the base; otherwise the
        // fold would silently read the wrong side as the base amount.
        for (const ev of tab.events) {
          if (ev.kind === "conversion" && ev.from_currency !== base_currency && ev.to_currency !== base_currency) {
            throw new LedgerError(
              `cannot rebase to ${base_currency}: the conversion on ${ev.date} (${ev.from_amount} ${ev.from_currency} -> ${ev.to_amount} ${ev.to_currency}) has no ${base_currency} side. Every conversion must have one side in the base currency.`
            );
          }
        }
        tab.base_currency = base_currency;
        try {
          const fold = foldTab(tab);
          if (fold.rates.declared.has(base_currency)) {
            throw new LedgerError(
              `cannot rebase to ${base_currency}: a rate is declared for it, and a tab cannot hold a rate against its own base. Clear it first (declare_rate with no rate), then rebase.`
            );
          }
        } catch (e) {
          tab.base_currency = previous;
          throw e;
        }
        save(ledger);
        return { rebased_from: previous, ...balancesReport(tab) };
      })
  );

  server.registerTool(
    "delete_tab",
    {
      description:
        "Permanently delete a tab and its whole event log. Irreversible and unrecoverable. Tell the user how many events will be lost and get a clear yes before passing confirm: true.",
      inputSchema: { tab: z.string(), confirm: z.boolean().optional() },
    },
    async ({ tab: tabName, confirm }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        if (confirm !== true) {
          throw new LedgerError(
            `refusing to delete "${tab.name}": it holds ${tab.events.length} event(s) and deletion cannot be undone. Confirm with the user, then pass confirm: true.`
          );
        }
        ledger.tabs = ledger.tabs.filter((t) => t.id !== tab.id);
        save(ledger);
        return {
          deleted: tab.name,
          events_discarded: tab.events.length,
          tabs_remaining: ledger.tabs.map((t) => t.name),
        };
      })
  );

  server.registerTool(
    "list_events",
    {
      description:
        "The tab's raw event log in order, with each event's id and a one-line summary. This is where you get the event_id that edit_event and remove_event need.",
      inputSchema: { tab: z.string() },
    },
    async ({ tab: tabName }) =>
      run(() => {
        const tab = findTab(load(), tabName);
        return {
          tab: tab.name,
          base_currency: tab.base_currency,
          events: tab.events.map((ev, i) => ({
            position: i + 1,
            id: ev.id,
            kind: ev.kind,
            date: ev.date,
            summary: summarize(ev),
          })),
        };
      })
  );

  server.registerTool(
    "edit_event",
    {
      description:
        "Correct an event that was recorded wrongly, patching only the fields you pass and leaving it where it is in the log. Use list_events to find the event id. Everything downstream revalues, but the event keeps its position, so settlements still lock at the rate that was in force when they happened. Editable fields depend on the event: expense (description, amount, currency, paid_by, shares), settlement (amount, currency, from, to), conversion (from_amount, from_currency, to_amount, to_currency), rate (currency, rate); every kind also takes date and note. To turn a rate declaration into a clearing, remove_event it instead.",
      inputSchema: {
        tab: z.string(),
        event_id: z.string(),
        date: isoDate,
        description: z.string().trim().min(1).optional(),
        amount: money.optional(),
        currency: currency.optional(),
        paid_by: z.string().optional(),
        shares: z
          .array(z.object({ participant: z.string(), pct: money.optional(), amount: money.optional() }))
          .min(1)
          .optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        from_amount: money.optional(),
        from_currency: currency.optional(),
        to_amount: money.optional(),
        to_currency: currency.optional(),
        rate: money.optional(),
        note: z.string().optional(),
      },
    },
    async ({ tab: tabName, event_id, ...patch }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        const { event: before, index } = findEvent(tab, event_id);

        const supplied = Object.entries(patch)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k);
        if (supplied.length === 0) {
          throw new LedgerError("nothing to edit: pass at least one field to change");
        }
        const allowed = EDITABLE_FIELDS[before.kind];
        const rejected = supplied.filter((k) => !allowed.includes(k));
        if (rejected.length > 0) {
          throw new LedgerError(
            `cannot set ${rejected.join(", ")} on a ${before.kind} event; its editable fields are: ${allowed.join(", ")}`
          );
        }

        let after: TabEvent;
        switch (before.kind) {
          case "expense": {
            const amount = patch.amount ?? before.amount;
            const ccy = patch.currency ?? before.currency;
            after = {
              ...before,
              date: patch.date ?? before.date,
              description: patch.description?.trim() ?? before.description,
              amount,
              currency: ccy,
              paid_by: patch.paid_by ? ensureParticipant(ledger, patch.paid_by) : before.paid_by,
              // Re-checked even when only the amount moved: fixed shares no longer sum to it.
              shares: normalizeShares(ledger, patch.shares ?? before.shares, new Decimal(amount), ccy),
              ...(patch.note !== undefined ? { note: patch.note } : {}),
            };
            break;
          }
          case "settlement": {
            const from = patch.from ? ensureParticipant(ledger, patch.from) : before.from;
            const to = patch.to ? ensureParticipant(ledger, patch.to) : before.to;
            if (from === to) throw new LedgerError("from and to must be different participants");
            after = {
              ...before,
              date: patch.date ?? before.date,
              amount: patch.amount ?? before.amount,
              currency: patch.currency ?? before.currency,
              from,
              to,
              ...(patch.note !== undefined ? { note: patch.note } : {}),
            };
            break;
          }
          case "conversion": {
            const fromCcy = patch.from_currency ?? before.from_currency;
            const toCcy = patch.to_currency ?? before.to_currency;
            if (fromCcy === toCcy) throw new LedgerError("from and to currencies must differ");
            if (fromCcy !== tab.base_currency && toCcy !== tab.base_currency) {
              throw new LedgerError(
                `one side of a conversion must be the tab's base currency (${tab.base_currency})`
              );
            }
            after = {
              ...before,
              date: patch.date ?? before.date,
              from_amount: patch.from_amount ?? before.from_amount,
              from_currency: fromCcy,
              to_amount: patch.to_amount ?? before.to_amount,
              to_currency: toCcy,
              ...(patch.note !== undefined ? { note: patch.note } : {}),
            };
            break;
          }
          case "rate": {
            const ccy = patch.currency ?? before.currency;
            if (ccy === tab.base_currency) {
              throw new LedgerError(`cannot declare a rate for the base currency (${tab.base_currency})`);
            }
            after = {
              ...before,
              date: patch.date ?? before.date,
              currency: ccy,
              ...(patch.rate !== undefined ? { foreign_per_base: patch.rate } : {}),
              ...(patch.note !== undefined ? { note: patch.note } : {}),
            };
            break;
          }
        }

        // Replace the slot rather than mutate: same index, same id, so the fold walks it in
        // exactly the same order and no settlement relocks at a different rate.
        commitLog(tab, () => void (tab.events[index] = after), () => save(ledger));
        return { before, after, position: `${index + 1} of ${tab.events.length}`, ...balancesReport(tab) };
      })
  );

  server.registerTool(
    "remove_event",
    {
      description:
        "Delete any event from a tab by id, not just the most recent one. Refused if the rest of the log then cannot be valued — e.g. removing a conversion that a later settlement locked its rate against. Use get_balances or list_tabs to find the event id.",
      inputSchema: { tab: z.string(), event_id: z.string() },
    },
    async ({ tab: tabName, event_id }) =>
      run(() => {
        const ledger = load();
        const tab = findTab(ledger, tabName);
        ensureOpen(tab);
        const { event: removed, index } = findEvent(tab, event_id);
        commitLog(tab, () => void tab.events.splice(index, 1), () => save(ledger));
        return { removed, ...balancesReport(tab) };
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
