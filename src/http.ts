import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { createServer } from "./mcp.js";
import { ledgerFilePath } from "./store.js";

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
