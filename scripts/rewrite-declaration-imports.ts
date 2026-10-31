import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
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

const declarations = declarationFiles(declarationsRoot)

for (const declarationPath of declarations) {
  const source = readFileSync(declarationPath, "utf8")
  const rewritten = source.replace(
    /(["'])@\/([^"']+)\1/g,
    (_match, quote: string, aliasPath: string) =>
      `${quote}${relativeDeclarationImport(declarationPath, aliasPath)}${quote}`,
  )

  if (rewritten !== source) writeFileSync(declarationPath, rewritten)
}

const retained = new Set<string>()
const pending = [join(declarationsRoot, "api.d.ts")]
while (pending.length > 0) {
  const declarationPath = pending.pop()!
  if (retained.has(declarationPath)) continue
  retained.add(declarationPath)
  const source = readFileSync(declarationPath, "utf8")
  for (const imported of source.matchAll(
    /\b(?:from\s+|import\s*\(\s*|import\s+)(["'])(\.[^"']+)\1/g,
  )) {
    const specifier = imported[2]!
    const target = resolve(
      dirname(declarationPath),
      specifier.endsWith(".js") ? specifier.replace(/\.js$/, ".d.ts") : `${specifier}.d.ts`,
    )
    if (!declarations.includes(target))
      throw new Error(`Missing public declaration dependency: ${target}`)
    pending.push(target)
  }
}
for (const declarationPath of declarations)
  if (!retained.has(declarationPath)) unlinkSync(declarationPath)
