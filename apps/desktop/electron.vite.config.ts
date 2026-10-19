import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/** workspace 包：入口是 TS 源码，必须打包进产物，不能被外部化为 require()。 */
const WORKSPACE_PACKAGES = ["@boss-cli/protocol", "@boss-cli/app-client", "@boss-cli/shared"];

const aliases = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [name, resolve(__dirname, `../../packages/${name.slice("@boss-cli/".length)}/src/index.ts`)]),
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
    resolve: { alias: aliases },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
