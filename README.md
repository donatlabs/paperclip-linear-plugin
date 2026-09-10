# @oldharlem/paperclip-plugin-linear

Connects a Paperclip instance to a [Linear](https://linear.app) workspace.

## What it does

- **Push** new and updated Paperclip issues to Linear (per-company team mapping).
- **Import** Linear issues into Paperclip via webhook (signed deliveries).
- **Mirror** Paperclip issue comments to Linear.
- **Surface** the Linear identifier, URL, and last-sync timestamp on each
  Paperclip issue via a detail tab.
- **Operate** through scheduled jobs (full reconcile + incremental cursor sync).
- **Expose** two agent tools: `create-linear-issue` and `search-linear-issues`,
  so Paperclip agents can interact with Linear during a run.

## What import does, and what it does not

Importing is not starting work. An imported Linear issue lands in the
backlog with nobody assigned; an agent takes it when a person hands it over.
A tracker with hundreds of labelled issues therefore fills a backlog, not a
queue of runs.

Where an imported issue lands, in order: the Tandem project its Linear
project is linked to; the `defaultProjectId` the workspace names in the
plugin settings; or, when the workspace has exactly one project, that one.
A workspace with several projects and no default is told so in the activity
log rather than having its issues guessed at.

Two ways in, and both are deliberate:

- **From now on.** The first incremental sync after a workspace connects
  makes the import label in Linear (`tandem` by default) and records the
  moment it ran. Issues labelled after that come in on their own,
  within a minute. Nothing older is swept in because a tracker was
  connected. `incrementalSyncMinutes` raises that interval for an operator
  who would rather ask Linear less often.
- **What the team already has.** The *Import labelled issues* button on a
  linked project brings in existing labelled issues, up to
  `IMPORT_BATCH_DEFAULT` per press (25, `limit` raises it to at most 100).
  Issues already linked are skipped, so pressing it twice is safe.

## Capabilities

The plugin requests only the capabilities it needs:

| Capability | Why |
|---|---|
| `issues.read/create/update`, `issue.comments.*` | Mirror and import issues |
| `http.outbound`, `secrets.read-ref` | Call the Linear GraphQL API |
| `webhooks.receive` | Receive Linear webhook deliveries |
| `jobs.schedule` | Run periodic full + incremental sync |
| `events.subscribe`, `events.emit` | React to Paperclip domain events |
| `plugin.state.read/write` | Persist sync cursor, idempotency keys, links |
| `agent.tools.register` | Provide create/search Linear tools to agents |
| `activity.log.write` | Audit trail for plugin-originated mutations |
| `ui.*` | Settings page, dashboard widget, issue detail tab, page |

The plugin does **not** request approval, budget, auth, or checkout-override
capabilities (forbidden per [PLUGIN_SPEC.md §15.2](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md#152-forbidden-capabilities)).

## Configuration

Operator settings live under `/settings/plugins/paperclip.linear` and are typed
by `instanceConfigSchema` in [`src/manifest.ts`](./src/manifest.ts):

| Field | Type | Notes |
|---|---|---|
| `apiKeyRef` | secret-ref (required) | Linear personal API key |
| `webhookSecretRef` | secret-ref | HMAC-SHA256 signing secret from Linear |
| `apiUrl` | string | GraphQL endpoint; defaults to `https://api.linear.app/graphql` |
| `pushPaperclipIssues` | boolean | Mirror Paperclip issues → Linear |
| `importLinearIssues` | boolean | Mirror Linear issues → Paperclip |
| `defaultProjectId` / `defaultCompanyId` | uuid | Where imported issues land when nothing is linked |
| `companyTeamMap` | object | Map Paperclip company UUID → Linear team UUID |
| `incrementalSyncMinutes` | int | Polling cadence for incremental sync; 1 by default |

The settings page provides a **Test Connection** button that calls Linear's
`viewer` query to verify the key.

## Webhook setup

Configure a Linear webhook (Settings → API → Webhooks) pointing to:

```
https://<paperclip-host>/api/plugins/paperclip.linear/webhooks/linear
```

Subscribe to `Issue` events. Set a signing secret and place its name in
`webhookSecretRef` to enforce HMAC verification.

## Local development

```bash
npm install
npm run typecheck
npm run build
npm test
```

Install the built plugin into a running Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/linear-plugin","isLocalPath":true}'
```

The host watches local-path plugins for changes, so re-running `npm run build`
restarts the worker automatically.

## Architecture

- [`src/manifest.ts`](./src/manifest.ts) — declarative manifest read at install time.
- [`src/worker.ts`](./src/worker.ts) — single-file worker registering events,
  jobs, data, actions, tools, and the webhook handler.
- [`src/linear-client.ts`](./src/linear-client.ts) — minimal GraphQL client routed
  through `ctx.http` so the host can audit outbound calls.
- [`src/ui/`](./src/ui) — React bundle (no host design tokens are required).
- [`tests/plugin.spec.ts`](./tests/plugin.spec.ts) — smoke tests using the SDK
  test harness; no real Linear API calls.
