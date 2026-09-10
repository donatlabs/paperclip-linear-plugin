/**
 * Plugin-internal types — config shape, persisted state shape, and Linear API
 * shapes the worker code uses. The manifest's JSON Schema is the source of
 * truth for what the operator can actually configure; this file mirrors that
 * shape for typed worker code.
 */

export interface LinearPluginConfig {
  /**
   * Raw Linear API token. Easiest path — the user pastes their key here.
   * Stored encrypted at rest only if the host encrypts plugin_config rows;
   * prefer `apiKeyRef` for stronger isolation.
   */
  apiKey?: string;
  /** Secret reference resolved through ctx.secrets to the Linear API token. */
  apiKeyRef?: string;
  /** Optional override of the Linear GraphQL endpoint (useful for testing). */
  apiUrl?: string;
  /** Raw HMAC signing secret for Linear webhook deliveries. */
  webhookSecret?: string;
  /** Secret reference for the webhook signing secret (HMAC SHA-256). */
  webhookSecretRef?: string;
  /** Whether to mirror new Paperclip issues into Linear automatically. */
  pushPaperclipIssues?: boolean;
  /** Whether to import Linear issues as Paperclip issues automatically. */
  importLinearIssues?: boolean;
  /**
   * Linear label name that gates imports. Only Linear issues that carry this
   * label will be imported into Paperclip (so agents only pick them up). The
   * plugin auto-creates the label in Linear on first sync.
   */
  importLabelName?: string;
  /** Polling interval for incremental sync in minutes. */
  incrementalSyncMinutes?: number;
  /**
   * Where a labelled Linear issue lands when its Linear project is not
   * linked to a Tandem project — or when it has no Linear project at all.
   * A workspace with a single project needs neither of these: that project
   * is the only answer, and the plugin uses it.
   */
  defaultProjectId?: string;
  /** The company owning defaultProjectId; found from the project if unset. */
  defaultCompanyId?: string;
}

export const DEFAULT_CONFIG: Required<
  Pick<
    LinearPluginConfig,
    | "apiUrl"
    | "pushPaperclipIssues"
    | "importLinearIssues"
    | "incrementalSyncMinutes"
    | "importLabelName"
  >
> = {
  apiUrl: "https://api.linear.app/graphql",
  pushPaperclipIssues: true,
  importLinearIssues: true,
  incrementalSyncMinutes: 1,
  importLabelName: "paperclip",
};

/** Where one imported Linear issue lands. */
export interface ImportTarget {
  /** Tandem company that owns the project. */
  companyId: string;
  /** Tandem project the issue is created in. */
  projectId: string;
  /** The Linear project it came from, when it had one. */
  linearProjectId: string | null;
}

/** Per-Paperclip-project ↔ Linear-project link. */
export interface LinearProjectLink {
  /** Paperclip project this link belongs to. */
  paperclipProjectId: string;
  /** Paperclip company that owns the Paperclip project. */
  companyId: string;
  /** Linear team that hosts the linked project. Required by Linear when creating issues. */
  linearTeamId: string;
  linearTeamName: string;
  /** Linear project ID. Optional — without it, issues land in the team but no project. */
  linearProjectId: string | null;
  linearProjectName: string | null;
  linkedAt: string;
}

/** Per-issue link state stored under `scopeKind=issue, scopeId=<paperclipIssueId>`. */
export interface LinearIssueLink {
  linearIssueId: string;
  linearIdentifier: string;
  linearUrl: string;
  linearTeamId: string;
  linearProjectId: string | null;
  pushedAt: string;
  lastSyncedAt: string;
}

export interface RecentActivityEntry {
  id: string;
  level: "info" | "warning" | "error";
  source: "event" | "job" | "webhook" | "action" | "tool";
  message: string;
  createdAt: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Linear API shapes — only the fields this plugin actually reads.
// ---------------------------------------------------------------------------

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
  organization: { id: string; name: string; urlKey: string };
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearProject {
  id: string;
  name: string;
  description: string | null;
  state: string | null;
  url: string;
  teams: LinearTeam[];
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string | null;
  team?: { id: string } | null;
}

export type LinearWorkflowStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: LinearWorkflowStateType;
  position: number;
  team: { id: string };
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string; name: string };
  project?: { id: string; name: string } | null;
  labels?: { nodes: LinearLabel[] };
  updatedAt: string;
  createdAt: string;
}

export interface LinearWebhookIssueData {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  team?: { id?: string; key?: string; name?: string };
  project?: { id?: string; name?: string } | null;
  state?: { id?: string; name?: string; type?: string };
  labels?: Array<{ id: string; name: string; color?: string | null }>;
  labelIds?: string[];
}

export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: "Issue" | "Comment" | "Project" | string;
  data: LinearWebhookIssueData & Record<string, unknown>;
  url?: string;
  createdAt?: string;
  updatedFrom?: Record<string, unknown>;
}
