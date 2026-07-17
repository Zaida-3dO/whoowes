import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { createServer } from "./mcp.js";
import { ledgerFilePath, load } from "./store.js";
import { renderError, renderTabList, renderTabPage } from "./view.js";
import { LedgerError } from "./types.js";

/**
 * Streamable-HTTP entry point, for running whoowes as a shared service (one process
 * owning one ledger file) rather than per-client over stdio.
 *
 * Stateless: each request gets a fresh server + transport, so any number of clients
 * (and Patrick) can share the tabs. Writes are safe because every tool handler does
 * load -> mutate -> save synchronously within a single tick, and save() is atomic
 * (tmp file + rename) -- so this process serialises all writes to the ledger. That
 * only holds while this is the ONLY writer: don't point another whoowes instance at
 * the same WHOOWES_DIR.
 */
const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, server: "whoowes", ledger: ledgerFilePath() });
});

/**
 * The live page. Same process, same ledger, rendered per request — so it cannot drift from
 * what the tools report the way a hand-built snapshot does.
 */
app.get("/view", (req: Request, res: Response) => {
  // Explicit charset: the page is full of ₦/£/— and browsers otherwise guess latin-1 and
  // mojibake the lot.
  res.type("text/html; charset=utf-8");
  const asString = (v: unknown) => (typeof v === "string" ? v : undefined);
  const wanted = asString(req.query.tab);
  const who = asString(req.query.who);
  try {
    const ledger = load();
    if (wanted === undefined) {
      const open = ledger.tabs.filter((t) => t.status === "open");
      // One obvious tab: go straight to it. Otherwise make the choice explicit.
      if (open.length === 1 && ledger.tabs.length === 1) {
        res.send(renderTabPage(open[0]!, who, stamp()));
        return;
      }
      res.send(renderTabList(ledger, stamp()));
      return;
    }
    const key = wanted.trim().toLowerCase();
    const tab = ledger.tabs.find((t) => t.name.trim().toLowerCase() === key || t.id === wanted);
    if (!tab) {
      res.status(404).send(renderError(`No tab named "${wanted}".`));
      return;
    }
    res.send(renderTabPage(tab, who, stamp()));
  } catch (e) {
    // A tab that cannot fold is a real state the page must survive, not a 500.
    if (e instanceof LedgerError) {
      res.status(422).send(renderError(e.message));
      return;
    }
    console.error("/view failed:", e);
    res.status(500).send(renderError("Something went wrong rendering this tab."));
  }
});

function stamp(): string {
  return new Date().toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: process.env.TZ || "Europe/London",
  });
}

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no session to stream from or tear down.
const notAllowed = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "method not allowed: this server is stateless (POST only)" },
    id: null,
  });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.listen(PORT, HOST, () => {
  console.error(`whoowes MCP (streamable-http) listening on ${HOST}:${PORT}/mcp — ledger: ${ledgerFilePath()}`);
});
