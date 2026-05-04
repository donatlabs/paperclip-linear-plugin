import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS, ACTION_KEYS } from "../constants.js";
import { formatTimestamp } from "./format.js";
import * as s from "./styles.js";

interface SyncHealth {
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastWebhookAt: string | null;
  linkedIssueCount: number;
  configured: boolean;
}

export function LinearDashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<SyncHealth>(DATA_KEYS.syncHealth, {});
  const fullSync = usePluginAction(ACTION_KEYS.fullSync);

  if (loading) return <section style={s.card}>Loading Linear status…</section>;
  if (error) {
    return (
      <section style={s.card}>
        <div style={s.row}>
          <strong style={s.heading}>Linear</strong>
          <span style={s.pill("error")}>Bridge error</span>
        </div>
        <div style={s.subtle}>{error.message}</div>
      </section>
    );
  }
  if (!data) return null;

  const tone = !data.configured ? "warning" : "ok";

  return (
    <section style={s.card} aria-label="Linear sync widget">
      <div style={s.row}>
        <strong style={s.heading}>Linear</strong>
        <span style={s.pill(tone)}>
          {data.configured ? "Connected" : "Not configured"}
        </span>
      </div>
      <div style={s.row}>
        <span style={s.subtle}>Linked issues</span>
        <strong>{data.linkedIssueCount}</strong>
      </div>
      <div style={s.row}>
        <span style={s.subtle}>Last full sync</span>
        <span>{formatTimestamp(data.lastFullSyncAt)}</span>
      </div>
      <div style={s.row}>
        <span style={s.subtle}>Last incremental</span>
        <span>{formatTimestamp(data.lastIncrementalSyncAt)}</span>
      </div>
      <div style={s.row}>
        <span style={s.subtle}>Last webhook</span>
        <span>{formatTimestamp(data.lastWebhookAt)}</span>
      </div>
      <button
        type="button"
        style={s.button}
        disabled={!data.configured}
        onClick={() => {
          void fullSync({});
        }}
      >
        Run full sync now
      </button>
    </section>
  );
}
