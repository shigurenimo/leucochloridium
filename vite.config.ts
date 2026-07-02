import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./lib", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        inline: ["@interactive-inc/claude-funnel"],
      },
    },
  },
  fmt: {
    semi: false,
  },
  lint: {
    ignorePatterns: [
      "node_modules/**",
      "lib/**/*.test.ts",
      "lib/**/*.test.tsx",
      "lib/**/*.bun-test.ts",
    ],
  },
})
