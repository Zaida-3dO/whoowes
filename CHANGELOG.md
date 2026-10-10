# Changelog

## 0.2.0

**Breaking: twelve tools are folded into three.** The ledger file format is unchanged;
only the MCP tool surface differs. `tools/list` goes from 17 tools (about 10.6 KB) to 8
(about 7.7 KB). Callers that name the old tools must switch.

| Old tool | New call |
| --- | --- |
| `add_expense` | `add_entry` with `type: "expense"` |
| `add_settlement` | `add_entry` with `type: "settlement"` |
| `add_conversion` | `add_entry` with `type: "conversion"` |
| `declare_rate` | `add_entry` with `type: "rate"` (omit `rate` to clear) |
| `create_tab` | `tab` with `action: "create"` |
| `add_participant` | `tab` with `action: "add_participant"` |
| `set_tab_status` | `tab` with `action: "set_status"` |
| `set_base_currency` | `tab` with `action: "set_base_currency"` |
| `list_tabs` | `view` with `what: "tabs"` |
| `get_balances` | `view` with `what: "balances"` |
| `get_person` | `view` with `what: "person"` |
| `list_events` | `view` with `what: "events"` |

Field names are unchanged; each old tool's arguments are passed as-is next to the new
`type` / `action` / `what` field, which is required. Fields that do not belong to the
chosen verb, and required fields that are missing, are refused by name.

Kept as they were: `edit_event` (its description is shorter), `remove_event`,
`undo_last_event`, `delete_tab`, `display`.

## 0.1.1

Per-tool-call logging.
