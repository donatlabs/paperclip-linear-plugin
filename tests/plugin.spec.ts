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
import { ACTION_KEYS, DATA_KEYS, JOB_KEYS } from "../src/constants.js";

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

  it("declares an importLabelName with default 'paperclip'", () => {
    const props = (manifest.instanceConfigSchema as {
      properties: Record<string, { default?: unknown }>;
    }).properties;
    assert.equal(props.importLabelName?.default, "paperclip");
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
