import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { ledgerFilePath } from "./store.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`whoowes MCP server running (ledger: ${ledgerFilePath()})`);
