import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, LedgerError, Tab, TabEvent } from "./types.js";

const DATA_DIR = process.env.WHOOWES_DIR ?? path.join(os.homedir(), ".whoowes");
const FILE = path.join(DATA_DIR, "ledger.json");

export function load(): Ledger {
  if (!fs.existsSync(FILE)) return { participants: [], tabs: [] };
  return JSON.parse(fs.readFileSync(FILE, "utf8")) as Ledger;
}

export function save(ledger: Ledger): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
  fs.renameSync(tmp, FILE);
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function findTab(ledger: Ledger, name: string): Tab {
  const n = normalizeName(name);
  const tab = ledger.tabs.find((t) => normalizeName(t.name) === n || t.id === name);
  if (!tab) throw new LedgerError(`no tab named "${name}". Existing tabs: ${ledger.tabs.map((t) => t.name).join(", ") || "(none)"}`);
  return tab;
}

/** Locates an event by id, with its position — callers must patch in place, never re-append. */
export function findEvent(tab: Tab, eventId: string): { event: TabEvent; index: number } {
  const index = tab.events.findIndex((e) => e.id === eventId);
  if (index === -1) {
    throw new LedgerError(
      `no event with id "${eventId}" on tab "${tab.name}". Its ${tab.events.length} event(s) are: ${
        tab.events.map((e) => `${e.id} (${e.kind})`).join(", ") || "(none)"
      }`
    );
  }
  return { event: tab.events[index]!, index };
}

export function ensureOpen(tab: Tab): void {
  if (tab.status !== "open") throw new LedgerError(`tab "${tab.name}" is closed; reopen it to add events`);
}

export function ensureParticipant(ledger: Ledger, name: string): string {
  const n = normalizeName(name);
  if (!ledger.participants.includes(n)) {
    throw new LedgerError(`unknown participant "${name}". Known: ${ledger.participants.join(", ") || "(none)"}. Use add_participant first.`);
  }
  return n;
}

export function ledgerFilePath(): string {
  return FILE;
}
