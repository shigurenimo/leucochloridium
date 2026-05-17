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
    return c.text(
      "leuco: --name, --run-at, --prompt are required\n" +
        "usage: leuco projects <p> agents <a> channels <c> schedules add --name <n> --run-at <expr> --prompt <text>",
      400,
    )
  }

  const validatedName = validateLeucoName(name, "schedule entry name")
  if (validatedName instanceof Error) return c.text(`leuco: ${validatedName.message}`, 400)

  const validatedRunAt = validateRunAt(runAt)
  if (validatedRunAt instanceof Error) return c.text(`leuco: ${validatedRunAt.message}`, 400)

  const store = new LeucoProjectStore()
  const project = resolveProject(store, projectName, { preferCwd: c.var.cwd })
  if (project instanceof Error) return c.text(`leuco: ${project.message}`, 404)

  const agent = findAgent(project, agentName)
  if (agent instanceof Error) return c.text(`leuco: ${agent.message}`, 404)

  const channel = findChannel(agent, projectName, channelName)
  if (channel instanceof Error) return c.text(`leuco: ${channel.message}`, 404)

  if (channel.type !== "schedule") {
    return c.text(`leuco: channel ${channelName} is not a schedule channel`, 400)
  }

  const entry: ScheduleEntry = {
    id: randomUUID(),
    name: validatedName,
    runAt: validatedRunAt,
    prompt,
    enabled: true,
  }

  const result = store.addScheduleEntry({
    projectId: project.id,
    agentName,
    channelName,
    entry,
  })
  if (result instanceof Error) return c.text(`leuco: ${result.message}`, 400)

  return c.text(
    `added schedule entry ${projectName}/${agentName}/${channelName}/${entry.name} (id=${entry.id})`,
  )
})
