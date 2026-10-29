import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

const workspace = realpathSync(mkdtempSync("/tmp/leuco-link-"))
const repository = resolve(import.meta.dir, "..")
const bin = join(workspace, "bin")
const install = join(workspace, "install")
mkdirSync(bin)
const config = join(workspace, "bunfig.toml")
writeFileSync(
  config,
  `[install]\nglobalDir = ${JSON.stringify(install)}\nglobalBinDir = ${JSON.stringify(bin)}\n`,
)
const env = {
  ...process.env,
  BUN_INSTALL: workspace,
  BUN_INSTALL_GLOBAL_DIR: install,
  BUN_INSTALL_BIN: bin,
  PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
}
try {
  const register = Bun.spawnSync([process.execPath, "link", `--config=${config}`], {
    cwd: repository,
    env,
  })
  assert.equal(register.exitCode, 0, register.stderr.toString())
  const executable = join(bin, "leuco")
  assert.ok(existsSync(executable), "bun link did not expose the CLI binary")
  assert.equal(
    realpathSync(executable),
    realpathSync(join(repository, "lib/index.ts")),
    readlinkSync(executable),
  )
  const help = Bun.spawnSync([executable, "slack", "login", "--help", "--json"], {
    cwd: workspace,
    env,
  })
  assert.equal(help.exitCode, 0, help.stderr.toString())
  const specification = JSON.parse(help.stdout.toString())
  assert.equal(specification.commands[0].name, "slack login")
  assert.equal(specification.commands[0].options.length, 0)
  assert.deepEqual(specification.commands[0].arguments[0].choices, ["bot", "app"])
  assert.ok(specification.commands[0].description.includes("clipboard"))
  console.log(
    "Linked CLI passed: isolated bun link exposes current source as leuco without touching the user's global installation",
  )
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
