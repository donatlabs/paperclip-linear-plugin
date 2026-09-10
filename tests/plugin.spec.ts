/**
 * Smoke tests for the Linear plugin worker.
 *
 * These tests exercise the worker through the SDK's in-memory test harness so
 * we never hit the real Linear API. The harness is the same one operators use
 * during local plugin development and matches the host's contract for events,
 * jobs, data, actions, and webhooks.
 *
 * Run with: `pnpm test`
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  ACTION_KEYS,
  DATA_KEYS,
  JOB_KEYS,
  STATE_KEYS,
  STATE_NAMESPACE,
} from "../src/constants.js";

/**
 * Answer Linear's GraphQL endpoint from a list of issues, and record every
 * query that was asked, so a test can assert on what the plugin went looking
 * for. Restores the real fetch when the test ends.
 */
function fakeLinear(issues: unknown[]): { queries: string[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { query?: string };
    queries.push(body.query ?? "");
    return new Response(JSON.stringify({ data: { issues: { nodes: issues } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { queries, restore: () => { globalThis.fetch = realFetch; } };
}

function linearIssue(id: string, identifier: string, title: string) {
  return {
    id,
    identifier,
    title,
    description: "From Linear",
    url: `https://linear.app/acme/issue/${identifier}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    team: { id: "team-1", key: "ACME", name: "Acme" },
    project: { id: "linear-project-1", name: "Platform" },
    labels: { nodes: [{ id: "label-1", name: "tandem", color: "#fff" }] },
  };
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** One company with one project: the shape of a Tandem workspace. */
function seedWorkspace(harness: ReturnType<typeof createTestHarness>, projects = [PROJECT_ID]) {
  harness.seed({
    companies: [{ id: COMPANY_ID, name: "Acme", createdAt: new Date(), updatedAt: new Date() }] as never,
    projects: projects.map((id, i) => ({
      id,
      companyId: COMPANY_ID,
      name: `Project ${i + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as never,
  });
}

const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

const projectLink = {
  paperclipProjectId: PROJECT_ID,
  companyId: COMPANY_ID,
  linearTeamId: "team-1",
  linearTeamName: "Acme",
  linearProjectId: "linear-project-1",
  linearProjectName: "Platform",
  linkedAt: "2026-01-01T00:00:00.000Z",
};

describe("Linear plugin manifest", () => {
  it("declares only allowed capabilities", () => {
    const forbidden = ["budget.override", "auth.bypass", "issues.checkout-override"];
    for (const cap of manifest.capabilities) {
      assert.ok(
        !forbidden.includes(cap),
        `Forbidden capability ${cap} declared in manifest`,
      );
    }
  });

  it("offers both a raw apiKey field and an apiKeyRef secret-ref", () => {
    const props = (manifest.instanceConfigSchema as {
      properties: Record<string, { format?: string; type?: string }>;
    }).properties;
    assert.equal(props.apiKey?.type, "string");
    assert.equal(props.apiKeyRef?.format, "secret-ref");
  });

  it("declares an importLabelName with default 'tandem'", () => {
    const props = (manifest.instanceConfigSchema as {
      properties: Record<string, { default?: unknown }>;
    }).properties;
    assert.equal(props.importLabelName?.default, "tandem");
  });

  it("pulls labelled issues every minute", () => {
    const incremental = (manifest.jobs ?? []).find((j) => j.jobKey === JOB_KEYS.incrementalSync);
    assert.equal(incremental?.schedule, "* * * * *");
  });

  it("declares full-sync and incremental-sync jobs", () => {
    const keys = (manifest.jobs ?? []).map((j) => j.jobKey);
    assert.deepEqual(keys.sort(), [JOB_KEYS.fullSync, JOB_KEYS.incrementalSync].sort());
  });
});

describe("Linear plugin worker (test harness)", () => {
  it("exposes sync-health and recent-activity data without API calls", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
      config: { apiKeyRef: "" },
    });
    await plugin.definition.setup(harness.ctx);

    const health = (await harness.getData(DATA_KEYS.syncHealth, {})) as {
      configured: boolean;
      linkedIssueCount: number;
    };
    assert.equal(typeof health.linkedIssueCount, "number");
    assert.equal(health.configured, false, "should report unconfigured when apiKeyRef is empty");

    const activity = (await harness.getData(DATA_KEYS.recentActivity, {})) as {
      entries: unknown[];
    };
    assert.ok(Array.isArray(activity.entries));
  });

  it("returns ok=false from test-connection when the API key is missing", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
      config: { apiKeyRef: "" },
    });
    await plugin.definition.setup(harness.ctx);

    const result = (await harness.performAction(ACTION_KEYS.testConnection, {})) as {
      ok: boolean;
    };
    assert.equal(result.ok, false);
  });

  it("starts the clock on the first sync instead of importing history", async () => {
    const linear = fakeLinear([linearIssue("linear-1", "ACME-1", "Old work")]);
    try {
      const harness = createTestHarness({
        manifest,
        capabilities: manifest.capabilities,
        config: { apiKey: "lin_test", importLabelName: "tandem" },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        {
          scopeKind: "project",
          scopeId: PROJECT_ID,
          namespace: STATE_NAMESPACE,
          stateKey: STATE_KEYS.projectLink,
        },
        projectLink,
      );

      await harness.runJob(JOB_KEYS.incrementalSync);

      const cursor = harness.getState({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.syncCursor,
      }) as string;
      assert.ok(cursor, "the first sync records where automatic import starts");
      assert.ok(
        Date.now() - Date.parse(cursor) < 60_000,
        `the cursor starts now, not in the past: ${cursor}`,
      );
      assert.ok(
        linear.queries.every((q) => !q.includes("IssuesUpdatedSince")),
        "connecting a tracker must not sweep a backlog into the workspace",
      );
      assert.ok(
        linear.queries.some((q) => q.toLowerCase().includes("label")),
        "the label the workspace asks people to use is made on the way in",
      );
      assert.equal(
        (await harness.ctx.issues.list({ companyId: COMPANY_ID })).length,
        0,
      );
    } finally {
      linear.restore();
    }
  });

  it("leaves Linear alone until the configured minute is up", async () => {
    const linear = fakeLinear([linearIssue("linear-1", "ACME-1", "New work")]);
    try {
      const harness = createTestHarness({
        manifest,
        capabilities: manifest.capabilities,
        config: { apiKey: "lin_test", incrementalSyncMinutes: 15 },
      });
      await plugin.definition.setup(harness.ctx);
      const scope = { scopeKind: "instance" as const, namespace: STATE_NAMESPACE };
      await harness.ctx.state.set(
        { ...scope, stateKey: STATE_KEYS.syncCursor },
        "2026-01-01T00:00:00.000Z",
      );
      await harness.ctx.state.set(
        { ...scope, stateKey: STATE_KEYS.lastIncrementalSyncAt },
        new Date().toISOString(),
      );

      await harness.runJob(JOB_KEYS.incrementalSync);
      assert.deepEqual(linear.queries, [], "a run that is not due asks Linear nothing");

      // A quarter of an hour later the same tick does the work.
      await harness.ctx.state.set(
        { ...scope, stateKey: STATE_KEYS.lastIncrementalSyncAt },
        new Date(Date.now() - 16 * 60_000).toISOString(),
      );
      await harness.runJob(JOB_KEYS.incrementalSync);
      assert.equal(linear.queries.length, 1);
    } finally {
      linear.restore();
    }
  });

  it("imports labelled issues into the backlog when someone asks for it", async () => {
    const linear = fakeLinear([
      linearIssue("linear-1", "ACME-1", "Ship the importer"),
      linearIssue("linear-2", "ACME-2", "Write it down"),
    ]);
    try {
      const harness = createTestHarness({
        manifest,
        capabilities: manifest.capabilities,
        config: { apiKey: "lin_test", importLabelName: "tandem" },
      });
      await plugin.definition.setup(harness.ctx);
      seedWorkspace(harness);
      await harness.ctx.state.set(
        {
          scopeKind: "project",
          scopeId: PROJECT_ID,
          namespace: STATE_NAMESPACE,
          stateKey: STATE_KEYS.projectLink,
        },
        projectLink,
      );

      const result = (await harness.performAction(ACTION_KEYS.importProject, {
        paperclipProjectId: PROJECT_ID,
      })) as { ok: boolean; imported: number; skipped: number; failed: number; limit: number };
      assert.deepEqual(
        { ok: result.ok, imported: result.imported, skipped: result.skipped, failed: result.failed },
        { ok: true, imported: 2, skipped: 0, failed: 0 },
      );
      assert.equal(result.limit, 25, "one press brings in a capped batch");

      const issues = await harness.ctx.issues.list({ companyId: COMPANY_ID });
      assert.deepEqual(
        issues.map((issue) => issue.title).sort(),
        ["Ship the importer", "Write it down"],
      );
      for (const issue of issues) {
        assert.equal(issue.assigneeAgentId, null, "importing must not hand work to an agent");
      }

      // Pressing it again is safe: what is already linked is left alone.
      const again = (await harness.performAction(ACTION_KEYS.importProject, {
        paperclipProjectId: PROJECT_ID,
      })) as { imported: number; skipped: number };
      assert.deepEqual({ imported: again.imported, skipped: again.skipped }, { imported: 0, skipped: 2 });
    } finally {
      linear.restore();
    }
  });

  it("refuses to import into a project the workspace does not have", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
      config: { apiKey: "lin_test" },
    });
    await plugin.definition.setup(harness.ctx);
    await assert.rejects(
      () => harness.performAction(ACTION_KEYS.importProject, { paperclipProjectId: PROJECT_ID }),
      /could not be found/,
    );
  });

  it("puts labelled issues in the only project when nothing is mapped", async () => {
    const linear = fakeLinear([linearIssue("linear-9", "ACME-9", "Nothing mapped")]);
    try {
      const harness = createTestHarness({
        manifest,
        capabilities: manifest.capabilities,
        config: { apiKey: "lin_test", importLabelName: "tandem" },
      });
      await plugin.definition.setup(harness.ctx);
      seedWorkspace(harness);
      // No project link at all: the workspace has one project, so that is
      // where a labelled issue belongs.
      await harness.ctx.state.set(
        {
          scopeKind: "instance",
          namespace: STATE_NAMESPACE,
          stateKey: STATE_KEYS.syncCursor,
        },
        "2026-01-01T00:00:00.000Z",
      );

      await harness.runJob(JOB_KEYS.incrementalSync);

      const issues = await harness.ctx.issues.list({ companyId: COMPANY_ID });
      assert.deepEqual(
        issues.map((issue) => [issue.title, issue.projectId]),
        [["Nothing mapped", PROJECT_ID]],
      );
    } finally {
      linear.restore();
    }
  });

  it("says so when a workspace with several projects has named none", async () => {
    const linear = fakeLinear([linearIssue("linear-9", "ACME-9", "Homeless")]);
    try {
      const harness = createTestHarness({
        manifest,
        capabilities: manifest.capabilities,
        config: { apiKey: "lin_test", importLabelName: "tandem" },
      });
      await plugin.definition.setup(harness.ctx);
      seedWorkspace(harness, [PROJECT_ID, OTHER_PROJECT_ID]);
      const scope = { scopeKind: "instance" as const, namespace: STATE_NAMESPACE };
      await harness.ctx.state.set({ ...scope, stateKey: STATE_KEYS.syncCursor }, "2026-01-01T00:00:00.000Z");

      await harness.runJob(JOB_KEYS.incrementalSync);
      assert.equal((await harness.ctx.issues.list({ companyId: COMPANY_ID })).length, 0);

      const activity = (await harness.getData(DATA_KEYS.recentActivity, {})) as {
        entries: Array<{ level: string; message: string }>;
      };
      assert.ok(
        activity.entries.some((e) => e.level === "warning" && e.message.includes("nowhere to land")),
        `expected a warning, got ${JSON.stringify(activity.entries)}`,
      );

      // Naming one is all it takes.
      await plugin.definition.onConfigChanged?.({
        apiKey: "lin_test",
        importLabelName: "tandem",
        defaultProjectId: OTHER_PROJECT_ID,
      } as never);
      await harness.ctx.state.set({ ...scope, stateKey: STATE_KEYS.lastIncrementalSyncAt }, new Date(0).toISOString());
      await harness.runJob(JOB_KEYS.incrementalSync);
      const issues = await harness.ctx.issues.list({ companyId: COMPANY_ID });
      assert.deepEqual(
        issues.map((issue) => issue.projectId),
        [OTHER_PROJECT_ID],
      );
    } finally {
      linear.restore();
    }
  });

  it("rejects unknown webhook endpoint keys", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
      config: { apiKeyRef: "" },
    });
    await plugin.definition.setup(harness.ctx);

    await assert.rejects(
      () =>
        plugin.definition.onWebhook?.({
          endpointKey: "not-a-real-endpoint",
          headers: {},
          rawBody: "{}",
          parsedBody: {},
          requestId: "test-1",
        }) ?? Promise.resolve(),
      /Unsupported webhook endpoint/,
    );
  });
});
