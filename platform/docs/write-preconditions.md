# Write preconditions

A write to a versioned resource names the version it was based on. The control plane refuses a write whose base is stale, so two browser tabs or clients cannot silently overwrite each other's changes. Strategies use this convention first. Settings revisions (https://github.com/mfittko/market-signals/issues/282) reuse it.

## Field

- Name: `baseVersion`, an integer in the JSON request body.
- Value: the highest version number of the resource that the caller loaded.
- Token: the version number itself. There is no opaque etag.
- The server compares `baseVersion` with the current highest version inside the write's transaction, after it takes the resource's advisory lock. A refused write stores nothing.

## Statuses and codes

| Case | Status | `code` |
|---|---|---|
| `baseVersion` equals the current highest version | `200` | none |
| `baseVersion` differs from the current highest version | `409` | `stale_base_version` |
| `baseVersion` is missing and the resource exists | `400` | `base_version_required` |
| `baseVersion` is missing (or `0`) and the resource has no rows yet | `200` (creates it) | none |

Only a create may omit `baseVersion`. A write that applies to an existing resource only (strategy activate and archive) returns `400` with `base_version_required` when the field is missing, before it reads the database.

## Body shape

A refused write returns:

```json
{
  "error": "another tab or client changed this strategy",
  "hint": "reload to see the current version",
  "code": "stale_base_version",
  "currentVersion": 3
}
```

`base_version_required` returns `error`, `hint` and `code` without `currentVersion`.

A successful write returns `{"ok": true, "version": <n>}`, where `version` is the authoritative current highest version after the write. A strategy save also returns `name`.

## Strategy routes

| Route | Body |
|---|---|
| `POST /api/v1/strategies/{name}/versions` | `{"prompt": "...", "baseVersion": n}`; omit `baseVersion` only for a new name |
| `POST /api/v1/strategies/{name}/versions/{version}/activate` | `{"baseVersion": n}` |
| `POST /api/v1/strategies/{name}/archive` | `{"archived": true or false, "baseVersion": n}` |

Activate and archive do not raise the highest version. Two tabs that both activate or archive without a save in between do not conflict, and the last one wins.

## Console

`api()` in `platform/web/lib/api.ts` attaches `status`, `code` and the parsed `body` to the error it throws. On `stale_base_version`, the strategies page shows the server text with the current version and a Reload button. The draft text stays until the operator presses Reload. Reload fetches the strategy again. The console never merges a stale draft.
