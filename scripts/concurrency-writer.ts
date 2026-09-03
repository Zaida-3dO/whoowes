/**
 * One half of the concurrency test: a real, separate process performing a single
 * load -> mutate -> save cycle against WHOOWES_DIR, pausing at a file-based barrier so the
 * two writers interleave deterministically instead of hoping the scheduler obliges.
 *
 * argv: <role> <barrierDir>
 *   role       "a" | "b"   which writer this is
 *   barrierDir directory the two processes use to signal each other
 *
 * The interleaving the pair produces is exactly the losing order:
 *   A loads -> B loads -> A saves -> B saves
 * so B holds a snapshot that no longer matches disk at the moment it writes. Driving
 * store.ts directly (rather than a tool) is what lets the barrier sit precisely inside the
 * read-modify-write window without planting test-only hooks in production code.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { findTab } from "../src/store.js";

const [role, barrierDir] = process.argv.slice(2) as ["a" | "b", string];

const flag = (name: string) => path.join(barrierDir, name);
const raise = (name: string) => fs.writeFileSync(flag(name), "1");

/** Blocks until `name` is raised. Synchronous by design: the point is to hold this process
 *  inside its read-modify-write window while the other one moves. */
function waitFor(name: string, timeoutMs = 20000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(flag(name))) {
    if (Date.now() > deadline) throw new Error(`${role}: timed out waiting for "${name}"`);
    // A syscall that is expected to fail, purely to yield a moment without needing async.
    try {
      fs.readFileSync(path.join(barrierDir, "__never"));
    } catch {
      /* expected */
    }
  }
}

const expense = (id: string, description: string) => ({
  kind: "expense" as const,
  id,
  date: "2026-07-02",
  description,
  amount: "10",
  currency: "GBP",
  paid_by: "ope",
  shares: [
    { participant: "ope", pct: "50" },
    { participant: "timi", pct: "50" },
  ],
});

async function main(): Promise<void> {
  // withLedger is the production retry seam; using it here is the whole point of the "retry"
  // variant, and skipping it (RAW=1) is how the bare lost-update race is demonstrated.
  const raw = process.env.WHOOWES_TEST_RAW === "1";
  const { load, save, withLedger } = await import("../src/store.js");

  const cycle = (ledger: ReturnType<typeof load>) => {
    raise(`${role}-loaded`);
    // Neither writer may save until both are holding a snapshot.
    waitFor("a-loaded");
    waitFor("b-loaded");

    const tab = findTab(ledger, "lagos");
    tab.events.push(expense(`${role}1`, `${role.toUpperCase()}-expense`));

    // A saves first; B's write therefore lands against a file that has already moved.
    if (role === "b") waitFor("a-saved");
    save(ledger);
    if (role === "a") raise("a-saved");
    return tab.events.length;
  };

  try {
    if (raw) {
      const n = cycle(load());
      console.log(`${role}:saved:${n}`);
    } else {
      // On a retry, the barrier flags are already raised, so the second attempt runs straight
      // through against freshly loaded state -- which is exactly the behaviour under test.
      const n = withLedger(cycle);
      console.log(`${role}:saved:${n}`);
    }
  } catch (e) {
    console.log(`${role}:failed:${(e as Error).constructor.name}:${(e as Error).message}`);
    process.exitCode = 3;
  }
}

await main();
