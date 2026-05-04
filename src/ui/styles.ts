/**
 * Inline styles used by Linear plugin UI components.
 *
 * Plugin UI bundles cannot import from host design tokens at the moment, so we
 * keep a small set of self-contained styles here. The look stays neutral so
 * the plugin blends into whatever theme Paperclip ships.
 */

import type { CSSProperties } from "react";

export const card: CSSProperties = {
  border: "1px solid rgba(0, 0, 0, 0.1)",
  borderRadius: 8,
  padding: 16,
  background: "var(--paperclip-card-bg, #fff)",
  display: "grid",
  gap: 12,
};

export const heading: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
};

export const subtle: CSSProperties = {
  color: "rgba(0, 0, 0, 0.6)",
  fontSize: 12,
};

export const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

export const button: CSSProperties = {
  border: "1px solid rgba(0, 0, 0, 0.15)",
  borderRadius: 6,
  padding: "6px 10px",
  background: "rgba(0, 0, 0, 0.04)",
  cursor: "pointer",
  fontSize: 13,
};

export const pill = (
  tone: "ok" | "warning" | "error" | "neutral",
): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 500,
  background:
    tone === "ok"
      ? "rgba(46, 160, 67, 0.15)"
      : tone === "warning"
        ? "rgba(217, 119, 6, 0.15)"
        : tone === "error"
          ? "rgba(220, 38, 38, 0.15)"
          : "rgba(0, 0, 0, 0.08)",
  color:
    tone === "ok"
      ? "#1f6f33"
      : tone === "warning"
        ? "#92400e"
        : tone === "error"
          ? "#991b1b"
          : "rgba(0, 0, 0, 0.7)",
});

export const list: CSSProperties = {
  display: "grid",
  gap: 6,
  margin: 0,
  padding: 0,
  listStyle: "none",
};

export const code: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  fontSize: 12,
};
