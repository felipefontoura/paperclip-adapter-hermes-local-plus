import { defineConfig } from "tsup";

// 3 entries map to the `exports` block in package.json:
//   .          → dist/index.js          (root + createServerAdapter)
//   ./server   → dist/server/index.js   (execute, testEnvironment, etc.)
//   ./ui       → dist/ui/index.js       (parseHermesStdoutLine, buildHermesConfig)
//
// The Paperclip server loads us via plain `import()` of the entry-point and
// trusts Node's resolution. Paperclip ships `@paperclipai/adapter-utils`
// via pnpm's nested `.pnpm/` store (not at the top-level `node_modules/`),
// so plain Node resolution from our extracted tarball directory can't
// reach it. We bundle every `@paperclipai/*` dependency inline so the
// plugin self-installs cleanly inside any Paperclip release.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "server/index": "src/server/index.ts",
    "ui/index": "src/ui/index.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  noExternal: [/^@paperclipai\//, "js-yaml"],
});
