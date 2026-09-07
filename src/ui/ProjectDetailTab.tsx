import { useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";
import type { LinearProjectLink } from "../types.js";
import { formatTimestamp } from "./format.js";
import * as s from "./styles.js";

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

interface SyncHealth {
  configured: boolean;
  importLabelName: string;
}

/**
 * Per-project Linear link config. Mounted on every Paperclip project detail
 * page as a "Linear" tab and reachable from the project sidebar item.
 *
 * The form is always rendered. A banner at the top calls out connection /
 * cache state. We auto-refresh Linear teams + projects on first mount once
 * the worker reports it is configured, so the user does not have to remember
 * to click "Refresh Linear data" before they can pick a destination.
 */
export function LinearProjectDetailTab({ context }: PluginDetailTabProps) {
  const projectId = context.entityId;

  const linkQuery = usePluginData<{ link: LinearProjectLink | null }>(
    DATA_KEYS.projectLink,
    { projectId },
  );
  const linearTeamsQuery = usePluginData<{ teams: LinearTeamRow[] }>(
    DATA_KEYS.linearTeams,
    {},
  );
  const linearProjectsQuery = usePluginData<{ projects: LinearProjectRow[] }>(
    DATA_KEYS.linearProjects,
    {},
  );
  const health = usePluginData<SyncHealth>(DATA_KEYS.syncHealth, {});

  const linkProject = usePluginAction(ACTION_KEYS.linkProject);
  const unlinkProject = usePluginAction(ACTION_KEYS.unlinkProject);
  const refreshLinear = usePluginAction(ACTION_KEYS.refreshLinearProjects);
  const backfill = usePluginAction(ACTION_KEYS.backfillProject);

  const [draftTeamId, setDraftTeamId] = useState<string>("");
  const [draftProjectId, setDraftProjectId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [autoRefreshed, setAutoRefreshed] = useState<boolean>(false);

  const link = linkQuery.data?.link ?? null;
  const teams = linearTeamsQuery.data?.teams ?? [];
  const projects = linearProjectsQuery.data?.projects ?? [];
  const configured = health.data?.configured ?? false;
  const importLabelName = health.data?.importLabelName ?? "paperclip";

  // Auto-refresh once: as soon as we know the worker is configured AND the
  // local cache is empty, kick off a refresh. Prevents the "empty dropdown"
  // pitfall where the user has to know to click Refresh first.
  useEffect(() => {
    if (autoRefreshed) return;
    if (!configured) return;
    if (teams.length > 0 || projects.length > 0) return;
    setAutoRefreshed(true);
    void (async () => {
      try {
        await refreshLinear({});
        linearTeamsQuery.refresh();
        linearProjectsQuery.refresh();
      } catch {
        // surfaced via banner below; no need to throw
      }
    })();
  }, [
    autoRefreshed,
    configured,
    teams.length,
    projects.length,
    refreshLinear,
    linearTeamsQuery,
    linearProjectsQuery,
  ]);

  const effectiveTeamId = draftTeamId || link?.linearTeamId || "";
  const effectiveProjectId = draftProjectId || link?.linearProjectId || "";

  const projectsForTeam = useMemo(() => {
    if (!effectiveTeamId) return [];
    return projects.filter((project) =>
      project.teams.some((team) => team.id === effectiveTeamId),
    );
  }, [projects, effectiveTeamId]);

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      {!configured ? (
        <section
          style={{ ...s.card, borderColor: "rgba(217, 119, 6, 0.4)" }}
          aria-label="Linear not connected"
        >
          <strong style={s.heading}>Linear is not connected yet</strong>
          <div style={s.subtle}>
            Paste your Linear API key on the{" "}
            <a href="/settings/plugins/paperclip.linear">plugin settings page</a>,
            then return to this tab. The form below will activate once the
            worker confirms the key.
          </div>
        </section>
      ) : null}

      <section style={s.card}>
        <div style={s.row}>
          <strong style={s.heading}>Linear link</strong>
          <span style={s.pill(link ? "ok" : "neutral")}>
            {link
              ? `Linked → ${link.linearProjectName ?? link.linearTeamName}`
              : "Not linked"}
          </span>
        </div>

        {link ? (
          <ul style={s.list}>
            <li style={s.row}>
              <span style={s.subtle}>Linear team</span>
              <strong>{link.linearTeamName}</strong>
            </li>
            <li style={s.row}>
              <span style={s.subtle}>Linear project</span>
              <strong>{link.linearProjectName ?? "(team only)"}</strong>
            </li>
            <li style={s.row}>
              <span style={s.subtle}>Linked at</span>
              <span>{formatTimestamp(link.linkedAt)}</span>
            </li>
          </ul>
        ) : (
          <div style={s.subtle}>
            New issues created in this Tandem project will be pushed to Linear
            once you link a Linear team (and optionally a Linear project) below.
            Linear issues that carry the{" "}
            <code style={s.code}>{importLabelName}</code> label and live in the
            linked Linear project will be imported back here.
          </div>
        )}
      </section>

      <section style={s.card}>
        <strong style={s.heading}>Pick a Linear destination</strong>

        <div style={{ display: "grid", gap: 8 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={s.subtle}>Linear team (required)</span>
            <select
              value={effectiveTeamId}
              onChange={(event) => {
                setDraftTeamId(event.target.value);
                setDraftProjectId("");
              }}
              disabled={!configured || teams.length === 0}
              style={{ padding: "6px 8px", fontSize: 13 }}
            >
              <option value="">
                {!configured
                  ? "(connect Linear first)"
                  : teams.length === 0
                    ? "(no teams cached — click Refresh)"
                    : "— select Linear team —"}
              </option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name} ({team.key})
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={s.subtle}>Linear project (optional)</span>
            <select
              value={effectiveProjectId}
              onChange={(event) => setDraftProjectId(event.target.value)}
              disabled={!configured || !effectiveTeamId}
              style={{ padding: "6px 8px", fontSize: 13 }}
            >
              <option value="">
                {!configured
                  ? "(connect Linear first)"
                  : !effectiveTeamId
                    ? "(pick a team first)"
                    : projectsForTeam.length === 0
                      ? "(team has no projects — link to team only)"
                      : "(team only — no Linear project)"}
              </option>
              {projectsForTeam.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <div style={s.row}>
            <button
              type="button"
              style={s.button}
              disabled={busy !== null || !configured || !effectiveTeamId}
              onClick={async () => {
                if (!effectiveTeamId) return;
                setBusy("link");
                try {
                  await linkProject({
                    paperclipProjectId: projectId,
                    linearTeamId: effectiveTeamId,
                    ...(effectiveProjectId
                      ? { linearProjectId: effectiveProjectId }
                      : {}),
                  });
                  setDraftTeamId("");
                  setDraftProjectId("");
                  linkQuery.refresh();
                } finally {
                  setBusy(null);
                }
              }}
            >
              {link ? "Update link" : "Link"}
            </button>
            {link ? (
              <button
                type="button"
                style={s.button}
                disabled={busy !== null}
                onClick={async () => {
                  setBusy("unlink");
                  try {
                    await unlinkProject({ paperclipProjectId: projectId });
                    linkQuery.refresh();
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Unlink
              </button>
            ) : null}
            <button
              type="button"
              style={s.button}
              disabled={busy !== null || !configured}
              onClick={async () => {
                setBusy("refresh");
                try {
                  await refreshLinear({});
                  linearTeamsQuery.refresh();
                  linearProjectsQuery.refresh();
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === "refresh" ? "Refreshing…" : "Refresh Linear data"}
            </button>
            <span style={s.subtle}>
              {teams.length} teams · {projects.length} projects
            </span>
          </div>
        </div>
      </section>

      {link ? (
        <section style={s.card}>
          <strong style={s.heading}>Backfill existing issues</strong>
          <div style={s.subtle}>
            Pushes every existing Tandem issue in this project to Linear.
            Issues already linked are skipped — safe to run multiple times.
          </div>
          <div style={s.row}>
            <button
              type="button"
              style={s.button}
              disabled={busy !== null}
              onClick={async () => {
                setBusy("backfill");
                setBackfillResult(null);
                try {
                  const result = (await backfill({
                    paperclipProjectId: projectId,
                  })) as {
                    ok: boolean;
                    pushed: number;
                    skipped: number;
                    failed: number;
                    parentLinks?: number;
                  };
                  const parts = [
                    `${result.pushed} pushed`,
                    `${result.skipped} already linked`,
                    `${result.failed} failed`,
                  ];
                  if (typeof result.parentLinks === "number" && result.parentLinks > 0) {
                    parts.push(`${result.parentLinks} parent links`);
                  }
                  setBackfillResult(parts.join(", "));
                } catch (error) {
                  setBackfillResult(
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === "backfill" ? "Backfilling…" : "Backfill issues to Linear"}
            </button>
            {backfillResult ? <span style={s.subtle}>{backfillResult}</span> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
