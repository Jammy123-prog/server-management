// Wrapper config: reuse the dashboard's own vite.config.ts, but pin `root` to
// the real (non-symlinked) package path and point the dependency-optimizer
// cache at a writable directory inside this project.
import { mergeConfig } from "vite";
import base from "C:/Users/zpmc/.understand-anything/repo/understand-anything-plugin/packages/dashboard/vite.config.ts";

export default mergeConfig(base, {
  root: "C:/Users/zpmc/.understand-anything/repo/understand-anything-plugin/packages/dashboard",
  cacheDir: "f:/Trace-code/server/.ua/tmp/vite-cache",
  server: { fs: { strict: false } },
});
