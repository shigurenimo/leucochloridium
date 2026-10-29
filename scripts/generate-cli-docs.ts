import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { renderCliDocs } from "@/cli/render-cli-docs"

const path = resolve(import.meta.dir, "../CLI.md")
const generated = renderCliDocs()
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== generated)
    throw new Error("CLI.md differs from command definitions. Run bun run docs:cli.")
} else writeFileSync(path, generated)
