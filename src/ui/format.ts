/** Format an ISO timestamp to a short relative-or-absolute string for UI display. */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  const diffMs = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.round(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.round(diffMs / hour)}h ago`;
  return date.toLocaleString();
}
