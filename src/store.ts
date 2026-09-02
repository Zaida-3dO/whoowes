import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, LedgerError, Tab, TabEvent } from "./types.js";

const DATA_DIR = process.env.WHOOWES_DIR ?? path.join(os.homedir(), ".whoowes");
const FILE = path.join(DATA_DIR, "ledger.json");

/** How many times a mutation is re-applied against a moved ledger before giving up. */
const MAX_ATTEMPTS = 5;

/**
 * A write refused because the ledger moved on disk since it was read. Internal to the retry
 * loop, but it extends LedgerError so that if one ever escapes withLedger it surfaces to the
 * user as a refusal rather than crashing the server.
 */
export class LedgerStaleError extends LedgerError {}

/**
 * The version of the ledger a Ledger object was read from, so a write can refuse to
 * overwrite a file that moved underneath it.
 *
 * It is a SHA-256 of the exact bytes on disk, not an mtime or a size. mtime is the cheap
 * option and the wrong one here: over SMB — the deployment this exists for, a QNAP share —
 * timestamp granularity is coarse (FAT-derived 2s rounding is still observable through SMB,
 * and client-side attribute caching can serve a stale stat for a second or more), so two
 * writes inside the same tick are routinely indistinguishable. That is precisely the case
 * CAS has to catch. Size+mtime narrows it but still misses the most common correction of
 * all — editing an amount from "10" to "20", or any same-length field — which changes
 * neither. A hash is exact regardless of filesystem, clock skew or attribute caching, and
 * the cost is re-reading a file of a few hundred KB that the page cache almost certainly
 * still holds.
 *
 * MISSING is the version of "there is no ledger file", so first-write-wins is enforced too:
 * two processes both starting from an empty ledger cannot both create it.
 */
const MISSING = "absent";

type Version = string;

function versionOf(text: string): Version {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Reads the ledger together with the version it was read at. */
function readWithVersion(): { ledger: Ledger; version: Version } {
  let text: string;
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ledger: { participants: [], tabs: [] }, version: MISSING };
    }
    throw e;
  }
  return { ledger: JSON.parse(text) as Ledger, version: versionOf(text) };
}

/** The version of what is on disk right now, without parsing it. */
function currentVersion(): Version {
  try {
    return versionOf(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return MISSING;
    throw e;
  }
}

/**
 * Which version each loaded Ledger came from, keyed by the object itself — so the Ledger
 * shape is unchanged and no caller has to thread a token through. Weak, so a ledger that
 * goes out of scope is collectable.
 */
const loadedAt = new WeakMap<Ledger, Version>();

export function load(): Ledger {
  const { ledger, version } = readWithVersion();
  loadedAt.set(ledger, version);
  return ledger;
}

/**
 * Writes the ledger back, but only if the file is still the one it was loaded from.
 *
 * The rename has always been atomic; the read-modify-write around it never was. Two writers
 * that both load the same snapshot both write a whole file back, and the second silently
 * erases the first's events. So: capture the version at load, re-check it immediately before
 * the rename, and refuse the write if it moved.
 *
 * The re-check and the rename are not themselves one atomic operation — nothing portable is
 * — so this narrows the losing window to the microseconds between them rather than closing
 * it. That is a real and deliberate limit, and still a large improvement on a window that
 * previously spanned an entire tool call. Closing it fully needs a lock, which was rejected:
 * O_EXCL create is not reliably atomic over SMB/NFS, and a crashed holder wedges the ledger
 * until a stale-lock timeout, which reintroduces the race it was meant to remove.
 *
 * A Ledger not produced by load() (a hand-built one, in tests) has no recorded version and is
 * written unconditionally — there is no prior read for it to be stale against.
 */
export function save(ledger: Ledger): void {
  const expected = loadedAt.get(ledger);
  if (expected !== undefined && currentVersion() !== expected) {
    throw new LedgerStaleError(
      "the ledger changed on disk since it was read, so writing it back would erase that change"
    );
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  const text = JSON.stringify(ledger, null, 2);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, FILE);
  // This object now corresponds to what is on disk, so a caller may legitimately save it
  // again (add_participant, and any handler that saves twice, rely on this).
  loadedAt.set(ledger, versionOf(text));
}

/**
 * Runs a whole load -> mutate -> save cycle, re-applying the mutation from scratch against a
 * fresh read if the ledger moved underneath it.
 *
 * This, and not save(), is where the retry has to live: save() receives an already-mutated
 * Ledger, by which point the original intent is gone and there is nothing left to re-apply.
 * `apply` is therefore handed a freshly loaded ledger on every attempt and must do its whole
 * job against that one — locate the tab, validate, mutate, persist.
 *
 * Re-running the entire body is what makes the retry correct rather than hopeful: validation
 * that depends on the other writer's change (a tab name that is now taken, a participant that
 * now exists, a fold that no longer balances) is re-evaluated against the state that actually
 * exists. A retry is therefore allowed to fail, and that is the point — it fails loudly
 * instead of overwriting.
 *
 * The result of the winning attempt is returned.
 */
export function withLedger<T>(apply: (ledger: Ledger) => T): T {
  let last: LedgerStaleError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return apply(load());
    } catch (e) {
      if (!(e instanceof LedgerStaleError)) throw e;
      last = e;
    }
  }
  throw new LedgerError(
    `could not write the ledger: another writer changed it ${MAX_ATTEMPTS} times in a row while ` +
      `this change was being applied (${last?.message ?? "stale"}). Nothing was written — try again.`
  );
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
