/**
 * Bundles the plugin UI entry into a single browser-loadable ESM file.
 *
 * The Paperclip host serves `react`, `react/jsx-runtime`, and
 * `@paperclipai/plugin-sdk/ui` itself, so those are externalized here. All
 * relative imports inside `src/ui/` (other components, styles, constants,
 * types) are inlined so the browser does not have to follow a graph of
 * unbundled ESM files.
 *
 * Output: `dist/ui/index.js` — overwrites the file that `tsc` emits. Each
 * exported component (DashboardWidget, IssueDetailTab, Page, ProjectDetailTab,
 * ProjectSidebarItem) remains named-exported so the host can `bundle[exportName]`
 * each slot's `exportName` from the manifest.
 */

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `tsc` already emitted dist/ui/* — wipe it before esbuild rewrites the entry.
// The other dist files (worker.js, manifest.js, constants.js, types.js,
// linear-client.js) are still produced by tsc and consumed by the worker.
const uiDist = resolve(__dirname, "dist/ui");
rmSync(uiDist, { recursive: true, force: true });

await build({
  entryPoints: [resolve(__dirname, "src/ui/index.tsx")],
  outfile: resolve(__dirname, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  minify: false,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
    "@paperclipai/plugin-sdk/ui/hooks",
  ],
  logLevel: "info",
});
