import { HTTPException } from "hono/http-exception"
import { randomUUID } from "node:crypto"
import { validateRunAt } from "@/connectors/schedule/validate-run-at"
import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/projects.$project.connectors.$connector.schedules.help"
import { findConnector, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import type { ScheduleEntry } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

export const schedulesAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const connectorName = c.req.param("connector")!

  const name = flagString(body.flags.name) ?? body.args[0] ?? null
  const runAt = flagString(body.flags["run-at"]) ?? body.args[1] ?? null
  const prompt = flagString(body.flags.prompt) ?? body.args[2] ?? null

  if (name === null || runAt === null || prompt === null) {
    throw new HTTPException(400, {
      message:
        "leuco: --name, --run-at, --prompt are required\n" +
        "usage: leuco projects <p> connectors <c> schedules add --name <n> --run-at <expr> --prompt <text>",
    })
  }
  if (name.length > 200) {
    throw new HTTPException(400, { message: "schedule entry name must be at most 200 characters" })
  }
  if (runAt.length > 200) {
    throw new HTTPException(400, { message: "--run-at must be at most 200 characters" })
  }
  if (prompt.length > 10_000) {
    throw new HTTPException(400, { message: "--prompt must be at most 10000 characters" })
  }

  const validatedName = validateLeucoName(name, "schedule entry name")

  const validatedRunAt = validateRunAt(runAt)

  const store = new LeucoProjectStore()
  const project = resolveProject(c, store, projectName)

  const connector = findConnector(project, connectorName)

  if (connector.type !== "schedule") {
    throw new HTTPException(400, {
      message: `connector "${connectorName}" is not a schedule connector`,
    })
  }

  const entry: ScheduleEntry = {
    id: randomUUID(),
    name: validatedName,
    runAt: validatedRunAt,
    prompt,
    enabled: true,
  }

  store.addScheduleEntry({
    projectId: project.id,
    connectorName,
    entry,
  })

  return c.text(`added schedule entry "${entry.name}" (id: ${entry.id})`)
})
