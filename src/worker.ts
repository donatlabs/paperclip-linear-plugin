/**
 * Linear plugin worker entrypoint.
 *
 * Lifecycle:
 * - `setup` — read config, instantiate the Linear client, wire all event/job/
 *   data/action/tool/webhook handlers in synchronous registration order.
 * - `onConfigChanged` — rebuild the Linear client without restarting.
 * - `onValidateConfig` — used by the "Test Connection" button in settings.
 * - `onWebhook` — verifies the Linear HMAC signature and routes payloads.
 * - `onHealth` — surfaces last-sync / last-webhook timestamps.
 */

import { readSetupConfig } from "./setup-config.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type PluginJobContext,
  type PluginWebhookInput,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/plugin-sdk";

import {
  ACTION_KEYS,
  ACTIVITY_BUFFER_MAX,
  DATA_KEYS,
  DEFAULTS,
  ENTITY_TYPES,
  IMPORT_BATCH_DEFAULT,
  IMPORT_BATCH_MAX,
  JOB_KEYS,
  STARTER_IMPORT,
  STATE_KEYS,
  STATE_NAMESPACE,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";
import { LinearApiError, LinearClient } from "./linear-client.js";
import {
  DEFAULT_CONFIG,
  type ImportTarget,
  type LinearIssue,
  type LinearIssueLink,
  type LinearLabel,
  type LinearPluginConfig,
  type LinearProject,
  type LinearProjectLink,
  type LinearTeam,
  type LinearWebhookIssueData,
  type LinearWebhookPayload,
  type LinearWorkflowState,
  type LinearWorkflowStateType,
  type RecentActivityEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Module-level mutable state — recreated on every worker restart, by design.
// ---------------------------------------------------------------------------

let currentContext: PluginContext | null = null;
let currentClient: LinearClient | null = null;
let currentConfig: LinearPluginConfig | null = null;
let cachedImportLabel: LinearLabel | null = null;
const recentActivity: RecentActivityEntry[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function activity(entry: Omit<RecentActivityEntry, "id" | "createdAt">): RecentActivityEntry {
  const next: RecentActivityEntry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry,
  };
  recentActivity.unshift(next);
  if (recentActivity.length > ACTIVITY_BUFFER_MAX) {
    recentActivity.length = ACTIVITY_BUFFER_MAX;
  }
  return next;
}

/** Where "everything the team already has" starts, for a deliberate import. */
const BEGINNING_OF_TIME = "1970-01-01T00:00:00.000Z";

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Coerce a typed Linear API object into the `Record<string, unknown>` that the entities API wants. */
function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

async function loadConfig(ctx: PluginContext): Promise<LinearPluginConfig> {
  // Config is per company on the host; the plugin names the company it
  // serves (one per instance on a hosted workspace) and starts with the
  // defaults when that company has no config yet.
  const { config: raw } = await readSetupConfig<LinearPluginConfig>(ctx);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
  };
}

async function resolveApiKey(
  ctx: PluginContext,
  config: LinearPluginConfig,
): Promise<string | null> {
  if (config.apiKeyRef) {
    try {
      return await ctx.secrets.resolve(config.apiKeyRef);
    } catch (error) {
      ctx.logger.warn("Failed to resolve apiKeyRef, falling back to apiKey", {
        error: summarizeError(error),
      });
    }
  }
  if (config.apiKey && config.apiKey.length > 0) return config.apiKey;
  return null;
}

async function resolveWebhookSecret(
  ctx: PluginContext,
  config: LinearPluginConfig,
): Promise<string | null> {
  if (config.webhookSecretRef) {
    try {
      return await ctx.secrets.resolve(config.webhookSecretRef);
    } catch {
      // fall through to raw
    }
  }
  return config.webhookSecret ?? null;
}

async function buildClient(
  ctx: PluginContext,
  config: LinearPluginConfig,
): Promise<LinearClient | null> {
  const apiKey = await resolveApiKey(ctx, config);
  if (!apiKey) return null;
  return new LinearClient({
    apiUrl: config.apiUrl ?? DEFAULTS.apiUrl,
    apiKey,
    http: ctx.http,
    logger: ctx.logger,
  });
}

function requireClient(): LinearClient {
  if (!currentClient) {
    throw new Error(
      "Linear client not initialized — paste an API key in plugin settings",
    );
  }
  return currentClient;
}

function requireConfig(): LinearPluginConfig {
  if (!currentConfig) throw new Error("Linear plugin config not loaded yet");
  return currentConfig;
}

function requireCtx(): PluginContext {
  if (!currentContext) throw new Error("Plugin context not initialized");
  return currentContext;
}

// ---------------------------------------------------------------------------
// Project link state
// ---------------------------------------------------------------------------

async function getProjectLink(
  ctx: PluginContext,
  paperclipProjectId: string,
): Promise<LinearProjectLink | null> {
  const value = await ctx.state.get({
    scopeKind: "project",
    scopeId: paperclipProjectId,
    namespace: STATE_NAMESPACE,
    stateKey: STATE_KEYS.projectLink,
  });
  return (value as LinearProjectLink | null) ?? null;
}

async function setProjectLink(
  ctx: PluginContext,
  paperclipProjectId: string,
  link: LinearProjectLink,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "project",
      scopeId: paperclipProjectId,
      namespace: STATE_NAMESPACE,
      stateKey: STATE_KEYS.projectLink,
    },
    link,
  );
  // Maintain a reverse-index so webhook handlers can find the Paperclip
  // project from the Linear project ID without scanning every project.
  if (link.linearProjectId) {
    await ctx.state.set(
      {
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: `${STATE_KEYS.reverseProjectLink}:${link.linearProjectId}`,
      },
      paperclipProjectId,
    );
  }
}

async function deleteProjectLink(ctx: PluginContext, paperclipProjectId: string): Promise<void> {
  const existing = await getProjectLink(ctx, paperclipProjectId);
  await ctx.state.delete({
    scopeKind: "project",
    scopeId: paperclipProjectId,
    namespace: STATE_NAMESPACE,
    stateKey: STATE_KEYS.projectLink,
  });
  if (existing?.linearProjectId) {
    await ctx.state.delete({
      scopeKind: "instance",
      namespace: STATE_NAMESPACE,
      stateKey: `${STATE_KEYS.reverseProjectLink}:${existing.linearProjectId}`,
    });
  }
}

async function findPaperclipProjectByLinearProject(
  ctx: PluginContext,
  linearProjectId: string,
): Promise<string | null> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey: `${STATE_KEYS.reverseProjectLink}:${linearProjectId}`,
  });
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Issue link state
// ---------------------------------------------------------------------------

async function getIssueLink(
  ctx: PluginContext,
  paperclipIssueId: string,
): Promise<LinearIssueLink | null> {
  const value = await ctx.state.get({
    scopeKind: "issue",
    scopeId: paperclipIssueId,
    namespace: STATE_NAMESPACE,
    stateKey: STATE_KEYS.linearLink,
  });
  return (value as LinearIssueLink | null) ?? null;
}

async function setIssueLink(
  ctx: PluginContext,
  paperclipIssueId: string,
  link: LinearIssueLink,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "issue",
      scopeId: paperclipIssueId,
      namespace: STATE_NAMESPACE,
      stateKey: STATE_KEYS.linearLink,
    },
    link,
  );
}

async function deleteIssueLink(ctx: PluginContext, paperclipIssueId: string): Promise<void> {
  await ctx.state.delete({
    scopeKind: "issue",
    scopeId: paperclipIssueId,
    namespace: STATE_NAMESPACE,
    stateKey: STATE_KEYS.linearLink,
  });
}

// ---------------------------------------------------------------------------
// Linear cache helpers
// ---------------------------------------------------------------------------

async function refreshLinearCache(ctx: PluginContext): Promise<{
  teams: LinearTeam[];
  projects: LinearProject[];
}> {
  const client = requireClient();
  const [teams, projects] = await Promise.all([client.listTeams(), client.listProjects()]);
  await ctx.state.set(
    {
      scopeKind: "instance",
      namespace: STATE_NAMESPACE,
      stateKey: STATE_KEYS.cachedLinearTeams,
    },
    teams,
  );
  await ctx.state.set(
    {
      scopeKind: "instance",
      namespace: STATE_NAMESPACE,
      stateKey: STATE_KEYS.cachedLinearProjects,
    },
    projects,
  );
  return { teams, projects };
}

async function ensureImportLabel(): Promise<LinearLabel | null> {
  const config = requireConfig();
  const labelName = config.importLabelName ?? DEFAULT_CONFIG.importLabelName;
  if (!labelName) return null;
  if (cachedImportLabel && cachedImportLabel.name === labelName) return cachedImportLabel;
  const label = await requireClient().ensureWorkspaceLabel(labelName);
  cachedImportLabel = label;
  return label;
}

function issueHasLabel(data: LinearWebhookIssueData, labelName: string): boolean {
  if (Array.isArray(data.labels)) {
    return data.labels.some((l) => l.name === labelName);
  }
  return false;
}

function issueHasLabelOnObject(issue: LinearIssue, labelName: string): boolean {
  return (issue.labels?.nodes ?? []).some((l) => l.name === labelName);
}

/**
 * Look up the Linear issue ID we should pass as `parentId` when mirroring a
 * Paperclip issue. Returns `null` when the Paperclip issue has no parent or
 * when the parent has not been linked to Linear yet — the caller leaves
 * `parentId` unset in that case so Linear creates a top-level issue, and the
 * relationship gets stitched up in the second backfill pass.
 */
async function resolveParentLinearId(
  ctx: PluginContext,
  issue: Issue,
): Promise<string | null> {
  if (!issue.parentId) return null;
  const parentLink = await getIssueLink(ctx, issue.parentId);
  return parentLink?.linearIssueId ?? null;
}

// ---------------------------------------------------------------------------
// Workflow state mapping (Paperclip status ↔ Linear workflow state)
// ---------------------------------------------------------------------------

/**
 * Maps a Paperclip `IssueStatus` to a Linear workflow-state `type`. Linear's
 * `type` column is the only stable cross-team semantic — names are custom per
 * team. We pick the closest type, then resolve to a concrete `stateId` per
 * team via the cached workflow states.
 *
 * Paperclip statuses come from `ISSUE_STATUSES` in @paperclipai/shared.
 */
function paperclipStatusToLinearType(status: Issue["status"]): LinearWorkflowStateType {
  switch (status) {
    case "backlog":
      return "backlog";
    case "todo":
      return "unstarted";
    case "in_progress":
    case "in_review":
    case "blocked":
      return "started";
    case "done":
      return "completed";
    case "cancelled":
      return "canceled";
    default:
      return "unstarted";
  }
}

/**
 * Returns the Linear workflow state that best matches the Paperclip status for
 * the given team. Prefers a name match (e.g. "In Review" ⇄ "in_review") then
 * falls back to the type match. Caches per team in plugin state for the life
 * of the worker (and persists across restarts). Returns `null` when the team
 * has no states cached and we can't fetch (no client) — caller should leave
 * `stateId` unset and let Linear pick its team default.
 */
async function getStateIdForStatus(
  ctx: PluginContext,
  teamId: string,
  status: Issue["status"],
): Promise<string | null> {
  const states = await getOrFetchWorkflowStates(ctx, teamId);
  if (states.length === 0) return null;

  const wantedType = paperclipStatusToLinearType(status);
  const normalized = (s: string) => s.replace(/[\s_-]+/g, "").toLowerCase();
  const wantedName = normalized(status);

  // 1) Name match — let teams with custom names like "In Review" win over a
  //    generic "started" state.
  const byName = states.find((s) => normalized(s.name) === wantedName);
  if (byName) return byName.id;

  // 2) Type match — pick the lowest-position state of the wanted type so we
  //    target the canonical entry point (e.g. "Backlog" not "Triage > Backlog").
  const byType = states
    .filter((s) => s.type === wantedType)
    .sort((a, b) => a.position - b.position)[0];
  return byType?.id ?? null;
}

async function getOrFetchWorkflowStates(
  ctx: PluginContext,
  teamId: string,
): Promise<LinearWorkflowState[]> {
  const stateKey = `${STATE_KEYS.workflowStatesByTeam}:${teamId}`;
  const cached = (await ctx.state.get({
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey,
  })) as LinearWorkflowState[] | null;
  if (cached && cached.length > 0) return cached;
  if (!currentClient) return [];

  try {
    const fresh = await currentClient.listWorkflowStates(teamId);
    await ctx.state.set(
      { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey },
      fresh,
    );
    return fresh;
  } catch (error) {
    ctx.logger.warn("Failed to fetch Linear workflow states", {
      teamId,
      error: summarizeError(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Event handlers — Paperclip → Linear
// ---------------------------------------------------------------------------

async function handlePaperclipIssueCreated(event: PluginEvent): Promise<void> {
  const config = requireConfig();
  if (!config.pushPaperclipIssues) return;

  const ctx = requireCtx();
  const issueId = event.entityId;
  if (!issueId) return;

  const existing = await getIssueLink(ctx, issueId);
  if (existing) return; // already linked

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue?.projectId) return;

  const projectLink = await getProjectLink(ctx, issue.projectId);
  if (!projectLink) {
    // Project not linked → nothing to do (silent, not an error).
    return;
  }

  try {
    const stateId = await getStateIdForStatus(
      ctx,
      projectLink.linearTeamId,
      issue.status,
    );
    const parentLinearId = await resolveParentLinearId(ctx, issue);

    const linearIssue = await requireClient().createIssue({
      teamId: projectLink.linearTeamId,
      title: issue.title,
      ...(issue.description ? { description: issue.description } : {}),
      ...(projectLink.linearProjectId ? { projectId: projectLink.linearProjectId } : {}),
      ...(stateId ? { stateId } : {}),
      ...(parentLinearId ? { parentId: parentLinearId } : {}),
    });

    const link: LinearIssueLink = {
      linearIssueId: linearIssue.id,
      linearIdentifier: linearIssue.identifier,
      linearUrl: linearIssue.url,
      linearTeamId: linearIssue.team.id,
      linearProjectId: linearIssue.project?.id ?? null,
      pushedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };
    await setIssueLink(ctx, issueId, link);
    await ctx.entities.upsert({
      entityType: ENTITY_TYPES.linearIssue,
      scopeKind: "issue",
      scopeId: issueId,
      externalId: linearIssue.id,
      title: linearIssue.title,
      status: linearIssue.state.name,
      data: { ...asRecord(linearIssue), paperclipIssueId: issueId },
    });
    await ctx.activity.log({
      companyId: event.companyId,
      message: `Pushed issue to Linear: ${linearIssue.identifier}`,
      entityType: "issue",
      entityId: issueId,
      metadata: { linearIssueId: linearIssue.id, linearUrl: linearIssue.url },
    });
    activity({
      level: "info",
      source: "event",
      message: `Pushed ${issue.title} → ${linearIssue.identifier} (${projectLink.linearProjectName ?? projectLink.linearTeamName})`,
    });
  } catch (error) {
    ctx.logger.error("Failed to push issue to Linear", { issueId, error: summarizeError(error) });
    activity({
      level: "error",
      source: "event",
      message: `Push failed for ${issue.title}: ${summarizeError(error)}`,
    });
  }
}

async function handlePaperclipIssueUpdated(event: PluginEvent): Promise<void> {
  const config = requireConfig();
  if (!config.pushPaperclipIssues) return;

  const ctx = requireCtx();
  const issueId = event.entityId;
  if (!issueId) return;

  const link = await getIssueLink(ctx, issueId);
  if (!link) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;

  try {
    const stateId = await getStateIdForStatus(ctx, link.linearTeamId, issue.status);
    const parentLinearId = await resolveParentLinearId(ctx, issue);

    await requireClient().updateIssue(link.linearIssueId, {
      title: issue.title,
      ...(issue.description ? { description: issue.description } : {}),
      ...(stateId ? { stateId } : {}),
      // Pass parent change-or-clear: Linear's `parentId` semantics let us
      // overwrite, so include the resolved value (which may be the same).
      ...(parentLinearId ? { parentId: parentLinearId } : {}),
    });
    await setIssueLink(ctx, issueId, { ...link, lastSyncedAt: new Date().toISOString() });
    activity({
      level: "info",
      source: "event",
      message: `Updated Linear issue ${link.linearIdentifier} (status ${issue.status})`,
    });
  } catch (error) {
    ctx.logger.error("Failed to update Linear issue", { issueId, error: summarizeError(error) });
  }
}

async function handlePaperclipCommentCreated(event: PluginEvent): Promise<void> {
  const ctx = requireCtx();
  const payload = event.payload as { commentId?: string; issueId?: string; body?: string };
  if (!payload.issueId || !payload.body) return;
  const link = await getIssueLink(ctx, payload.issueId);
  if (!link) return;

  try {
    await requireClient().createComment(link.linearIssueId, payload.body);
    activity({
      level: "info",
      source: "event",
      message: `Mirrored comment to ${link.linearIdentifier}`,
    });
  } catch (error) {
    ctx.logger.error("Failed to mirror comment", {
      issueId: payload.issueId,
      error: summarizeError(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Webhook handler — Linear → Paperclip
// ---------------------------------------------------------------------------

function verifyLinearSignature(
  rawBody: string,
  signatureHeader: string | string[] | undefined,
  secret: string,
): boolean {
  const headerVal = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!headerVal) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(headerVal, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

async function handleLinearWebhook(input: PluginWebhookInput): Promise<void> {
  const ctx = requireCtx();
  const config = requireConfig();

  const secret = await resolveWebhookSecret(ctx, config);
  if (secret) {
    const sigHeader =
      input.headers[DEFAULTS.webhookSignatureHeader] ??
      input.headers["x-linear-signature"] ??
      input.headers["linear-signature"];
    if (!verifyLinearSignature(input.rawBody, sigHeader, secret)) {
      ctx.logger.warn("Rejected Linear webhook with bad signature", {
        requestId: input.requestId,
      });
      throw new Error("Invalid Linear webhook signature");
    }
  }

  const payload = input.parsedBody as LinearWebhookPayload | undefined;
  if (!payload || typeof payload !== "object") {
    ctx.logger.warn("Linear webhook missing parsedBody", { requestId: input.requestId });
    return;
  }

  await ctx.state.set(
    { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: STATE_KEYS.lastWebhookAt },
    new Date().toISOString(),
  );

  if (payload.type === "Issue") {
    await handleLinearIssueWebhook(ctx, config, payload);
  } else {
    activity({
      level: "info",
      source: "webhook",
      message: `Linear ${payload.type} ${payload.action} ignored`,
    });
  }
}

async function handleLinearIssueWebhook(
  ctx: PluginContext,
  config: LinearPluginConfig,
  payload: LinearWebhookPayload,
): Promise<void> {
  const data = payload.data;
  const linearIssueId = data.id;
  if (!linearIssueId) return;

  const linked = await ctx.entities.list({
    entityType: ENTITY_TYPES.linearIssue,
    externalId: linearIssueId,
    limit: 1,
  });
  const existing = linked[0];

  if (payload.action === "remove") {
    if (existing?.scopeId) {
      await deleteIssueLink(ctx, existing.scopeId);
      activity({
        level: "info",
        source: "webhook",
        message: `Linear issue ${linearIssueId} removed; link cleared`,
      });
    }
    return;
  }

  // Update existing linked issue: refresh metadata only.
  if (existing?.scopeId) {
    const issueLink = await getIssueLink(ctx, existing.scopeId);
    if (issueLink) {
      await setIssueLink(ctx, existing.scopeId, {
        ...issueLink,
        lastSyncedAt: new Date().toISOString(),
      });
    }
    const refreshedTitle =
      typeof data.title === "string" ? data.title : existing.title ?? undefined;
    const refreshedStatus = data.state?.name;
    await ctx.entities.upsert({
      entityType: ENTITY_TYPES.linearIssue,
      scopeKind: "issue",
      scopeId: existing.scopeId,
      externalId: linearIssueId,
      ...(refreshedTitle !== undefined ? { title: refreshedTitle } : {}),
      ...(refreshedStatus !== undefined ? { status: refreshedStatus } : {}),
      data: asRecord(data),
    });
    return;
  }

  // Create side: import only when import is enabled, the issue carries the
  // configured label, and the Linear project maps to a Paperclip project.
  if (!config.importLinearIssues) return;
  const labelName = config.importLabelName ?? DEFAULT_CONFIG.importLabelName;
  if (!labelName || !issueHasLabel(data, labelName)) {
    activity({
      level: "info",
      source: "webhook",
      message: `Linear ${data.identifier ?? linearIssueId} ignored — missing "${labelName}" label`,
    });
    return;
  }

  const linearProjectId = data.project?.id ?? null;
  const target = await importTarget(ctx, config, linearProjectId);
  if (!target) {
    activity({
      level: "warning",
      source: "webhook",
      message: `Linear ${data.identifier ?? linearIssueId} carries the "${labelName}" label but has nowhere to land — name a default project in the Linear settings, or link its Linear project`,
    });
    return;
  }

  const title = data.title ?? `Linear ${data.identifier ?? linearIssueId}`;
  const description = typeof data.description === "string" ? data.description : undefined;

  try {
    // The host derives originKind="plugin:paperclip.linear" from the installed plugin.
    const created = await ctx.issues.create({
      companyId: target.companyId,
      projectId: target.projectId,
      title,
      ...(description !== undefined ? { description } : {}),
      originId: linearIssueId,
    });

    const link: LinearIssueLink = {
      linearIssueId,
      linearIdentifier: data.identifier ?? linearIssueId,
      linearUrl: typeof data.url === "string" ? data.url : (payload.url ?? ""),
      linearTeamId: data.team?.id ?? "",
      linearProjectId,
      pushedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };
    await setIssueLink(ctx, created.id, link);

    const importedStatus = data.state?.name;
    await ctx.entities.upsert({
      entityType: ENTITY_TYPES.linearIssue,
      scopeKind: "issue",
      scopeId: created.id,
      externalId: linearIssueId,
      title,
      ...(importedStatus !== undefined ? { status: importedStatus } : {}),
      data: asRecord(data),
    });
    activity({
      level: "info",
      source: "webhook",
      message: `Imported Linear ${link.linearIdentifier} → Paperclip ${created.id}`,
    });
  } catch (error) {
    ctx.logger.error("Failed to import Linear issue", {
      linearIssueId,
      error: summarizeError(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function runFullSync(_job: PluginJobContext): Promise<void> {
  const ctx = requireCtx();
  if (!currentClient) {
    ctx.logger.warn("Skipping full sync — Linear not configured");
    return;
  }
  ctx.logger.info("Starting Linear full sync");

  const { teams, projects } = await refreshLinearCache(ctx);
  for (const team of teams) {
    await ctx.entities.upsert({
      entityType: ENTITY_TYPES.linearTeam,
      scopeKind: "instance",
      externalId: team.id,
      title: `${team.key} – ${team.name}`,
      data: asRecord(team),
    });
  }
  for (const project of projects) {
    await ctx.entities.upsert({
      entityType: ENTITY_TYPES.linearProject,
      scopeKind: "instance",
      externalId: project.id,
      title: project.name,
      data: asRecord(project),
    });
  }
  await ensureImportLabel();

  await ctx.state.set(
    { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: STATE_KEYS.lastFullSyncAt },
    new Date().toISOString(),
  );
  activity({
    level: "info",
    source: "job",
    message: `Full sync — ${teams.length} teams, ${projects.length} projects`,
  });
}

/** The company a Tandem project belongs to, found by asking each company. */
async function companyOfProject(
  ctx: PluginContext,
  paperclipProjectId: string,
): Promise<string | null> {
  const companies = await ctx.companies.list({ limit: 100 });
  for (const company of companies) {
    const project = await ctx.projects.get(paperclipProjectId, company.id);
    if (project) return company.id;
  }
  return null;
}

/**
 * Where a labelled Linear issue lands, in the order a person would expect:
 *
 *  1. the Tandem project its Linear project is linked to, when someone has
 *     linked them;
 *  2. the default project the workspace names in the plugin's settings;
 *  3. the workspace's only project, when it has exactly one — the common
 *     case, and the one where asking anybody to map anything is silly.
 *
 * Nothing left? Then the issue has no home, and the plugin says so rather
 * than dropping it quietly: the workspace has several projects and nobody
 * has said which one Linear issues belong to.
 */
async function importTarget(
  ctx: PluginContext,
  config: LinearPluginConfig,
  linearProjectId: string | null,
): Promise<ImportTarget | null> {
  if (linearProjectId) {
    const paperclipProjectId = await findPaperclipProjectByLinearProject(ctx, linearProjectId);
    if (paperclipProjectId) {
      const link = await getProjectLink(ctx, paperclipProjectId);
      if (link) {
        return { companyId: link.companyId, projectId: paperclipProjectId, linearProjectId };
      }
    }
  }

  const named = (config.defaultProjectId ?? "").trim();
  if (named) {
    const companyId = (config.defaultCompanyId ?? "").trim() || (await companyOfProject(ctx, named));
    if (companyId) return { companyId, projectId: named, linearProjectId };
  }

  const companies = await ctx.companies.list({ limit: 2 });
  const only = companies.length === 1 ? companies[0] : null;
  if (!only) return null;
  const projects = await ctx.projects.list({ companyId: only.id, limit: 2 });
  const project = projects.length === 1 ? projects[0] : null;
  if (!project) return null;
  return { companyId: only.id, projectId: project.id, linearProjectId };
}

/**
 * Import one labelled Linear issue into a linked Tandem project, unless it is
 * already linked (then this returns null and nothing is created).
 *
 * Importing is not starting work. The issue lands where every new Tandem
 * issue lands — the backlog, with nobody assigned — so a Linear workspace
 * with hundreds of labelled issues fills a backlog rather than starting
 * hundreds of agents. Work begins when a person hands the issue to an agent.
 */
async function importLinearIssue(
  ctx: PluginContext,
  issue: LinearIssue,
  target: ImportTarget,
): Promise<string | null> {
  const linked = await ctx.entities.list({
    entityType: ENTITY_TYPES.linearIssue,
    externalId: issue.id,
    limit: 1,
  });
  if (linked[0]?.scopeId) return null;

  const description = issue.description ?? undefined;
  const created = await ctx.issues.create({
    companyId: target.companyId,
    projectId: target.projectId,
    title: issue.title,
    ...(description !== undefined ? { description } : {}),
    originId: issue.id,
  });
  const issueLink: LinearIssueLink = {
    linearIssueId: issue.id,
    linearIdentifier: issue.identifier,
    linearUrl: issue.url,
    linearTeamId: issue.team.id,
    linearProjectId: issue.project?.id ?? target.linearProjectId ?? null,
    pushedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
  };
  await setIssueLink(ctx, created.id, issueLink);
  await ctx.entities.upsert({
    entityType: ENTITY_TYPES.linearIssue,
    scopeKind: "issue",
    scopeId: created.id,
    externalId: issue.id,
    title: issue.title,
    status: issue.state.name,
    data: asRecord(issue),
  });
  return created.id;
}

/** The batch one press of "Import labelled issues" is allowed to bring in. */
function importBatchSize(value: unknown): number {
  const asked = typeof value === "number" ? Math.floor(value) : IMPORT_BATCH_DEFAULT;
  if (!Number.isFinite(asked) || asked < 1) return IMPORT_BATCH_DEFAULT;
  return Math.min(asked, IMPORT_BATCH_MAX);
}

/**
 * The first sync's handful: the most recently touched issues of the project
 * this workspace works on, whether or not anyone has labelled them. They
 * land in the backlog like every other import — nothing starts on its own —
 * and this runs once, on the sync that sets the cursor.
 */
async function importStarterIssues(
  ctx: PluginContext,
  config: LinearPluginConfig,
): Promise<number> {
  if (!config.importLinearIssues || !currentClient) return 0;
  const target = await importTarget(ctx, config, null);
  if (!target) return 0;
  let issues: LinearIssue[] = [];
  try {
    issues = await requireClient().issuesUpdatedSince(BEGINNING_OF_TIME, {
      ...(target.linearProjectId ? { projectId: target.linearProjectId } : {}),
      limit: STARTER_IMPORT,
    });
  } catch (error) {
    ctx.logger.warn("Could not read Linear for the first issues", { error: summarizeError(error) });
    return 0;
  }
  let imported = 0;
  for (const issue of issues) {
    try {
      if (await importLinearIssue(ctx, issue, target)) imported += 1;
    } catch (error) {
      ctx.logger.error("First import failed", { issueId: issue.id, error: summarizeError(error) });
    }
  }
  return imported;
}

async function runIncrementalSync(_job: PluginJobContext): Promise<void> {
  const ctx = requireCtx();
  const config = requireConfig();
  if (!currentClient) return;

  const labelName = config.importLabelName ?? DEFAULT_CONFIG.importLabelName;

  // The job ticks every minute; how often it actually asks Linear anything
  // is the operator's setting. A run that is not due yet costs one state
  // read and nothing else.
  const everyMinutes = Math.max(
    1,
    Math.floor(config.incrementalSyncMinutes ?? DEFAULT_CONFIG.incrementalSyncMinutes),
  );
  const lastRun = (await ctx.state.get({
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey: STATE_KEYS.lastIncrementalSyncAt,
  })) as string | null;
  if (lastRun) {
    const due = Date.parse(lastRun) + everyMinutes * 60_000;
    // A minute's worth of slack, since the host's scheduler ticks on its
    // own clock and a run that lands a second early should still count.
    if (Number.isFinite(due) && Date.now() < due - 5_000) return;
  }

  // Find every linked Paperclip project and pull labelled Linear issues for each
  // mapped Linear project. ctx.entities listing is a workable proxy for "iterate
  // over all project links" since we upsert one per linked project elsewhere.
  // We keep a fallback wide-net query for unrelated linked issues that may have
  // already been imported.
  // The cursor is where automatic import starts. On the first run after a
  // workspace connects Linear it starts *now*: whatever the team already has
  // in Linear comes in when someone presses "Import labelled issues", not
  // because the tracker was connected. From here on, labelling an issue is
  // the ordinary way in.
  const stored = (await ctx.state.get({
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey: STATE_KEYS.syncCursor,
  })) as string | null;
  if (!stored) {
    // Make the label in Linear now, so the person who just connected can
    // find it on an issue instead of typing a name that does not exist yet.
    try {
      await ensureImportLabel();
    } catch (error) {
      ctx.logger.warn("Could not create the import label", { error: summarizeError(error) });
    }
    const startedAt = new Date().toISOString();
    await ctx.state.set(
      { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: STATE_KEYS.syncCursor },
      startedAt,
    );
    await ctx.state.set(
      {
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.lastIncrementalSyncAt,
      },
      startedAt,
    );
    // A handful of what the team is actually working on, so the workspace
    // has something in it before anyone has labelled a thing.
    const starters = await importStarterIssues(ctx, config);
    activity({
      level: "info",
      source: "job",
      message:
        `First sync — the "${labelName}" label is ready in Linear` +
        (starters > 0 ? `, and ${starters} recent issue(s) came in to start with` : "") +
        `; issues labelled from now on come in automatically, older ones with “Import labelled issues”`,
    });
    return;
  }
  const cursor = stored;

  const issues = await requireClient().issuesUpdatedSince(cursor, {
    labelName,
    limit: 100,
  });

  let newest = cursor;
  /** Labelled issues this workspace has nowhere to put; reported once. */
  const homeless: string[] = [];
  for (const issue of issues) {
    if (issue.updatedAt > newest) newest = issue.updatedAt;
    if (!issueHasLabelOnObject(issue, labelName)) continue;

    // Refresh existing link if we already track this Linear issue.
    const linked = await ctx.entities.list({
      entityType: ENTITY_TYPES.linearIssue,
      externalId: issue.id,
      limit: 1,
    });
    if (linked[0]?.scopeId) {
      await ctx.entities.upsert({
        entityType: ENTITY_TYPES.linearIssue,
        scopeKind: "issue",
        scopeId: linked[0].scopeId,
        externalId: issue.id,
        title: issue.title,
        status: issue.state.name,
        data: asRecord(issue),
      });
      continue;
    }

    // Otherwise import it, wherever this workspace puts labelled issues.
    if (!config.importLinearIssues) continue;
    const target = await importTarget(ctx, config, issue.project?.id ?? null);
    if (!target) {
      homeless.push(issue.identifier);
      continue;
    }

    try {
      const created = await importLinearIssue(ctx, issue, target);
      if (created) {
        activity({
          level: "info",
          source: "job",
          message: `Imported ${issue.identifier} via incremental sync`,
        });
      }
    } catch (error) {
      ctx.logger.error("Incremental import failed", {
        issueId: issue.id,
        error: summarizeError(error),
      });
    }
  }

  await ctx.state.set(
    { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: STATE_KEYS.syncCursor },
    newest,
  );
  await ctx.state.set(
    {
      scopeKind: "instance",
      namespace: STATE_NAMESPACE,
      stateKey: STATE_KEYS.lastIncrementalSyncAt,
    },
    new Date().toISOString(),
  );
  if (homeless.length > 0) {
    activity({
      level: "warning",
      source: "job",
      message: `${homeless.length} labelled issue(s) have nowhere to land (${homeless.slice(0, 3).join(", ")}) — name a default project in the Linear settings, or link their Linear project`,
    });
  }
  activity({
    level: "info",
    source: "job",
    message: `Incremental sync — ${issues.length} labelled Linear updates`,
  });
}

// ---------------------------------------------------------------------------
// UI data + action handlers
// ---------------------------------------------------------------------------

function registerDataHandlers(ctx: PluginContext): void {
  ctx.data.register(DATA_KEYS.syncHealth, async () => {
    const [lastFull, lastInc, lastHook, importingSince] = await Promise.all([
      ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.lastFullSyncAt,
      }),
      ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.lastIncrementalSyncAt,
      }),
      ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.lastWebhookAt,
      }),
      ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.syncCursor,
      }),
    ]);
    const links = await ctx.entities.list({
      entityType: ENTITY_TYPES.linearIssue,
      scopeKind: "issue",
      limit: 1000,
    });
    return {
      configured: Boolean(currentClient),
      lastFullSyncAt: lastFull as string | null,
      lastIncrementalSyncAt: lastInc as string | null,
      lastWebhookAt: lastHook as string | null,
      linkedIssueCount: links.length,
      importLabelName:
        currentConfig?.importLabelName ?? DEFAULT_CONFIG.importLabelName,
      // Where automatic import starts: issues labelled after this come in on
      // their own, older ones only when someone imports them.
      importingSince: importingSince as string | null,
    };
  });

  ctx.data.register(DATA_KEYS.recentActivity, async () => ({
    entries: recentActivity.slice(0, 25),
  }));

  ctx.data.register(DATA_KEYS.linearTeams, async () => {
    const cached =
      ((await ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.cachedLinearTeams,
      })) as LinearTeam[] | null) ?? [];
    return { teams: cached };
  });

  ctx.data.register(DATA_KEYS.linearProjects, async () => {
    const cached =
      ((await ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.cachedLinearProjects,
      })) as LinearProject[] | null) ?? [];
    return { projects: cached };
  });

  ctx.data.register(DATA_KEYS.paperclipCompanies, async () => {
    const companies = await ctx.companies.list({ limit: 100 });
    return { companies };
  });

  ctx.data.register(DATA_KEYS.paperclipProjects, async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!companyId) return { projects: [] };
    const projects = await ctx.projects.list({ companyId, limit: 200 });
    return {
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        urlKey: p.urlKey,
        companyId: p.companyId,
      })),
    };
  });

  ctx.data.register(DATA_KEYS.projectLink, async (params) => {
    const projectId = typeof params.projectId === "string" ? params.projectId : null;
    if (!projectId) return { link: null };
    const link = await getProjectLink(ctx, projectId);
    return { link };
  });

  ctx.data.register(DATA_KEYS.projectLinks, async () => {
    // Fetch all companies, then walk projects, then read each project's link.
    // This is fine for the small instance scale this plugin targets.
    const companies = await ctx.companies.list({ limit: 100 });
    const rows: Array<{
      paperclipProjectId: string;
      paperclipProjectName: string;
      companyId: string;
      companyName: string;
      link: LinearProjectLink | null;
    }> = [];
    for (const company of companies) {
      const projects = await ctx.projects.list({ companyId: company.id, limit: 200 });
      for (const project of projects) {
        const link = await getProjectLink(ctx, project.id);
        rows.push({
          paperclipProjectId: project.id,
          paperclipProjectName: project.name,
          companyId: company.id,
          companyName: company.name,
          link,
        });
      }
    }
    return { rows };
  });

  ctx.data.register(DATA_KEYS.issueLink, async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    if (!issueId) return { link: null };
    const link = await getIssueLink(ctx, issueId);
    return { link };
  });
}

function registerActionHandlers(ctx: PluginContext): void {
  ctx.actions.register(ACTION_KEYS.testConnection, async () => {
    if (!currentClient) {
      return {
        ok: false,
        error: "No API key configured. Paste your Linear key in Settings, then try again.",
      };
    }
    try {
      const viewer = await currentClient.viewer();
      activity({
        level: "info",
        source: "action",
        message: `Connected as ${viewer.name} (${viewer.organization.name})`,
      });
      return { ok: true, viewer };
    } catch (error) {
      const message = summarizeError(error);
      activity({ level: "error", source: "action", message: `Test connection failed: ${message}` });
      return { ok: false, error: message };
    }
  });

  ctx.actions.register(ACTION_KEYS.fullSync, async () => {
    await runFullSync({
      jobKey: JOB_KEYS.fullSync,
      runId: randomUUID(),
      trigger: "manual",
      scheduledAt: new Date().toISOString(),
    });
    return { ok: true };
  });

  ctx.actions.register(ACTION_KEYS.refreshLinearProjects, async () => {
    const { teams, projects } = await refreshLinearCache(ctx);
    return { ok: true, teams: teams.length, projects: projects.length };
  });

  ctx.actions.register(ACTION_KEYS.linkProject, async (params) => {
    const paperclipProjectId =
      typeof params.paperclipProjectId === "string" ? params.paperclipProjectId : null;
    const linearProjectId =
      typeof params.linearProjectId === "string" ? params.linearProjectId : null;
    const linearTeamId = typeof params.linearTeamId === "string" ? params.linearTeamId : null;
    if (!paperclipProjectId) throw new Error("paperclipProjectId is required");
    if (!linearTeamId && !linearProjectId)
      throw new Error("linearTeamId or linearProjectId is required");

    // Need company for the Paperclip project so we can scope future imports.
    // Look up the project to fish out its companyId.
    let companyId: string | null = null;
    let companyName = "";
    const companies = await ctx.companies.list({ limit: 100 });
    for (const company of companies) {
      const project = await ctx.projects.get(paperclipProjectId, company.id);
      if (project) {
        companyId = company.id;
        companyName = company.name;
        break;
      }
    }
    if (!companyId) throw new Error(`Paperclip project ${paperclipProjectId} not found`);

    // Resolve Linear project and team metadata from cache (or refresh if missing).
    const cachedProjects =
      ((await ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.cachedLinearProjects,
      })) as LinearProject[] | null) ?? [];
    const cachedTeams =
      ((await ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.cachedLinearTeams,
      })) as LinearTeam[] | null) ?? [];

    let linearProject: LinearProject | undefined = cachedProjects.find(
      (p) => p.id === linearProjectId,
    );
    let team: LinearTeam | undefined =
      cachedTeams.find((t) => t.id === linearTeamId) ??
      linearProject?.teams[0];

    // If we don't have it cached yet, refresh from Linear.
    if ((linearProjectId && !linearProject) || (linearTeamId && !team)) {
      const fresh = await refreshLinearCache(ctx);
      linearProject = fresh.projects.find((p) => p.id === linearProjectId) ?? linearProject;
      team =
        fresh.teams.find((t) => t.id === linearTeamId) ??
        linearProject?.teams[0] ??
        team;
    }

    const resolvedTeam = team;
    if (!resolvedTeam) {
      throw new Error("Could not resolve a Linear team for this link");
    }

    const link: LinearProjectLink = {
      paperclipProjectId,
      companyId,
      linearTeamId: resolvedTeam.id,
      linearTeamName: resolvedTeam.name,
      linearProjectId: linearProject?.id ?? null,
      linearProjectName: linearProject?.name ?? null,
      linkedAt: new Date().toISOString(),
    };
    await setProjectLink(ctx, paperclipProjectId, link);

    activity({
      level: "info",
      source: "action",
      message: `Linked ${companyName} project → ${linearProject?.name ?? resolvedTeam.name}`,
    });
    return { ok: true, link };
  });

  ctx.actions.register(ACTION_KEYS.backfillProject, async (params) => {
    const paperclipProjectId =
      typeof params.paperclipProjectId === "string" ? params.paperclipProjectId : null;
    if (!paperclipProjectId) throw new Error("paperclipProjectId is required");
    const link = await getProjectLink(ctx, paperclipProjectId);
    if (!link) throw new Error("Paperclip project is not linked yet");

    let pushed = 0;
    let skipped = 0;
    let failed = 0;
    let parentLinks = 0;
    let offset = 0;
    const batchSize = 50;
    /** Every Paperclip issue we touched this run (push + skip), so pass 2 can
     *  patch parent links for issues that already had a Linear link. */
    const visited: Issue[] = [];

    // ----- Pass 1: push every Paperclip issue (status mapped). Parents may
    // not exist on the Linear side yet, so we leave parentId for pass 2. -----
    while (true) {
      const issues = await ctx.issues.list({
        companyId: link.companyId,
        projectId: paperclipProjectId,
        limit: batchSize,
        offset,
      });
      if (issues.length === 0) break;

      for (const issue of issues) {
        visited.push(issue);
        const existing = await getIssueLink(ctx, issue.id);
        if (existing) {
          skipped += 1;
          continue;
        }
        try {
          const stateId = await getStateIdForStatus(ctx, link.linearTeamId, issue.status);
          const linearIssue = await requireClient().createIssue({
            teamId: link.linearTeamId,
            title: issue.title,
            ...(issue.description ? { description: issue.description } : {}),
            ...(link.linearProjectId ? { projectId: link.linearProjectId } : {}),
            ...(stateId ? { stateId } : {}),
          });
          const issueLink: LinearIssueLink = {
            linearIssueId: linearIssue.id,
            linearIdentifier: linearIssue.identifier,
            linearUrl: linearIssue.url,
            linearTeamId: linearIssue.team.id,
            linearProjectId: linearIssue.project?.id ?? null,
            pushedAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
          };
          await setIssueLink(ctx, issue.id, issueLink);
          await ctx.entities.upsert({
            entityType: ENTITY_TYPES.linearIssue,
            scopeKind: "issue",
            scopeId: issue.id,
            externalId: linearIssue.id,
            title: linearIssue.title,
            status: linearIssue.state.name,
            data: { ...asRecord(linearIssue), paperclipIssueId: issue.id },
          });
          pushed += 1;
        } catch (error) {
          failed += 1;
          ctx.logger.error("Backfill push failed", {
            issueId: issue.id,
            error: summarizeError(error),
          });
        }
      }

      if (issues.length < batchSize) break;
      offset += batchSize;
    }

    // ----- Pass 2: stitch parent → child relations now that every issue we
    // care about has a Linear link. We walk every visited issue and, when its
    // Paperclip parent has a Linear link (and the Linear issue does not yet
    // point at it), patch the Linear issue's parentId. -----
    for (const issue of visited) {
      if (!issue.parentId) continue;
      const childLink = await getIssueLink(ctx, issue.id);
      if (!childLink) continue;
      const parentLink = await getIssueLink(ctx, issue.parentId);
      if (!parentLink) continue;
      try {
        await requireClient().updateIssue(childLink.linearIssueId, {
          parentId: parentLink.linearIssueId,
        });
        parentLinks += 1;
      } catch (error) {
        ctx.logger.warn("Backfill parent linking failed", {
          issueId: issue.id,
          error: summarizeError(error),
        });
      }
    }

    activity({
      level: failed > 0 ? "warning" : "info",
      source: "action",
      message: `Backfill: ${pushed} pushed, ${skipped} already linked, ${failed} failed, ${parentLinks} parent links`,
    });
    return { ok: true, pushed, skipped, failed, parentLinks };
  });

  // Bringing in the issues a team already has is a decision, not a side
  // effect of connecting a tracker: it happens when someone presses the
  // button, one capped batch at a time. Issues already linked are skipped,
  // so pressing it twice is safe.
  ctx.actions.register(ACTION_KEYS.importProject, async (params) => {
    const paperclipProjectId =
      typeof params.paperclipProjectId === "string" ? params.paperclipProjectId : null;
    if (!paperclipProjectId) throw new Error("paperclipProjectId is required");
    // A link is not required: importing into the project someone is looking
    // at is the plain reading of the button. When the project *is* linked to
    // a Linear project, only that project's issues come in.
    const link = await getProjectLink(ctx, paperclipProjectId);
    const companyId = link?.companyId ?? (await companyOfProject(ctx, paperclipProjectId));
    if (!companyId) throw new Error("That Tandem project could not be found");
    const target: ImportTarget = {
      companyId,
      projectId: paperclipProjectId,
      linearProjectId: link?.linearProjectId ?? null,
    };
    const labelName =
      requireConfig().importLabelName ?? DEFAULT_CONFIG.importLabelName;
    // Labelled issues are the default; a workspace that has just connected
    // has none, and asking someone to go and label a backlog before they
    // see anything work is the wrong order. `labelled: false` brings in what
    // the team touched most recently instead.
    const onlyLabelled = params.labelled !== false;
    if (onlyLabelled && !labelName) throw new Error("No import label is configured");
    const limit = importBatchSize(params.limit);

    // Linear orders `updatedAt` newest first, so a capped press brings in
    // what the team touched most recently — the part of a backlog anyone
    // would want first.
    const issues = await requireClient().issuesUpdatedSince(BEGINNING_OF_TIME, {
      ...(target.linearProjectId ? { projectId: target.linearProjectId } : {}),
      ...(onlyLabelled ? { labelName } : {}),
      limit,
    });

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    for (const issue of issues) {
      try {
        const created = await importLinearIssue(ctx, issue, target);
        if (created) imported += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        ctx.logger.error("Import failed", {
          issueId: issue.id,
          error: summarizeError(error),
        });
      }
    }
    activity({
      level: failed > 0 ? "warning" : "info",
      source: "action",
      message: `Import${onlyLabelled ? "" : " (any label)"}: ${imported} imported, ${skipped} already linked, ${failed} failed`,
    });
    return { ok: true, imported, skipped, failed, examined: issues.length, limit, labelled: onlyLabelled };
  });

  ctx.actions.register(ACTION_KEYS.unlinkProject, async (params) => {
    const paperclipProjectId =
      typeof params.paperclipProjectId === "string" ? params.paperclipProjectId : null;
    if (!paperclipProjectId) throw new Error("paperclipProjectId is required");
    await deleteProjectLink(ctx, paperclipProjectId);
    activity({
      level: "info",
      source: "action",
      message: `Unlinked Paperclip project ${paperclipProjectId}`,
    });
    return { ok: true };
  });

  ctx.actions.register(ACTION_KEYS.linkIssue, async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    const linearIssueId = typeof params.linearIssueId === "string" ? params.linearIssueId : null;
    if (!issueId || !linearIssueId) {
      throw new Error("issueId and linearIssueId are required");
    }
    const linear = await requireClient().getIssue(linearIssueId);
    if (!linear) throw new Error(`Linear issue ${linearIssueId} not found`);
    const link: LinearIssueLink = {
      linearIssueId: linear.id,
      linearIdentifier: linear.identifier,
      linearUrl: linear.url,
      linearTeamId: linear.team.id,
      linearProjectId: linear.project?.id ?? null,
      pushedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };
    await setIssueLink(ctx, issueId, link);
    await ctx.entities.upsert({
      entityType: ENTITY_TYPES.linearIssue,
      scopeKind: "issue",
      scopeId: issueId,
      externalId: linear.id,
      title: linear.title,
      status: linear.state.name,
      data: asRecord(linear),
    });
    return { ok: true, link };
  });

  ctx.actions.register(ACTION_KEYS.unlinkIssue, async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    if (!issueId) throw new Error("issueId is required");
    await deleteIssueLink(ctx, issueId);
    return { ok: true };
  });

  ctx.actions.register(ACTION_KEYS.pushIssue, async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : null;
    const companyId = typeof params.companyId === "string" ? params.companyId : null;
    if (!issueId || !companyId) throw new Error("issueId and companyId are required");
    await handlePaperclipIssueCreated({
      eventId: randomUUID(),
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      companyId,
      entityId: issueId,
      entityType: "issue",
      payload: {},
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Tool handlers (agent-facing)
// ---------------------------------------------------------------------------

function registerToolHandlers(ctx: PluginContext): void {
  ctx.tools.register(
    TOOL_NAMES.createLinearIssue,
    {
      displayName: "Create Linear Issue",
      description:
        "Creates a new issue in Linear. If the agent's current Paperclip project is linked, the issue lands in the linked Linear project.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          paperclipProjectId: { type: "string" },
          paperclipIssueId: { type: "string" },
          teamId: { type: "string" },
          projectId: { type: "string" },
        },
        required: ["title"],
      },
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const p = params as {
        title: string;
        description?: string;
        paperclipProjectId?: string;
        paperclipIssueId?: string;
        teamId?: string;
        projectId?: string;
      };
      let teamId = p.teamId;
      let projectId = p.projectId;
      const sourceProjectId = p.paperclipProjectId ?? runCtx.projectId;
      if ((!teamId || !projectId) && sourceProjectId) {
        const link = await getProjectLink(ctx, sourceProjectId);
        if (link) {
          teamId = teamId ?? link.linearTeamId;
          projectId = projectId ?? link.linearProjectId ?? undefined;
        }
      }
      if (!teamId) {
        return {
          error:
            "Cannot create Linear issue: this Paperclip project is not linked to a Linear project (or team).",
        };
      }
      try {
        const issue = await requireClient().createIssue({
          teamId,
          title: p.title,
          ...(p.description ? { description: p.description } : {}),
          ...(projectId ? { projectId } : {}),
        });
        if (p.paperclipIssueId) {
          await setIssueLink(ctx, p.paperclipIssueId, {
            linearIssueId: issue.id,
            linearIdentifier: issue.identifier,
            linearUrl: issue.url,
            linearTeamId: issue.team.id,
            linearProjectId: issue.project?.id ?? null,
            pushedAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
          });
        }
        activity({
          level: "info",
          source: "tool",
          message: `Agent created Linear ${issue.identifier}`,
        });
        return {
          content: `Created ${issue.identifier}: ${issue.url}`,
          data: { issue },
        };
      } catch (error) {
        return { error: summarizeError(error) };
      }
    },
  );

  ctx.tools.register(
    TOOL_NAMES.searchLinearIssues,
    {
      displayName: "Search Linear Issues",
      description: "Searches Linear for issues matching a query string.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["query"],
      },
    },
    async (params): Promise<ToolResult> => {
      const p = params as { query: string; limit?: number };
      try {
        const results = await requireClient().searchIssues(p.query, p.limit ?? 10);
        const summary = results
          .map((r) => `- ${r.identifier} ${r.title} (${r.state.name})`)
          .join("\n");
        return {
          content: results.length ? summary : "No matching Linear issues",
          data: { results },
        };
      } catch (error) {
        return { error: summarizeError(error) };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("Linear plugin starting up");

    currentConfig = await loadConfig(ctx);
    currentClient = await buildClient(ctx, currentConfig);
    if (!currentClient) {
      ctx.logger.warn("Linear plugin not fully configured at startup", {
        reason: "missing apiKey/apiKeyRef",
      });
    }

    ctx.events.on("issue.created", handlePaperclipIssueCreated);
    ctx.events.on("issue.updated", handlePaperclipIssueUpdated);
    ctx.events.on("issue.comment.created", handlePaperclipCommentCreated);

    ctx.jobs.register(JOB_KEYS.fullSync, runFullSync);
    ctx.jobs.register(JOB_KEYS.incrementalSync, runIncrementalSync);

    registerDataHandlers(ctx);
    registerActionHandlers(ctx);
    registerToolHandlers(ctx);
  },

  async onConfigChanged(newConfig) {
    const ctx = requireCtx();
    try {
      currentConfig = { ...DEFAULT_CONFIG, ...(newConfig as Partial<LinearPluginConfig>) };
      currentClient = await buildClient(ctx, currentConfig);
      cachedImportLabel = null;
      ctx.logger.info("Linear plugin reconfigured", {
        configured: Boolean(currentClient),
      });
    } catch (error) {
      ctx.logger.error("Failed to apply Linear config change", { error: summarizeError(error) });
    }
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const c = { ...DEFAULT_CONFIG, ...(config as Partial<LinearPluginConfig>) };
    if (!c.apiKey && !c.apiKeyRef) errors.push("Provide either apiKey or apiKeyRef");

    if (currentContext && (c.apiKey || c.apiKeyRef)) {
      try {
        const apiKey = await resolveApiKey(currentContext, c);
        if (!apiKey) {
          errors.push("Could not resolve API key");
        } else {
          const probe = new LinearClient({
            apiUrl: c.apiUrl ?? DEFAULTS.apiUrl,
            apiKey,
            http: currentContext.http,
            logger: currentContext.logger,
          });
          const viewer = await probe.viewer();
          warnings.push(
            `Connected to Linear org "${viewer.organization.name}" as ${viewer.email}`,
          );
        }
      } catch (error) {
        if (error instanceof LinearApiError) {
          errors.push(`Linear API rejected the key (HTTP ${error.status})`);
        } else {
          errors.push(`Could not reach Linear: ${summarizeError(error)}`);
        }
      }
    }

    return { ok: errors.length === 0, warnings, errors };
  },

  async onWebhook(input) {
    if (input.endpointKey !== WEBHOOK_KEYS.linear) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }
    await handleLinearWebhook(input);
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    if (!currentClient) {
      return {
        status: "degraded",
        message:
          "Linear API client not initialized — paste an API key in plugin settings",
      };
    }
    const ctx = requireCtx();
    const [lastFull, lastInc, lastHook] = await Promise.all([
      ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.lastFullSyncAt,
      }),
      ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.lastIncrementalSyncAt,
      }),
      ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: STATE_KEYS.lastWebhookAt,
      }),
    ]);
    return {
      status: "ok",
      message: "Linear plugin running",
      details: {
        lastFullSyncAt: lastFull,
        lastIncrementalSyncAt: lastInc,
        lastWebhookAt: lastHook,
        recentActivityCount: recentActivity.length,
      },
    };
  },

  async onShutdown() {
    activity({ level: "warning", source: "event", message: "Linear plugin shutting down" });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
