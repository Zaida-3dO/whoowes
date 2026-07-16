# whoowes

MCP server for self-contained trip/event expense ledgers. You talk to a model
("we paid 200k naira for the hotel, 20% timi 80% george", "george sent me 20k",
"I converted another £60 and got 150k"), the model calls typed tools, and the
ledger does the arithmetic with `decimal.js`. The model never computes a number.

## Model

- A **tab** is a self-contained event (a trip, a house project) with a base currency.
- Everything is an append-only **event**: `expense`, `settlement`, or `conversion`.
- All state (balances, rates) is **derived** by refolding the full event log on
  every read. Nothing is stored and incremented, so retroactive revaluation is
  correct by construction.
- The exchange rate per currency is the **weighted average of your real
  conversions** (total base spent / total foreign received). Adding a conversion
  retroactively revalues every expense in that currency.
- A **manually declared rate** (`declare_rate`, as foreign units per 1 base unit)
  overrides the conversions average while in force: expenses revalue retroactively
  and later settlements lock at it. Clearing the declaration falls back to the
  average. A declared rate needs no conversions, so a currency you never converted
  into can still be valued.
- **Settlements lock** at the rate in force when they were recorded; they do not
  float afterwards. Money that actually moved keeps its value.
- Balances always sum to zero across participants.

## Storage

A single JSON file at `~/.whoowes/ledger.json` (override with the
`WHOOWES_DIR` env var). It is the event log; back it up by copying it.

## Build

```
npm install
npm run build     # tsc -> dist/
npm run smoke     # runs the worked scenario with assertions
```

## Transports

Two entry points over the same tools:

| Entry | Command | Use |
| --- | --- | --- |
| stdio | `node dist/server.js` | One client spawns its own copy (Claude Code / Desktop). |
| streamable-http | `node dist/http.js` | One shared process owns the ledger; many clients connect over HTTP. Serves `POST /mcp` (plus `GET /health`); `PORT` defaults to 8000. |

**Only ever run one writer against a given `WHOOWES_DIR`.** The HTTP server is
safe for concurrent clients because every tool handler does load → mutate → save
synchronously in one tick and `save()` is atomic (tmp file + rename), so the
process serialises all writes. Two *separate* instances on the same file (e.g.
two stdio clones pointed at a shared folder) have no such guarantee and will
last-writer-wins.

## Register

Claude Code (user scope, works in any project):

```
claude mcp add --scope user whoowes -- node C:/Users/opsij/Documents/Coding/whoowes/dist/server.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "whoowes": {
      "command": "node",
      "args": ["C:/Users/opsij/Documents/Coding/whoowes/dist/server.js"]
    }
  }
}
```

Against a shared HTTP instance instead (see below):

```
claude mcp add --scope user --transport http whoowes http://<host>:18801/mcp
```

## Shared deployment (Docker)

The included `Dockerfile` builds the HTTP server. The ledger is **not** in the
image — mount a volume at `/data` (the image sets `WHOOWES_DIR=/data`).

```
docker build -t whoowes .
docker run -d --name whoowes-mcp -p 18801:8000 -v /srv/whoowes-data:/data whoowes
curl http://localhost:18801/health
```

Clients then point at `http://<host>:18801/mcp` (transport `streamable-http`),
and everyone shares the same tabs. Back up by copying `ledger.json` out of the
mounted volume.

## Tools

| Tool | Purpose |
| --- | --- |
| `create_tab` | New tab with a name and base currency |
| `add_participant` | Register a person (global, reused across tabs) |
| `add_expense` | Shared expense; shares by pct (sum 100) or fixed amounts (sum to total) |
| `add_settlement` | A payment between two people; locks at the current rate |
| `add_conversion` | A real FX conversion you made; moves the weighted-average rate |
| `declare_rate` | Manually pin a currency's rate (overrides the average); omit rate to clear |
| `get_balances` | Net position per participant in the base currency |
| `get_person` | One person's obligations, payments, and settlements |
| `list_tabs` | All tabs |
| `set_tab_status` | Close or reopen a tab |
| `set_base_currency` | Rebase a tab; everything revalues retroactively |
| `delete_tab` | Permanently delete a tab and its log (needs `confirm: true`) |
| `undo_last_event` | Remove the most recent event |

**Rebasing** re-reads each conversion from the other side — a `£110 -> ₦250,000`
history reads as `0.00044 GBP per NGN` on a GBP tab and `2272.73 NGN per GBP` on
an NGN one. It is refused if any conversion has no side in the new base, or if a
rate is declared for it (a tab can't hold a rate against its own base).

## Not in v1

Donation pots (collecting toward a goal rather than dividing a cost) and any
messaging/settle-up flow. Computing is here; texting people is on you.
