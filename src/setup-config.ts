import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * The company the plugin serves at setup, and its config. The host keeps
 * config per company and refuses `config.get` for a company the plugin has
 * not been configured for; on a workspace where nobody has connected Linear
 * yet that is every company. That is not a fault: the plugin starts with an
 * empty config, registers its handlers, and reports itself as not connected
 * until a configuration arrives (onConfigChanged). Failing setup instead
 * would leave the plugin in "error" and, on a hosted workspace, hold up the
 * workspace itself.
 */
export async function readSetupConfig<T extends object>(
  ctx: Pick<PluginContext, "companies" | "config" | "logger">,
): Promise<{ companyId: string | undefined; config: Partial<T>; configured: boolean }> {
  let companyId: string | undefined;
  try {
    const companies = await ctx.companies.list({ limit: 1, offset: 0 });
    companyId = companies[0]?.id;
  } catch (error) {
    ctx.logger.warn("Linear plugin could not list companies at setup", { error: String(error) });
  }
  try {
    const config = (await ctx.config.get(companyId)) as Partial<T>;
    return { companyId, config, configured: true };
  } catch (error) {
    ctx.logger.warn("Linear is not connected on this workspace yet; the plugin waits for a configuration", {
      error: String(error),
    });
    return { companyId, config: {}, configured: false };
  }
}
