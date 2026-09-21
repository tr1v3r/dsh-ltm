import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  dts: true,
  target: "node22.19.0",
  platform: "node",
});
