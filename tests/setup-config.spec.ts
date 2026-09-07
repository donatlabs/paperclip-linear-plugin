import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readSetupConfig } from "../src/setup-config.js";

function ctx(opts: { companies?: Array<{ id: string }>; config?: Record<string, unknown>; deny?: boolean }) {
  const warnings: string[] = [];
  return {
    warnings,
    ctx: {
      companies: { list: async () => opts.companies ?? [{ id: "co-1" }] },
      config: {
        get: async (companyId?: string) => {
          if (opts.deny) throw new Error(`Plugin is not allowed to perform "config.get": company context is required (${companyId})`);
          return opts.config ?? {};
        },
      },
      logger: { warn: (msg: string) => warnings.push(msg), info() {}, error() {}, debug() {} },
    } as never,
  };
}

describe("readSetupConfig", () => {
  it("returns the first company's config", async () => {
    const { ctx: c } = ctx({ config: { apiKeyRef: "ref-1" } });
    assert.deepEqual(await readSetupConfig(c), { companyId: "co-1", config: { apiKeyRef: "ref-1" }, configured: true });
  });
  it("starts empty when the host has no config for the company", async () => {
    const { ctx: c, warnings } = ctx({ deny: true });
    const got = await readSetupConfig<{ apiKeyRef?: string }>(c);
    assert.equal(got.configured, false);
    assert.equal(got.config.apiKeyRef, undefined);
    assert.ok(warnings.some((w) => /not connected/.test(w)));
  });
  it("survives a workspace with no company yet", async () => {
    const { ctx: c } = ctx({ companies: [], deny: true });
    assert.equal((await readSetupConfig(c)).companyId, undefined);
  });
});
