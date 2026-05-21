import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: true,
  external: ["ink", "react", "react/jsx-runtime", "yoga-layout"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
