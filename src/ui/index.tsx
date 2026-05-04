/**
 * Plugin UI bundle entrypoint.
 *
 * The host loads this module dynamically and looks up the `exportName` declared
 * for each slot in the manifest. Every named export below must match exactly
 * one slot's `exportName` so the host can mount the right component.
 *
 * NOTE: there is intentionally no `LinearSettingsPage` export. The plugin's
 * config (apiKey, webhookSecret, importLabelName, etc.) is rendered by the
 * host's auto-generated JSON Schema form at /settings/plugins/paperclip.linear,
 * which is replaced if the plugin declares a `settingsPage` slot. We want the
 * host's form here so the user actually gets editable inputs.
 */

export { LinearDashboardWidget } from "./DashboardWidget.js";
export { LinearIssueDetailTab } from "./IssueDetailTab.js";
export { LinearPage } from "./Page.js";
export { LinearProjectDetailTab } from "./ProjectDetailTab.js";
export { LinearProjectSidebarItem } from "./ProjectSidebarItem.js";
