import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/** 关于页展示的版本号来自发布包，构建时注入，避免在渲染层重复维护。 */
const APP_VERSION = (JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as { version?: unknown }).version;
const APP_VERSION_LITERAL = typeof APP_VERSION === "string" && APP_VERSION.trim() ? APP_VERSION.trim() : "0.0.0";

/** workspace 包：入口是 TS 源码，必须打包进产物，不能被外部化为 require()。 */
const WORKSPACE_PACKAGES = ["@boss-harness/protocol", "@boss-harness/app-client", "@boss-harness/shared"];

const aliases = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [name, resolve(__dirname, `../../packages/${name.slice("@boss-harness/".length)}/src/index.ts`)]),
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    resolve: { alias: aliases },
    // 显式指定入口，不依赖 package.json 的 main 字段推断（out/ 被清理后推断会失手）。
    build: {
      rollupOptions: { input: resolve(__dirname, "src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    resolve: { alias: aliases },
    build: {
      rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION_LITERAL) },
    resolve: { alias: aliases },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
