import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";
import { DEFAULT_CONFIG } from "./types.js";

/**
 * Linear plugin manifest.
 *
 * Capabilities are intentionally narrow:
 * - issue read/create/update + comments (mirroring Paperclip ↔ Linear)
 * - http.outbound + secrets.read-ref (Linear API access)
 * - webhooks + jobs (incoming Linear changes + periodic sync)
 * - state read/write (idempotency + project links + cursors)
 * - agent tool registration (let agents create Linear issues)
 *
 * The plugin does NOT request approval, budget, or auth-bypass capabilities —
 * those are off-limits per the spec (§15.2).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Linear",
  description:
    "Two-way sync between Paperclip projects and a Linear workspace. Pick which Paperclip project links to which Linear project; new Paperclip issues push to the linked Linear project, Linear issues that carry a configured label are imported back so agents can pick them up.",
  author: "Paperclip",
  categories: ["connector", "automation", "ui"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "instance.settings.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        title: "Linear API Key",
        description:
          "Paste your Linear personal API key here (Linear → Settings → API → Personal API keys). Stored encrypted at rest. For stronger isolation, use apiKeyRef instead.",
      },
      apiKeyRef: {
        type: "string",
        title: "Linear API Key (secret ref)",
        description:
          "Optional: reference an entry in the Paperclip secret provider instead of pasting the key above.",
        format: "secret-ref",
      },
      webhookSecret: {
        type: "string",
        title: "Linear Webhook Signing Secret",
        description: "Paste the HMAC SHA-256 signing secret Linear shows when you create the webhook.",
      },
      webhookSecretRef: {
        type: "string",
        title: "Linear Webhook Signing Secret (secret ref)",
        format: "secret-ref",
      },
      apiUrl: {
        type: "string",
        title: "Linear GraphQL Endpoint",
        default: DEFAULT_CONFIG.apiUrl,
      },
      pushPaperclipIssues: {
        type: "boolean",
        title: "Push new Paperclip issues to Linear",
        default: DEFAULT_CONFIG.pushPaperclipIssues,
      },
      importLinearIssues: {
        type: "boolean",
        title: "Import labelled Linear issues into Paperclip",
        default: DEFAULT_CONFIG.importLinearIssues,
      },
      importLabelName: {
        type: "string",
        title: "Import label",
        description:
          "Linear label name that gates imports — only Linear issues with this label are pulled into Paperclip. The plugin auto-creates the label on first sync.",
        default: DEFAULT_CONFIG.importLabelName,
      },
      incrementalSyncMinutes: {
        type: "integer",
        title: "Incremental Sync Frequency (minutes)",
        minimum: 1,
        maximum: 1440,
        default: DEFAULT_CONFIG.incrementalSyncMinutes,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.fullSync,
      displayName: "Linear: Full Sync",
      description:
        "Refresh cached Linear teams, projects, and labels; reconcile mapped projects.",
      schedule: "0 3 * * *",
    },
    {
      jobKey: JOB_KEYS.incrementalSync,
      displayName: "Linear: Incremental Sync",
      description:
        "Pull labelled Linear issues updated since the last cursor, per linked project.",
      schedule: "*/15 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.linear,
      displayName: "Linear Webhook",
      description:
        "Receives create/update/remove events from Linear for issues and comments. Configure this URL inside Linear → Settings → API → Webhooks.",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.createLinearIssue,
      displayName: "Create Linear Issue",
      description:
        "Creates a new issue in Linear. If the agent's current Paperclip project is linked to a Linear project, the issue is created there.",
      parametersSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Linear issue title" },
          description: { type: "string", description: "Markdown description" },
          paperclipProjectId: {
            type: "string",
            description:
              "Optional Paperclip project UUID. When provided, resolves the linked Linear project automatically.",
          },
          paperclipIssueId: {
            type: "string",
            description:
              "Optional Paperclip issue UUID. When provided, the resulting Linear issue is linked to it for future bidirectional sync.",
          },
          teamId: {
            type: "string",
            description: "Optional Linear team UUID override.",
          },
          projectId: {
            type: "string",
            description: "Optional Linear project UUID override.",
          },
        },
        required: ["title"],
      },
    },
    {
      name: TOOL_NAMES.searchLinearIssues,
      displayName: "Search Linear Issues",
      description:
        "Searches Linear for issues matching a query string and returns identifier/title/url for the top matches.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: ["query"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Linear",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Linear Sync",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "detailTab",
        id: SLOT_IDS.issueDetailTab,
        displayName: "Linear",
        exportName: EXPORT_NAMES.issueDetailTab,
        entityTypes: ["issue"],
      },
      {
        type: "detailTab",
        id: SLOT_IDS.projectDetailTab,
        displayName: "Linear",
        exportName: EXPORT_NAMES.projectDetailTab,
        entityTypes: ["project"],
      },
      {
        type: "projectSidebarItem",
        id: SLOT_IDS.projectSidebarItem,
        displayName: "Linear",
        exportName: EXPORT_NAMES.projectSidebarItem,
        entityTypes: ["project"],
      },
    ],
  },
};

export default manifest;
