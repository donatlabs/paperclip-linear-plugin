import {
  usePluginData,
  type PluginProjectSidebarItemProps,
} from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS, PLUGIN_ID, SLOT_IDS } from "../constants.js";
import type { LinearProjectLink } from "../types.js";
import * as s from "./styles.js";

/**
 * Sidebar entry rendered under each Paperclip project. Click to jump to the
 * project's detail page with the Linear tab focused — that's where the user
 * actually picks a Linear project to link.
 *
 * The host's documented URL shape for plugin tabs is
 * `?tab=plugin:<pluginKey>:<slotId>` appended to the project route. We don't
 * know the exact project URL prefix Paperclip uses, so we use a best-effort
 * shape: if `companyPrefix` is present, route to
 * `/<companyPrefix>/projects/<projectId>?tab=...`, otherwise rely on the host
 * to resolve the relative form.
 */
export function LinearProjectSidebarItem({ context }: PluginProjectSidebarItemProps) {
  const { data } = usePluginData<{ link: LinearProjectLink | null }>(
    DATA_KEYS.projectLink,
    { projectId: context.entityId },
  );
  const link = data?.link ?? null;

  const tab = `plugin:${PLUGIN_ID}:${SLOT_IDS.projectDetailTab}`;
  const href = context.companyPrefix
    ? `/${context.companyPrefix}/projects/${context.entityId}?tab=${encodeURIComponent(tab)}`
    : `/projects/${context.entityId}?tab=${encodeURIComponent(tab)}`;

  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "4px 8px",
        textDecoration: "none",
        color: "inherit",
        borderRadius: 4,
      }}
    >
      <span style={{ fontSize: 13 }}>Linear</span>
      <span style={s.pill(link ? "ok" : "neutral")}>
        {link
          ? link.linearProjectName ?? link.linearTeamName
          : "Configure"}
      </span>
    </a>
  );
}
