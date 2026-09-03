/**
 * The concurrency test for the ledger's read-modify-write path.
 *
 * save() has always been atomic (tmp + rename), but load -> mutate -> save never was: two
 * writers that both load the same snapshot both write a whole file back, and the second
 * silently erases the first's events. These tests interleave two such cycles in the order
 * that loses a write and assert nothing is lost.
 *
 * The two writers are REAL SUBPROCESSES (scripts/concurrency-writer.ts), coordinated by a
 * file barrier, not two module instances in one process. That matters: an earlier draft
 * faked them with cache-busted imports and silently proved nothing, because mcp.ts imports
 * the plain store.js, so both "writers" shared one store module and one WHOOWES_DIR.
 *
 * Every case runs against a scratch WHOOWES_DIR. Nothing here may ever touch a real ledger.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ledger } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WRITER = path.join(here, "concurrency-writer.ts");

const scratch = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `whoowes-${label}-`));

const seedLedger = (): Ledger => ({
  participants: ["ope", "timi"],
  tabs: [
    {
      id: "t1",
      name: "lagos",
      base_currency: "GBP",
      status: "open",
      created_at: "2026-07-16T00:00:00Z",
      events: [],
    },
  ],
});

function seed(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(seedLedger(), null, 2), "utf8");
}

const readLedger = (dir: string): Ledger =>
  JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")) as Ledger;

const descriptions = (dir: string): string[] =>
  readLedger(dir).tabs[0]!.events.map((e) => (e.kind === "expense" ? e.description : e.kind));

const TSX = path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

/**
 * Runs both writers concurrently against one ledger dir and returns their combined output.
 *
 * Must be async/parallel, not spawnSync twice: each writer blocks at the barrier until the
 * OTHER has loaded, so running them one after another deadlocks by construction.
 */
async function runPair(dir: string, raw: boolean): Promise<{ out: string; codes: number[] }> {
  const barrier = scratch("barrier");
  const env = { ...process.env, WHOOWES_DIR: dir, ...(raw ? { WHOOWES_TEST_RAW: "1" } : {}) };

  const one = (role: "a" | "b") =>
    new Promise<{ out: string; code: number }>((resolve) => {
      const p = spawn(process.execPath, [TSX, WRITER, role, barrier], { env });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      const kill = setTimeout(() => p.kill("SIGKILL"), 60000);
      p.on("close", (code) => {
        clearTimeout(kill);
        resolve({ out, code: code ?? -1 });
      });
    });

  const [a, b] = await Promise.all([one("a"), one("b")]);
  fs.rmSync(barrier, { recursive: true, force: true });
  return { out: a.out + b.out, codes: [a.code, b.code] };
}

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message.split("\n").join("\n       ")}`);
  }
}

console.log("concurrency:");

// ── 1. the lost-update race, with the retry seam in place ─────────────────────────
// The headline case. Two processes, interleaved load A, load B, save A, save B. Before CAS
// this loses A's expense silently; after it, B is refused, reloads, re-applies and both
// survive. Mutate the version check in store.ts (e.g. compare to itself) and this fails.
await test("interleaved writers both survive (withLedger retries the loser)", async () => {
  const dir = scratch("race");
  seed(dir);
  const { out } = await runPair(dir, false);
  const got = descriptions(dir);
  assert.ok(got.includes("A-expense"), `A's expense was erased. On disk: [${got.join(", ")}]\n${out}`);
  assert.ok(got.includes("B-expense"), `B's expense was erased. On disk: [${got.join(", ")}]\n${out}`);
  assert.equal(got.length, 2, `expected exactly both events, got [${got.join(", ")}]\n${out}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 2. the raw save() path refuses rather than clobbering ─────────────────────────
// Same interleaving with the retry seam bypassed, so the CAS check itself is what is under
// test. A caller that does not retry must get a loud refusal -- never a silent overwrite.
// This is the case that pins the check itself: delete the check and B "saves" instead.
await test("without a retry seam, the stale writer is refused, not silently applied", async () => {
  const dir = scratch("race-raw");
  seed(dir);
  const { out } = await runPair(dir, true);
  const got = descriptions(dir);
  assert.match(out, /b:failed:LedgerStaleError/, `B should have been refused. Output:\n${out}`);
  assert.ok(got.includes("A-expense"), `A's expense was lost despite B being refused: [${got.join(", ")}]`);
  assert.ok(!got.includes("B-expense"), `B was refused yet its expense landed: [${got.join(", ")}]`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 3. the retry re-applies against the NEW state, not the stale snapshot ─────────
// A concurrency test that passes by luck is the norm, so this forces the mid-flight change
// directly and inspects the outcome rather than trusting a schedule: a writer that loaded an
// empty tab must still end up appending to the tab as it exists after someone else wrote it.
await test("retry re-applies the mutation against the reloaded ledger", async () => {
  const dir = scratch("retry");
  seed(dir);
  process.env.WHOOWES_DIR = dir;
  // Its own module instance: store.ts caches WHOOWES_DIR at module load, so a test that
  // reuses the cached module would run against a previous test's (deleted) directory.
  const { load, save, withLedger } = await import("../src/store.js?retry");

  let attempts = 0;
  const result = withLedger((ledger) => {
    attempts++;
    const tab = ledger.tabs[0]!;
    const seenBefore = tab.events.length;

    // On the first attempt only, a "different process" writes in between the load and the
    // save. It uses its own freshly loaded object, so this is a genuine external change.
    if (attempts === 1) {
      const other = load();
      other.tabs[0]!.events.push({
        kind: "expense", id: "x1", date: "2026-07-01", description: "OTHER",
        amount: "5", currency: "GBP", paid_by: "ope",
        shares: [{ participant: "ope", pct: "100" }],
      });
      save(other);
    }

    tab.events.push({
      kind: "expense", id: "m1", date: "2026-07-02", description: "MINE",
      amount: "10", currency: "GBP", paid_by: "ope",
      shares: [{ participant: "ope", pct: "100" }],
    });
    save(ledger);
    return { seenBefore };
  });

  assert.equal(attempts, 2, "the first attempt must be refused and the body re-run");
  assert.equal(result.seenBefore, 1, "the retry must observe the other writer's event, not the stale empty log");
  const got = descriptions(dir);
  assert.deepEqual(got, ["OTHER", "MINE"], `both events, in order. Got [${got.join(", ")}]`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 4. exhausting the retries fails loudly ────────────────────────────────────────
// A writer that can never win must surface a LedgerError, and must not have written.
await test("exhausted retries throw a LedgerError and write nothing", async () => {
  const dir = scratch("exhaust");
  seed(dir);
  process.env.WHOOWES_DIR = dir;
  const { load, save, withLedger } = await import("../src/store.js?exhaust");
  // LedgerError must come from the SAME module instance as that store, or instanceof fails.
  const { LedgerError } = await import("../src/types.js");

  let attempts = 0;
  assert.throws(
    () =>
      withLedger((ledger) => {
        attempts++;
        // Someone else writes on EVERY attempt, so this can never commit.
        const other = load();
        other.participants.push(`p${attempts}`);
        save(other);

        ledger.tabs[0]!.events.push({
          kind: "expense", id: "n1", date: "2026-07-02", description: "NEVER",
          amount: "10", currency: "GBP", paid_by: "ope",
          shares: [{ participant: "ope", pct: "100" }],
        });
        save(ledger);
      }),
    (e: unknown) =>
      e instanceof LedgerError && /changed it \d+ times in a row/.test((e as Error).message),
    "should surface a LedgerError naming the exhaustion"
  );
  assert.ok(attempts > 1, `should have retried more than once, got ${attempts}`);
  assert.ok(!descriptions(dir).includes("NEVER"), "a failed write must leave no trace");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 5. validation still rejects cleanly, and leaves no trace ──────────────────────
// commitLog restores its snapshot when the fold throws. CAS must not have broken that: a
// rejected change must still write nothing and must not be retried into existence.
await test("a change the fold rejects still leaves no trace", async () => {
  const dir = scratch("reject");
  seed(dir);
  process.env.WHOOWES_DIR = dir;
  const { createServer } = await import("../src/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = createServer();
  const client = new Client({ name: "reject", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);

  // Shares that do not allocate the total: rejected before anything is persisted.
  const res = (await client.callTool({
    name: "add_expense",
    arguments: {
      tab: "lagos", description: "bad", amount: "100", currency: "GBP", paid_by: "ope",
      shares: [{ participant: "ope", pct: "30" }, { participant: "timi", pct: "30" }],
    },
  })) as { content: { text: string }[]; isError?: boolean };

  assert.equal(res.isError, true, "mis-allocated shares must be refused");
  assert.equal(readLedger(dir).tabs[0]!.events.length, 0, "a refused change must not be written");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 6. saving the same ledger object twice is still allowed ──────────────────────
// A writer is stale only against SOMEONE ELSE's write, never its own. save() therefore
// re-records the version after writing; without that, the second save of a handler that
// persists twice (add_participant does, and undo_last_event follows the same shape) would
// throw LedgerStaleError against its own change. Drop the refresh in save() and this fails.
await test("a second save of the same ledger object is not treated as stale", async () => {
  const dir = scratch("resave");
  seed(dir);
  process.env.WHOOWES_DIR = dir;
  const { load, save } = await import("../src/store.js?resave");

  const ledger = load();
  ledger.participants.push("george");
  save(ledger);
  ledger.participants.push("ada");
  save(ledger); // must not throw: this writer is only stale against another writer

  assert.deepEqual(
    readLedger(dir).participants,
    ["ope", "timi", "george", "ada"],
    "both writes from the same object must land"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(failures === 0 ? "concurrency OK" : `concurrency FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
