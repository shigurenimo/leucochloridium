import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

const declarationsRoot = resolve(import.meta.dir, "../dist/types")

function declarationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? declarationFiles(path) : path.endsWith(".d.ts") ? [path] : []
  })
}

function relativeDeclarationImport(declarationPath: string, aliasPath: string): string {
  const target = join(declarationsRoot, aliasPath)
  const relativePath = relative(dirname(declarationPath), target).split(sep).join("/")
  const specifier = relativePath.startsWith(".") ? relativePath : `./${relativePath}`
  return `${specifier}.js`
}

for (const declarationPath of declarationFiles(declarationsRoot)) {
  const source = readFileSync(declarationPath, "utf8")
  const rewritten = source.replace(
    /(["'])@\/([^"']+)\1/g,
    (_match, quote: string, aliasPath: string) =>
      `${quote}${relativeDeclarationImport(declarationPath, aliasPath)}${quote}`,
  )

  if (rewritten !== source) writeFileSync(declarationPath, rewritten)
}
