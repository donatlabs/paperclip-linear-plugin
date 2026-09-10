/**
 * Stable identifiers used by the Linear plugin manifest, worker, and UI bundle.
 * Keeping them in one place makes it harder for the manifest to drift away from
 * the data/action/job/webhook/tool keys the worker actually registers.
 */

export const PLUGIN_ID = "paperclip.linear";
export const PLUGIN_VERSION = "0.5.1";

export const PAGE_ROUTE = "linear";

export const SLOT_IDS = {
  page: "linear-page",
  dashboardWidget: "linear-dashboard-widget",
  issueDetailTab: "linear-issue-detail-tab",
  projectDetailTab: "linear-project-detail-tab",
  projectSidebarItem: "linear-project-sidebar-item",
} as const;

export const EXPORT_NAMES = {
  page: "LinearPage",
  dashboardWidget: "LinearDashboardWidget",
  issueDetailTab: "LinearIssueDetailTab",
  projectDetailTab: "LinearProjectDetailTab",
  projectSidebarItem: "LinearProjectSidebarItem",
} as const;

export const DATA_KEYS = {
  syncHealth: "sync-health",
  issueLink: "issue-link",
  recentActivity: "recent-activity",
  // Linear-side: cached teams + projects + labels for picker UIs.
  linearTeams: "linear-teams",
  linearProjects: "linear-projects",
  // Paperclip-side: companies + projects to render link table.
  paperclipCompanies: "paperclip-companies",
  paperclipProjects: "paperclip-projects",
  // Project-level link lookup for sidebar / detail tabs.
  projectLink: "project-link",
  // All project links (for the central settings table).
  projectLinks: "project-links",
} as const;

export const ACTION_KEYS = {
  testConnection: "test-connection",
  fullSync: "full-sync",
  refreshLinearProjects: "refresh-linear-projects",
  // Project linking
  linkProject: "link-project",
  unlinkProject: "unlink-project",
  backfillProject: "backfill-project",
  importProject: "import-project",
  // Issue linking
  linkIssue: "link-issue",
  unlinkIssue: "unlink-issue",
  pushIssue: "push-issue",
} as const;

export const JOB_KEYS = {
  fullSync: "full-sync",
  incrementalSync: "incremental-sync",
} as const;

export const WEBHOOK_KEYS = {
  linear: "linear",
} as const;

export const TOOL_NAMES = {
  createLinearIssue: "create-linear-issue",
  searchLinearIssues: "search-linear-issues",
} as const;

export const STATE_NAMESPACE = "linear";

export const STATE_KEYS = {
  lastFullSyncAt: "last-full-sync-at",
  lastIncrementalSyncAt: "last-incremental-sync-at",
  lastWebhookAt: "last-webhook-at",
  // Per-issue link (scopeKind=issue)
  linearLink: "linear-link",
  // Per-Paperclip-project link (scopeKind=project)
  projectLink: "project-link",
  // Per-Linear-project reverse index → Paperclip project ID (scopeKind=instance, namespace=linear)
  reverseProjectLink: "reverse-project-link",
  // Sync cursor per Paperclip project (scopeKind=project)
  syncCursor: "sync-cursor",
  // Cached Linear projects list (scopeKind=instance)
  cachedLinearProjects: "cached-linear-projects",
  cachedLinearTeams: "cached-linear-teams",
  importLabelId: "import-label-id",
  /** Cache prefix; full key is `<workflowStatesByTeam>:<teamId>`. */
  workflowStatesByTeam: "workflow-states-by-team",
} as const;

export const ENTITY_TYPES = {
  linearIssue: "linear-issue",
  linearTeam: "linear-team",
  linearProject: "linear-project",
} as const;

export const ACTIVITY_BUFFER_MAX = 50;

/**
 * How many labelled Linear issues one press of "Import labelled issues"
 * brings in. Importing a team's existing tracker is deliberate and capped:
 * a workspace fills up a batch at a time, at the pace someone asks for.
 */
export const IMPORT_BATCH_DEFAULT = 25;
export const IMPORT_BATCH_MAX = 100;

export const DEFAULTS = {
  apiUrl: "https://api.linear.app/graphql",
  webhookSignatureHeader: "linear-signature",
} as const;
