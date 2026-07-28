import { HTTPException } from "hono/http-exception"
import { randomUUID } from "node:crypto"
import { assertRoutableName } from "@/cli/utils/assert-routable-name"
import { factory, type CliContext } from "@/cli/cli-factory"
import { resolveProject } from "@/cli/utils/lookup-config"
import { type CliBody, flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { resolveTokenFlag } from "@/cli/utils/resolve-token-flag"
import { slackAppTokenSchema, slackBotTokenSchema } from "@/connectors/slack/slack-schemas"
import type { ConnectorConfig } from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco projects <p> connectors add / register a connector

usage / leuco projects <p> connectors add (slack|schedule) [options]

options:
  --name <name> / connector identifier (default: <type>)
  --bot-token <token | -> / [slack] bot/user OAuth token (xoxb- or xoxp-). \`-\` reads from stdin.
  --app-token <token | -> / [slack] app-level token (xapp-...). \`-\` reads from stdin.

examples:
  leuco projects demo connectors add slack --bot-token xoxb-... --app-token xapp-...
  leuco projects demo connectors add schedule`

export const connectorsAddHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const projectName = c.req.param("project")!
  const type = body.args[0]

  if (type !== "slack" && type !== "schedule") {
    throw new HTTPException(400, {
      message: `usage: leuco projects ${projectName} connectors add (slack|schedule) [...]\n  unsupported type: ${type ?? "(missing)"}`,
    })
  }

  if (type === "slack") return addSlackConnector(c, body, projectName)
  return addScheduleConnector(c, body, projectName)
})

const addSlackConnector = async (c: CliContext, body: CliBody, projectName: string) => {
  if (body.flags["bot-token"] === "-" && body.flags["app-token"] === "-") {
    throw new HTTPException(400, {
      message: "only one of --bot-token / --app-token can read from stdin",
    })
  }

  // Validate before saving: readSettings() re-parses names against safeName
  // on every load, so persisting an invalid name would brick every command.
  const connectorName = assertRoutableName(
    typeof body.flags.name === "string" ? body.flags.name : "slack",
    "connector name",
  )
  const botToken = (await resolveTokenFlag(body.flags["bot-token"])) ?? ""
  const appToken = (await resolveTokenFlag(body.flags["app-token"])) ?? ""
  validateSlackTokens({ botToken, appToken })

  const store = new LeucoProjectStore({ paths: new LeucoPaths() })
  const project = resolveProject(c, store, projectName)

  if (project.connectors.some((ch) => ch.name === connectorName)) {
    throw new HTTPException(400, {
      message: `leuco: connector already exists in ${projectName}: ${connectorName}`,
    })
  }

  const connectorId = randomUUID()
  const next: ConnectorConfig = {
    id: connectorId,
    name: connectorName,
    type: "slack",
    enabled: true,
    botToken,
    appToken,
    ackMode: "mention",
    ackIcons: {
      progress: "hourglass_flowing_sand",
      success: "white_check_mark",
      error: "x",
    },
  }

  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    connectors: [...fresh.connectors, next],
  }))
  const saved = store.getPaths().settingsPath()

  const tail =
    botToken.length > 0 && appToken.length > 0
      ? "tokens recorded; run `leuco run` to start."
      : `edit ${saved} (or run \`leuco projects ${projectName} connectors ${connectorName} set-tokens\`) to fill in any missing tokens.`

  return c.text(`added connector "${connectorName}" (slack, id: ${connectorId})\n${tail}`)
}

const validateSlackTokens = (input: { botToken: string; appToken: string }): void => {
  if (input.botToken.length > 0) {
    const parsed = slackBotTokenSchema.safeParse(input.botToken)
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `--bot-token ${parsed.error.issues[0]?.message}`,
      })
    }
  }
  if (input.appToken.length > 0) {
    const parsed = slackAppTokenSchema.safeParse(input.appToken)
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `--app-token ${parsed.error.issues[0]?.message}`,
      })
    }
  }
}

const addScheduleConnector = async (c: CliContext, body: CliBody, projectName: string) => {
  const connectorName = assertRoutableName(
    typeof body.flags.name === "string" ? body.flags.name : "schedule",
    "connector name",
  )

  const store = new LeucoProjectStore({ paths: new LeucoPaths() })
  const project = resolveProject(c, store, projectName)

  if (project.connectors.some((ch) => ch.name === connectorName)) {
    throw new HTTPException(400, {
      message: `leuco: connector already exists in ${projectName}: ${connectorName}`,
    })
  }

  const connectorId = randomUUID()
  const next: ConnectorConfig = {
    id: connectorId,
    name: connectorName,
    type: "schedule",
    enabled: true,
    entries: [],
  }

  store.updateProject(project.id, (fresh) => ({
    ...fresh,
    connectors: [...fresh.connectors, next],
  }))

  return c.text(
    `added connector "${connectorName}" (schedule, id: ${connectorId})\nadd entries with \`leuco projects ${projectName} connectors ${connectorName} schedules add\`.`,
  )
}
