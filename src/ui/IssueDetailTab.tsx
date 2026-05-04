import { useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";
import type { LinearIssueLink } from "../types.js";
import { formatTimestamp } from "./format.js";
import * as s from "./styles.js";

export function LinearIssueDetailTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<{ link: LinearIssueLink | null }>(
    DATA_KEYS.issueLink,
    { issueId },
  );
  const linkAction = usePluginAction(ACTION_KEYS.linkIssue);
  const unlinkAction = usePluginAction(ACTION_KEYS.unlinkIssue);
  const pushAction = usePluginAction(ACTION_KEYS.pushIssue);
  const [linearIdInput, setLinearIdInput] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) return <section style={s.card}>Loading…</section>;
  if (error) return <section style={s.card}>Bridge error: {error.message}</section>;

  const link = data?.link ?? null;

  return (
    <section style={s.card} aria-label="Linear linkage">
      <div style={s.row}>
        <strong style={s.heading}>Linear</strong>
        <span style={s.pill(link ? "ok" : "neutral")}>
          {link ? `Linked → ${link.linearIdentifier}` : "Not linked"}
        </span>
      </div>

      {link ? (
        <>
          <div style={s.row}>
            <span style={s.subtle}>Linear URL</span>
            <a href={link.linearUrl} target="_blank" rel="noreferrer">
              {link.linearUrl}
            </a>
          </div>
          <div style={s.row}>
            <span style={s.subtle}>Pushed</span>
            <span>{formatTimestamp(link.pushedAt)}</span>
          </div>
          <div style={s.row}>
            <span style={s.subtle}>Last synced</span>
            <span>{formatTimestamp(link.lastSyncedAt)}</span>
          </div>
          <button
            type="button"
            style={s.button}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await unlinkAction({ issueId });
                refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            Unlink
          </button>
        </>
      ) : (
        <>
          <div style={s.subtle}>
            Push this issue to Linear, or link an existing Linear issue by ID.
          </div>
          <div style={s.row}>
            <button
              type="button"
              style={s.button}
              disabled={busy || !context.companyId}
              onClick={async () => {
                if (!context.companyId) return;
                setBusy(true);
                try {
                  await pushAction({ issueId, companyId: context.companyId });
                  refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Push to Linear
            </button>
          </div>
          <div style={s.row}>
            <input
              type="text"
              placeholder="Linear issue UUID"
              value={linearIdInput}
              onChange={(event) => setLinearIdInput(event.target.value)}
              style={{ flex: 1, padding: "6px 8px", fontSize: 13 }}
            />
            <button
              type="button"
              style={s.button}
              disabled={busy || !linearIdInput}
              onClick={async () => {
                setBusy(true);
                try {
                  await linkAction({ issueId, linearIssueId: linearIdInput });
                  setLinearIdInput("");
                  refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Link
            </button>
          </div>
        </>
      )}
    </section>
  );
}
