import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { balancesReport, foldTab, personView, shareAmount, summarize } from "./fold.js";
import { dataDir, ensureOpen, ensureParticipant, findEvent, findTab, ledgerFilePath, load, normalizeName, save, withLedger } from "./store.js";
import { Ledger, LedgerError, Share, Tab, TabEvent } from "./types.js";
import { renderTabList, renderTabPage } from "./view.js";

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
 * total. Shared by add_entry (expense) and edit_event so an edited expense is held to the same rule —
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

// ===== per-tool-call logging instrument ======================================
// One JSON line per tool call, written to a daily file under <WHOOWES_DIR>/logs/.
// No tool arguments or exception messages are ever read here — see the no-PII
// contract below. A failed write must never fail the tool call: logToolCall's own
// try/catch is unconditional, so nothing it does can propagate to a caller.
// Spec: haven-assistant/first-mate/tasks/T-20260811-mcp-context-cost/reviews/
//       scout-d-logging-instrument-spec-nairobi-f28.md
//
// Path choice, deliberately different from the spec's literal `/data/logs/`: whoowes
// no longer runs as a container with a `/data` bind mount (the HTTP/Docker deployment
// was retired September 2026 — see README's Transports section). It runs as an npx
// stdio process today, spawned per-client with its own `WHOOWES_DIR` (the same env var
// the ledger already resolves from — see store.ts): `/workspace/haven-assistant/apps/
// whoowes` under the Patrick gateway, a bare `~/.whoowes` for an unconfigured personal
// machine, and potentially something else again for a future deployment. Hardcoding
// `/data/logs` would silently write nowhere meaningful (or fail) in every one of those
// shapes. Reusing `dataDir()` — the same resolution the ledger itself uses — means logs
// always land next to the ledger they describe, under every deployment shape, with zero
// extra configuration.
const SERVER_NAME = "whoowes";

function logToolCall(tool: string, durationMs: number, ok: boolean, errorClass?: string): void {
  // Must NEVER throw past this point — a failed write must never fail a tool call.
  try {
    const logDir = path.join(dataDir(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const now = new Date();
    const day = londonISO(now).slice(0, 10); // "YYYY-MM-DD"
    const file = path.join(logDir, `tool-calls-${day}.jsonl`);
    const record: Record<string, unknown> = {
      ts: londonISO(now),
      server: SERVER_NAME,
      tool,
      duration_ms: Math.round(durationMs * 10) / 10,
      ok,
    };
    if (errorClass) record.error_class = errorClass;
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // disk full / read-only volume / anything else — swallow, never surface to the caller
  }
}

/** Dependency-free Europe/London ISO-8601-with-offset formatter (e.g. "...+01:00" in
 *  BST, "...+00:00" in GMT). Node's own Intl/Date resolves Europe/London correctly
 *  regardless of host OS tzdata, because Node ships its own bundled ICU/tzdata. */
function londonISO(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d).reduce((a, p) => ((a[p.type] = p.value), a), {} as Record<string, string>);
  const asLondonUTC = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const offsetMin = Math.round((asLondonUTC - d.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}${sign}${oh}:${om}`;
}
// ===== end logging instrument =================================================

/** What edit_event may patch per kind. `kind` and `id` are immutable — an edit corrects an
 *  entry, it does not turn one kind of event into another. */
const EDITABLE_FIELDS: Record<TabEvent["kind"], string[]> = {
  expense: ["date", "description", "amount", "currency", "paid_by", "shares", "note"],
  settlement: ["date", "amount", "currency", "from", "to", "note"],
  conversion: ["date", "from_amount", "from_currency", "to_amount", "to_currency", "note"],
  rate: ["date", "currency", "rate", "note"],
};

/**
 * Same wall-clock stamp the /view route prints, so a rendered file and a served page
 * are indistinguishable apart from the instant they were generated.
 */
function stamp(): string {
  return new Date().toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: process.env.TZ || "Europe/London",
  });
}

/** Where display writes. Deliberately NOT the ledger dir: these are disposable renders,
 *  and the ledger dir is the event log. Haven-in-a-container sets the env var to a media
 *  dir it can serve; on a PC the OS temp dir is a path the user can just click. */
function displayDir(): string {
  return process.env.WHOOWES_DISPLAY_DIR ?? os.tmpdir();
}

/** Filename-safe slug of a tab name. Empty result (e.g. a name of only punctuation)
 *  falls back to "tab" so we never produce a dotfile or a bare timestamp. */
function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "tab";
}

/**
 * Writes a rendered page and returns its absolute path. Mirrors store.ts save(): the
 * directory is created on demand rather than required to pre-exist.
 */
function writePage(slug: string, html: string): string {
  const dir = displayDir();
  fs.mkdirSync(dir, { recursive: true });
  // Sortable, second-resolution, filename-safe -- the slug and timestamp are there to be
  // read by a human browsing their temp dir. Neither is unique: two renders can land in the
  // same second, and two different tabs can slugify alike ("Team Dinner" and "team-dinner"
  // both give team-dinner). Either way the second write would silently destroy the first
  // while the tool still reported success, so a random suffix -- not the name -- is what
  // actually carries uniqueness here.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const unique = randomUUID().slice(0, 8);
  const file = path.join(dir, `whoowes-${slug}-${ts}-${unique}.html`);
  fs.writeFileSync(file, html, "utf8");
  return path.resolve(file);
}

// ===== fold dispatch support ==================================================

type Spec = { required: string[]; optional: string[] };

const ENTRY_SPEC = {
  expense: { required: ["tab", "description", "amount", "currency", "paid_by", "shares"], optional: ["note", "date"] },
  settlement: { required: ["tab", "from", "to", "amount", "currency"], optional: ["note", "date"] },
  conversion: { required: ["tab", "from_amount", "from_currency", "to_amount", "to_currency"], optional: ["note", "date"] },
  rate: { required: ["tab", "currency"], optional: ["rate", "note", "date"] },
} satisfies Record<string, Spec>;

const TAB_SPEC = {
  create: { required: ["name", "base_currency"], optional: [] },
  add_participant: { required: ["name"], optional: [] },
  set_status: { required: ["tab", "status"], optional: [] },
  set_base_currency: { required: ["tab", "base_currency"], optional: [] },
} satisfies Record<string, Spec>;

const VIEW_SPEC = {
  tabs: { required: [], optional: [] },
  balances: { required: ["tab"], optional: [] },
  person: { required: ["tab", "participant"], optional: [] },
  events: { required: ["tab"], optional: [] },
} satisfies Record<string, Spec>;

/**
 * Refuses, by name, every supplied field that does not belong to the chosen verb, and every
 * required field that is missing. The schemas are flat and passthrough, so the handler sees
 * exactly what the caller sent; without this a field meant for a different verb would be
 * accepted and ignored. Returns the args unchanged.
 */
function assertFields(label: string, args: Record<string, unknown>, spec: Spec): Record<string, unknown> {
  const supplied = Object.keys(args).filter((k) => args[k] !== undefined);
  const allowed = [...spec.required, ...spec.optional];
  const foreign = supplied.filter((k) => !allowed.includes(k));
  if (foreign.length > 0) {
    throw new LedgerError(
      `${label} does not take: ${foreign.join(", ")}. It takes: ${allowed.length ? allowed.join(", ") : "(no fields)"}`
    );
  }
  const missing = spec.required.filter((k) => !supplied.includes(k));
  if (missing.length > 0) {
    throw new LedgerError(`${label} requires: ${missing.join(", ")}`);
  }
  return args;
}

const today = () => new Date().toISOString().slice(0, 10);

// ----- ops: the bodies of the former per-verb tools, unchanged in behaviour -------------

function opCreateTab({ name, base_currency }: { name: string; base_currency: string }) {
  return withLedger((ledger) => {
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
  });
}

function opAddParticipant({ name }: { name: string }) {
  return withLedger((ledger) => {
    const n = normalizeName(name);
    if (!ledger.participants.includes(n)) {
      ledger.participants.push(n);
      save(ledger);
    }
    return { participants: ledger.participants };
  });
}

function opSetTabStatus({ tab: tabName, status }: { tab: string; status: "open" | "closed" }) {
  return withLedger((ledger) => {
    const tab = findTab(ledger, tabName);
    tab.status = status;
    save(ledger);
    return { tab: tab.name, status: tab.status };
  });
}

function opSetBaseCurrency({ tab: tabName, base_currency }: { tab: string; base_currency: string }) {
  return withLedger((ledger) => {
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
          `cannot rebase to ${base_currency}: a rate is declared for it, and a tab cannot hold a rate against its own base. Clear it first (add_entry type "rate" with no rate), then rebase.`
        );
      }
    } catch (e) {
      tab.base_currency = previous;
      throw e;
    }
    save(ledger);
    return { rebased_from: previous, ...balancesReport(tab) };
  });
}

function opAddExpense(a: {
  tab: string;
  description: string;
  amount: string;
  currency: string;
  paid_by: string;
  shares: { participant: string; pct?: string; amount?: string }[];
  note?: string;
  date?: string;
}) {
  return withLedger((ledger) => {
    const tab = findTab(ledger, a.tab);
    ensureOpen(tab);
    const payer = ensureParticipant(ledger, a.paid_by);
    const normalized = normalizeShares(ledger, a.shares, new Decimal(a.amount), a.currency);
    commitEvent(
      tab,
      {
        kind: "expense",
        id: randomUUID(),
        date: a.date ?? today(),
        description: a.description.trim(),
        amount: a.amount,
        currency: a.currency,
        paid_by: payer,
        shares: normalized,
        ...(a.note ? { note: a.note } : {}),
      },
      () => save(ledger)
    );
    return balancesReport(tab);
  });
}

function opAddSettlement(a: {
  tab: string;
  from: string;
  to: string;
  amount: string;
  currency: string;
  note?: string;
  date?: string;
}) {
  return withLedger((ledger) => {
    const tab = findTab(ledger, a.tab);
    ensureOpen(tab);
    const f = ensureParticipant(ledger, a.from);
    const t = ensureParticipant(ledger, a.to);
    if (f === t) throw new LedgerError("from and to must be different participants");
    commitEvent(
      tab,
      {
        kind: "settlement",
        id: randomUUID(),
        date: a.date ?? today(),
        amount: a.amount,
        currency: a.currency,
        from: f,
        to: t,
        ...(a.note ? { note: a.note } : {}),
      },
      () => save(ledger)
    );
    return balancesReport(tab);
  });
}

function opAddConversion(a: {
  tab: string;
  from_amount: string;
  from_currency: string;
  to_amount: string;
  to_currency: string;
  note?: string;
  date?: string;
}) {
  return withLedger((ledger) => {
    const tab = findTab(ledger, a.tab);
    ensureOpen(tab);
    if (a.from_currency === a.to_currency) throw new LedgerError("from and to currencies must differ");
    if (a.from_currency !== tab.base_currency && a.to_currency !== tab.base_currency) {
      throw new LedgerError(`one side of a conversion must be the tab's base currency (${tab.base_currency})`);
    }
    commitEvent(
      tab,
      {
        kind: "conversion",
        id: randomUUID(),
        date: a.date ?? today(),
        from_amount: a.from_amount,
        from_currency: a.from_currency,
        to_amount: a.to_amount,
        to_currency: a.to_currency,
        ...(a.note ? { note: a.note } : {}),
      },
      () => save(ledger)
    );
    return balancesReport(tab);
  });
}

function opDeclareRate(a: { tab: string; currency: string; rate?: string; note?: string; date?: string }) {
  return withLedger((ledger) => {
    const tab = findTab(ledger, a.tab);
    ensureOpen(tab);
    if (a.currency === tab.base_currency) {
      throw new LedgerError(`cannot declare a rate for the base currency (${tab.base_currency})`);
    }
    commitEvent(
      tab,
      {
        kind: "rate",
        id: randomUUID(),
        date: a.date ?? today(),
        currency: a.currency,
        ...(a.rate !== undefined ? { foreign_per_base: a.rate } : {}),
        ...(a.note ? { note: a.note } : {}),
      },
      () => save(ledger)
    );
    return balancesReport(tab);
  });
}

function opViewTabs() {
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
}

function opViewBalances({ tab }: { tab: string }) {
  return balancesReport(findTab(load(), tab));
}

function opViewPerson({ tab, participant }: { tab: string; participant: string }) {
  const ledger = load();
  return personView(findTab(ledger, tab), ensureParticipant(ledger, participant));
}

function opViewEvents({ tab: tabName }: { tab: string }) {
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
}

/**
 * Builds a fully-registered server. A factory rather than a singleton because the
 * HTTP transport is stateless: every request gets its own server + transport pair.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "whoowes", version: "0.2.0" });

  // ===== per-tool-call logging instrument =====================================
  // Wraps McpServer's OWN registration method once, so every existing
  // server.registerTool(...) call below (unedited) gets timed + logged automatically.
  // CRITICAL: .bind(server) — a bare `server.registerTool` reference loses its `this`
  // binding in JS, and registerTool's body reads `this._registeredTools` — an unbound
  // call throws immediately.
  const _origRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: any, cb: (...a: any[]) => any) => {
    const wrapped = async (...args: any[]) => {
      const t0 = process.hrtime.bigint();
      try {
        const result = await cb(...args);
        const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
        // whoowes' own run()/fail() helpers return {isError:true} rather than throwing
        // for expected business-rule failures (LedgerError) — ok must reflect that, not
        // just "didn't throw".
        logToolCall(name, durationMs, !(result && (result as any).isError));
        return result;
      } catch (e) {
        const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
        // error_class only — NEVER e.message: LedgerError messages routinely embed tab
        // names, descriptions, participants and amounts (see the throw sites throughout
        // this file, e.g. the tab set_base_currency rebase refusal). See the no-PII contract
        // above logToolCall.
        logToolCall(name, durationMs, false, e instanceof Error ? e.constructor.name : "Error");
        throw e; // re-throw unchanged — existing MCP error handling is untouched
      }
    };
    return _origRegisterTool(name, config, wrapped);
  }) as typeof server.registerTool;
  // ===== end logging instrument =================================================

  // ===== folded tools ==========================================================
  // Three tools replace twelve (see CHANGELOG 0.2.0). Each takes its verb as a required
  // enum field and dispatches to the same op the old tool ran, so the event log written to
  // ledger.json is identical. The schema is deliberately flat (one object, every field
  // optional) with .passthrough(): zod would otherwise strip unknown keys before the
  // handler runs and a misplaced field would vanish silently. assertFields() then refuses,
  // by name, anything that does not belong to the chosen verb.

  const shareSchema = z.array(
    z.object({ participant: z.string(), pct: money.optional(), amount: money.optional() })
  );

  server.registerTool(
    "add_entry",
    {
      description:
        "Record an entry on a tab. type picks the kind and which fields apply. " +
        "expense: tab, description, amount, currency, paid_by, shares (all pct summing to 100, or all fixed amounts summing to the total; include the payer's own share if they consumed part of it), optional note, date. " +
        "settlement: tab, from, to, amount, currency, optional note, date; a payment between two people, locked at the tab's cumulative rate when recorded, so a conversion for that currency must exist first. " +
        "conversion: tab, from_amount, from_currency, to_amount, to_currency, optional note, date; a real currency conversion, one side must be the base currency; the tab's rate is the weighted average of all conversions and revalues every expense in that currency. " +
        "rate: tab, currency, optional rate, note, date; manually declare units of currency per 1 base unit, overriding the conversions average; omit rate to clear the declaration. " +
        "Use note for context that is not the description. Fields that do not belong to the chosen type are refused by name.",
      inputSchema: z
        .object({
          type: z.enum(["expense", "settlement", "conversion", "rate"]),
          tab: z.string().optional(),
          description: z.string().trim().min(1).optional(),
          amount: money.optional(),
          currency: currency.optional(),
          paid_by: z.string().optional(),
          shares: shareSchema.min(1).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          from_amount: money.optional(),
          from_currency: currency.optional(),
          to_amount: money.optional(),
          to_currency: currency.optional(),
          rate: money.optional(),
          note: z.string().optional(),
          date: isoDate,
        })
        .passthrough(),
    },
    async ({ type, ...args }) =>
      run(() => {
        const a = assertFields(`add_entry type "${type}"`, args, ENTRY_SPEC[type]) as any;
        switch (type) {
          case "expense":
            return opAddExpense(a);
          case "settlement":
            return opAddSettlement(a);
          case "conversion":
            return opAddConversion(a);
          case "rate":
            return opDeclareRate(a);
        }
      })
  );

  server.registerTool(
    "tab",
    {
      description:
        "Manage tabs and participants. action picks the operation and which fields apply. " +
        "create: name, base_currency; a new tab (a self-contained event or trip ledger); balances are reported in its base currency. " +
        "add_participant: name; participants are global and reusable across tabs. " +
        "set_status: tab, status (open|closed); a closed tab accepts no further events. " +
        "set_base_currency: tab, base_currency; everything revalues retroactively and conversions re-read themselves from the new side; refused if any conversion has no side in the new base, or a rate is declared for it. " +
        "Fields that do not belong to the chosen action are refused by name.",
      inputSchema: z
        .object({
          action: z.enum(["create", "add_participant", "set_status", "set_base_currency"]),
          name: z.string().trim().min(1).optional(),
          tab: z.string().optional(),
          base_currency: currency.optional(),
          status: z.enum(["open", "closed"]).optional(),
        })
        .passthrough(),
    },
    async ({ action, ...args }) =>
      run(() => {
        const a = assertFields(`tab action "${action}"`, args, TAB_SPEC[action]) as any;
        switch (action) {
          case "create":
            return opCreateTab(a);
          case "add_participant":
            return opAddParticipant(a);
          case "set_status":
            return opSetTabStatus(a);
          case "set_base_currency":
            return opSetBaseCurrency(a);
        }
      })
  );

  server.registerTool(
    "view",
    {
      description:
        "Read ledger state. what picks the view and which fields apply. " +
        "tabs: no fields; every tab with status, base currency and event count, plus the participants. " +
        "balances: tab; per-participant net position in the base currency, cumulative exchange rates, and amounts that cannot be valued yet. " +
        "person: tab, participant; what they were meant to pay, what they paid for, settlements made and received, and their net position. " +
        "events: tab; the raw event log in order with each event's id and a one-line summary; this is where edit_event and remove_event get their event_id. " +
        "Fields that do not belong to the chosen view are refused by name.",
      inputSchema: z
        .object({
          what: z.enum(["tabs", "balances", "person", "events"]),
          tab: z.string().optional(),
          participant: z.string().optional(),
        })
        .passthrough(),
    },
    async ({ what, ...args }) =>
      run(() => {
        const a = assertFields(`view what "${what}"`, args, VIEW_SPEC[what]) as any;
        switch (what) {
          case "tabs":
            return opViewTabs();
          case "balances":
            return opViewBalances(a);
          case "person":
            return opViewPerson(a);
          case "events":
            return opViewEvents(a);
        }
      })
  );

  server.registerTool(
    "display",
    {
      description:
        "Render a tab as a standalone HTML page on disk and return its absolute path, for opening in a browser. Shows rates in force, who owes what, every entry with its split, and what has been settled. Pass tab to pick one (omit it to get the tab list, or go straight to the only tab if there is just one), and who to lead with one participant's breakdown. The file is a snapshot of this moment, not a live page: render again to refresh.",
      inputSchema: {
        tab: z.string().optional(),
        who: z.string().optional(),
      },
    },
    async ({ tab: wanted, who }) =>
      run(() => {
        const ledger = load();
        const generatedAt = stamp();

        if (wanted === undefined) {
          const open = ledger.tabs.filter((t) => t.status === "open");
          // One obvious tab: go straight to it. Otherwise make the choice explicit.
          if (open.length === 1 && ledger.tabs.length === 1) {
            const only = open[0]!;
            return {
              rendered: only.name,
              path: writePage(slugify(only.name), renderTabPage(only, who, generatedAt)),
              generated_at: generatedAt,
            };
          }
          return {
            rendered: "tab list",
            tabs: ledger.tabs.map((t) => t.name),
            path: writePage("tabs", renderTabList(ledger, generatedAt)),
            generated_at: generatedAt,
          };
        }

        // /view answers an unknown tab with a 404 page because a browser has nowhere else to
        // put the message. A tool does: findTab throws, run() turns that into a refusal that
        // reaches the caller directly, and no dead file is written for them to open.
        const tab = findTab(ledger, wanted);
        return {
          rendered: tab.name,
          path: writePage(slugify(tab.name), renderTabPage(tab, who, generatedAt)),
          generated_at: generatedAt,
        };
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
      run(() =>
        withLedger((ledger) => {
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
      )
  );

  server.registerTool(
    "edit_event",
    {
      description:
        "Correct a recorded event in place by id, patching only the fields you pass; it keeps its position, so settlements keep the rate in force when they happened. Get ids from view what=events. Editable per kind: expense (description, amount, currency, paid_by, shares), settlement (amount, currency, from, to), conversion (from_amount, from_currency, to_amount, to_currency), rate (currency, rate); all kinds also take date and note. To clear a declared rate, remove_event it.",
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
      run(() =>
        withLedger((ledger) => {
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
      )
  );

  server.registerTool(
    "remove_event",
    {
      description:
        "Delete any event from a tab by id, not just the most recent one. Refused if the rest of the log then cannot be valued — e.g. removing a conversion that a later settlement locked its rate against. Use view what=events to find the event id.",
      inputSchema: { tab: z.string(), event_id: z.string() },
    },
    async ({ tab: tabName, event_id }) =>
      run(() =>
        withLedger((ledger) => {
          const tab = findTab(ledger, tabName);
          ensureOpen(tab);
          const { event: removed, index } = findEvent(tab, event_id);
          commitLog(tab, () => void tab.events.splice(index, 1), () => save(ledger));
          return { removed, ...balancesReport(tab) };
        })
      )
  );

  server.registerTool(
    "undo_last_event",
    {
      description: "Remove the most recent event from a tab (use when an entry was recorded wrongly).",
      inputSchema: { tab: z.string() },
    },
    async ({ tab: tabName }) =>
      run(() =>
        withLedger((ledger) => {
          const tab = findTab(ledger, tabName);
          ensureOpen(tab);
          const removed = tab.events.pop();
          if (!removed) throw new LedgerError(`tab "${tab.name}" has no events`);
          save(ledger);
          return { removed, ...balancesReport(tab) };
        })
      )
  );

  return server;
}
