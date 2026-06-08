import { HTTPException } from "hono/http-exception"
import { randomUUID } from "node:crypto"
import { validateRunAt } from "@/channels/schedule/validate-run-at"
import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.schedules.help"
import { findAgent, findChannel, resolveProject } from "@/cli/utils/lookup-config"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"
import { validateLeucoName } from "@/cli/utils/validate-name"
import type { ScheduleEntry } from "@/config/config-schema"
import { LeucoProjectStore } from "@/projects/project-store"

export const schedulesAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const agentName = c.req.param("agent")!
  const channelName = c.req.param("channel")!

  const name = flagString(body.flags.name) ?? body.args[0] ?? null
  const runAt = flagString(body.flags["run-at"]) ?? body.args[1] ?? null
  const prompt = flagString(body.flags.prompt) ?? body.args[2] ?? null

  if (name === null || runAt === null || prompt === null) {
    throw new HTTPException(400, {
      message:
        "leuco: --name, --run-at, --prompt are required\n" +
        "usage: leuco projects <p> agents <a> channels <c> schedules add --name <n> --run-at <expr> --prompt <text>",
    })
  }

  const validatedName = validateLeucoName(name, "schedule entry name")

  const validatedRunAt = validateRunAt(runAt)

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })

  const agent = findAgent(project, agentName)

  const channel = findChannel(agent, projectName, channelName)

  if (channel.type !== "schedule") {
    throw new HTTPException(400, { message: `channel ${channelName} is not a schedule channel` })
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
    agentName,
    channelName,
    entry,
  })

  return c.text(
    `added schedule entry ${projectName}/${agentName}/${channelName}/${entry.name} (id=${entry.id})`,
  )
})
