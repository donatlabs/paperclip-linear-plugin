import { useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";
import type { LinearProjectLink, RecentActivityEntry } from "../types.js";
import { formatTimestamp } from "./format.js";
import * as s from "./styles.js";

interface ViewerInfo {
  id: string;
  name: string;
  email: string;
  organization: { name: string };
}

interface SyncHealth {
  configured: boolean;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastWebhookAt: string | null;
  linkedIssueCount: number;
  importLabelName: string;
}

interface LinearTeamRow {
  id: string;
  key: string;
  name: string;
}

interface LinearProjectRow {
  id: string;
  name: string;
  description: string | null;
  state: string | null;
  url: string;
  teams: LinearTeamRow[];
}

interface ProjectLinkRow {
  paperclipProjectId: string;
  paperclipProjectName: string;
  companyId: string;
  companyName: string;
  link: LinearProjectLink | null;
}

/**
 * Company-context Linear page mounted at `/<companyPrefix>/linear`.
 *
 * This is the day-to-day operations page: connection status, project linking,
 * sync controls, and recent activity. Plugin instance config (API key,
 * webhook secret, label name) is set on the host's auto-rendered settings
 * form at `/settings/plugins/paperclip.linear` — the bridge does not expose
 * a write-config affordance to plugin UIs.
 */
export function LinearPage(_props: PluginPageProps) {
  const testConnection = usePluginAction(ACTION_KEYS.testConnection);
  const fullSync = usePluginAction(ACTION_KEYS.fullSync);
  const refreshLinear = usePluginAction(ACTION_KEYS.refreshLinearProjects);
  const linkProject = usePluginAction(ACTION_KEYS.linkProject);
  const unlinkProject = usePluginAction(ACTION_KEYS.unlinkProject);

  const health = usePluginData<SyncHealth>(DATA_KEYS.syncHealth, {});
  const linearProjectsQuery = usePluginData<{ projects: LinearProjectRow[] }>(
    DATA_KEYS.linearProjects,
    {},
  );
  const linearTeamsQuery = usePluginData<{ teams: { id: string; key: string; name: string }[] }>(
    DATA_KEYS.linearTeams,
    {},
  );
  const projectLinksQuery = usePluginData<{ rows: ProjectLinkRow[] }>(
    DATA_KEYS.projectLinks,
    {},
  );
  const activityQuery = usePluginData<{ entries: RecentActivityEntry[] }>(
    DATA_KEYS.recentActivity,
    {},
  );

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
    viewer?: ViewerInfo;
  } | null>(null);

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 960 }}>
      <header style={s.row}>
        <div>
          <h1 style={{ ...s.heading, fontSize: 22 }}>Linear sync</h1>
          <div style={s.subtle}>
            Connection + project linking. Edit the API key, webhook secret, and
            import label on the{" "}
            <a href="/settings/plugins/paperclip.linear">plugin settings page</a>.
          </div>
        </div>
        <span style={s.pill(health.data?.configured ? "ok" : "warning")}>
          {health.data?.configured ? "Connected" : "API key missing"}
        </span>
      </header>

      {/* Connection check */}
      <section style={s.card}>
        <strong style={s.heading}>1. Connection</strong>
        {!health.data?.configured ? (
          <div style={s.subtle}>
            <p>
              Set <code style={s.code}>apiKey</code> on the{" "}
              <a href="/settings/plugins/paperclip.linear">settings page</a>{" "}
              first (Linear → avatar → Settings → API → Personal API keys), then
              come back and click below.
            </p>
          </div>
        ) : null}
        <div style={s.row}>
          <button
            type="button"
            style={s.button}
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              try {
                const result = (await testConnection({})) as {
                  ok: boolean;
                  error?: string;
                  viewer?: ViewerInfo;
                };
                setTestResult(result);
                health.refresh();
              } catch (error) {
                setTestResult({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? "Testing…" : "Test Connection"}
          </button>
          {testResult ? (
            <span style={s.pill(testResult.ok ? "ok" : "error")}>
              {testResult.ok
                ? `OK — ${testResult.viewer?.organization.name ?? "Linear"} as ${testResult.viewer?.email ?? ""}`
                : `Failed: ${testResult.error ?? "unknown error"}`}
            </span>
          ) : null}
        </div>
      </section>

      {/* Pull Linear projects */}
      <section style={s.card}>
        <strong style={s.heading}>2. Pull Linear teams &amp; projects</strong>
        <div style={s.subtle}>
          Run this once after connecting (and any time you create new projects in
          Linear). Cached results power the dropdown below.
        </div>
        <div style={s.row}>
          <button
            type="button"
            style={s.button}
            disabled={!health.data?.configured}
            onClick={async () => {
              await refreshLinear({});
              linearTeamsQuery.refresh();
              linearProjectsQuery.refresh();
              projectLinksQuery.refresh();
              health.refresh();
            }}
          >
            Refresh Linear data
          </button>
          <span style={s.subtle}>
            {linearTeamsQuery.data?.teams.length ?? 0} teams ·{" "}
            {linearProjectsQuery.data?.projects.length ?? 0} projects
          </span>
        </div>
      </section>

      {/* Project linking */}
      <section style={s.card}>
        <strong style={s.heading}>3. Link Tandem projects ↔ Linear projects</strong>
        <div style={s.subtle}>
          Pick a Linear project for each Tandem project you want to sync. New
          Tandem issues in a linked project push to Linear; Linear issues
          with the{" "}
          <code style={s.code}>{health.data?.importLabelName ?? "paperclip"}</code>{" "}
          label are imported back so agents can pick them up.
        </div>
        {projectLinksQuery.loading ? (
          <div>Loading projects…</div>
        ) : projectLinksQuery.data && projectLinksQuery.data.rows.length > 0 ? (
          <ProjectLinkTable
            rows={projectLinksQuery.data.rows}
            linearTeams={linearTeamsQuery.data?.teams ?? []}
            linearProjects={linearProjectsQuery.data?.projects ?? []}
            onLink={async (paperclipProjectId, linearTeamId, linearProjectId) => {
              await linkProject({
                paperclipProjectId,
                linearTeamId,
                ...(linearProjectId ? { linearProjectId } : {}),
              });
              projectLinksQuery.refresh();
            }}
            onUnlink={async (paperclipProjectId) => {
              await unlinkProject({ paperclipProjectId });
              projectLinksQuery.refresh();
            }}
          />
        ) : (
          <div style={s.subtle}>
            No Tandem projects found yet. Create one in Tandem and return
            here.
          </div>
        )}
      </section>

      {/* Sync status */}
      <section style={s.card}>
        <strong style={s.heading}>Sync status</strong>
        {health.data ? (
          <ul style={s.list}>
            <li style={s.row}>
              <span style={s.subtle}>Linked issues</span>
              <strong>{health.data.linkedIssueCount}</strong>
            </li>
            <li style={s.row}>
              <span style={s.subtle}>Last full sync</span>
              <span>{formatTimestamp(health.data.lastFullSyncAt)}</span>
            </li>
            <li style={s.row}>
              <span style={s.subtle}>Last incremental sync</span>
              <span>{formatTimestamp(health.data.lastIncrementalSyncAt)}</span>
            </li>
            <li style={s.row}>
              <span style={s.subtle}>Last webhook</span>
              <span>{formatTimestamp(health.data.lastWebhookAt)}</span>
            </li>
          </ul>
        ) : null}
        <div style={s.row}>
          <button
            type="button"
            style={s.button}
            disabled={!health.data?.configured}
            onClick={async () => {
              await fullSync({});
              health.refresh();
              linearProjectsQuery.refresh();
            }}
          >
            Run full sync now
          </button>
        </div>
      </section>

      {/* Recent activity */}
      <section style={s.card}>
        <strong style={s.heading}>Recent activity</strong>
        {activityQuery.data && activityQuery.data.entries.length > 0 ? (
          <ul style={s.list}>
            {activityQuery.data.entries.map((entry) => (
              <li key={entry.id} style={{ ...s.row, alignItems: "flex-start" }}>
                <span style={s.pill(toneFor(entry.level))}>{entry.source}</span>
                <span style={{ flex: 1 }}>{entry.message}</span>
                <span style={s.subtle}>{formatTimestamp(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={s.subtle}>No recent activity.</div>
        )}
      </section>

      <section style={s.card}>
        <strong style={s.heading}>Linear webhook URL</strong>
        <div style={s.subtle}>
          Configure this URL in Linear → Settings → API → Webhooks (subscribe to
          Issue events). Set a signing secret and paste it into{" "}
          <code style={s.code}>webhookSecret</code> on the settings page.
        </div>
        <code style={s.code}>/api/plugins/paperclip.linear/webhooks/linear</code>
      </section>
    </div>
  );
}

function toneFor(level: RecentActivityEntry["level"]): "ok" | "warning" | "error" | "neutral" {
  if (level === "info") return "ok";
  if (level === "warning") return "warning";
  if (level === "error") return "error";
  return "neutral";
}

interface ProjectLinkTableProps {
  rows: ProjectLinkRow[];
  linearTeams: { id: string; key: string; name: string }[];
  linearProjects: LinearProjectRow[];
  onLink: (
    paperclipProjectId: string,
    linearTeamId: string,
    linearProjectId: string | null,
  ) => Promise<void>;
  onUnlink: (paperclipProjectId: string) => Promise<void>;
}

function ProjectLinkTable({
  rows,
  linearTeams,
  linearProjects,
  onLink,
  onUnlink,
}: ProjectLinkTableProps) {
  // Per-row draft selections for team + project (project may be empty string).
  const [drafts, setDrafts] = useState<
    Record<string, { teamId?: string; projectId?: string }>
  >({});
  const [busy, setBusy] = useState<string | null>(null);

  const groupedByCompany = useMemo(() => {
    const map = new Map<string, { companyName: string; rows: ProjectLinkRow[] }>();
    for (const row of rows) {
      const entry = map.get(row.companyId) ?? { companyName: row.companyName, rows: [] };
      entry.rows.push(row);
      map.set(row.companyId, entry);
    }
    return [...map.values()];
  }, [rows]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {groupedByCompany.map((group) => (
        <div key={group.companyName} style={{ display: "grid", gap: 8 }}>
          <strong style={{ fontSize: 13, color: "rgba(0,0,0,0.65)" }}>
            {group.companyName}
          </strong>
          <div style={{ display: "grid", gap: 8 }}>
            {group.rows.map((row) => {
              const draft = drafts[row.paperclipProjectId] ?? {};
              const teamId = draft.teamId ?? row.link?.linearTeamId ?? "";
              const projectId = draft.projectId ?? row.link?.linearProjectId ?? "";
              const projectsForTeam = teamId
                ? linearProjects.filter((p) =>
                    p.teams.some((t) => t.id === teamId),
                  )
                : [];
              const isBusy = busy === row.paperclipProjectId;

              return (
                <div
                  key={row.paperclipProjectId}
                  style={{ ...s.card, padding: 12, gap: 8 }}
                >
                  <div style={s.row}>
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {row.paperclipProjectName}
                      </div>
                      {row.link ? (
                        <div style={s.subtle}>
                          Linked to{" "}
                          <strong>
                            {row.link.linearProjectName ?? "(team only)"}
                          </strong>{" "}
                          on team <strong>{row.link.linearTeamName}</strong>
                        </div>
                      ) : (
                        <div style={s.subtle}>Not linked</div>
                      )}
                    </div>
                    <span style={s.pill(row.link ? "ok" : "neutral")}>
                      {row.link ? "Linked" : "Unlinked"}
                    </span>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr auto",
                      gap: 8,
                      alignItems: "end",
                    }}
                  >
                    <label style={{ display: "grid", gap: 4 }}>
                      <span style={s.subtle}>Team</span>
                      <select
                        value={teamId}
                        onChange={(event) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [row.paperclipProjectId]: {
                              teamId: event.target.value,
                              projectId: "",
                            },
                          }))
                        }
                        disabled={linearTeams.length === 0}
                        style={{ padding: "6px 8px", fontSize: 13 }}
                      >
                        <option value="">— team —</option>
                        {linearTeams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name} ({team.key})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label style={{ display: "grid", gap: 4 }}>
                      <span style={s.subtle}>Project (optional)</span>
                      <select
                        value={projectId}
                        onChange={(event) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [row.paperclipProjectId]: {
                              teamId,
                              projectId: event.target.value,
                            },
                          }))
                        }
                        disabled={!teamId}
                        style={{ padding: "6px 8px", fontSize: 13 }}
                      >
                        <option value="">
                          {teamId
                            ? projectsForTeam.length === 0
                              ? "(no projects in team)"
                              : "(team only)"
                            : "(pick team first)"}
                        </option>
                        {projectsForTeam.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        style={s.button}
                        disabled={isBusy || !teamId}
                        onClick={async () => {
                          if (!teamId) return;
                          setBusy(row.paperclipProjectId);
                          try {
                            await onLink(
                              row.paperclipProjectId,
                              teamId,
                              projectId || null,
                            );
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        {row.link ? "Update" : "Link"}
                      </button>
                      {row.link ? (
                        <button
                          type="button"
                          style={s.button}
                          disabled={isBusy}
                          onClick={async () => {
                            setBusy(row.paperclipProjectId);
                            try {
                              await onUnlink(row.paperclipProjectId);
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          Unlink
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {linearTeams.length === 0 ? (
        <div style={s.subtle}>
          No Linear teams cached yet — click <em>Refresh Linear data</em> above.
        </div>
      ) : null}
    </div>
  );
}
