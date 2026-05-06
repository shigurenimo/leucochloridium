import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./lib", import.meta.url)),
    },
  },
  fmt: {
    semi: false,
  },
  lint: {
    ignorePatterns: ["node_modules/**", "lib/**/*.test.ts", "lib/**/*.test.tsx"],
  },
})
