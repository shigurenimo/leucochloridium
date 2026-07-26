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
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 70,
        branches: 57,
        functions: 67,
        lines: 74,
      },
    },
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
