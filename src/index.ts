/**
 * Package marker entry — `paperclipPlugin` keys in package.json point at the
 * compiled `dist/manifest.js`, `dist/worker.js`, and `dist/ui/`. Re-exporting
 * the manifest here lets test code and tooling import it without needing to
 * know the build paths.
 */
export { default as manifest } from "./manifest.js";
