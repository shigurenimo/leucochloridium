import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { bootInstallHandler } from "@/cli/routes/boot.install"
import { bootStatusHandler } from "@/cli/routes/boot.status"
import { bootUninstallHandler } from "@/cli/routes/boot.uninstall"
import { configGetHandler } from "@/cli/routes/config.get"
import { configListHandler } from "@/cli/routes/config.list"
import { configSetHandler } from "@/cli/routes/config.set"
import { help as groupHelp } from "@/cli/routes/group.help"
import { logsHandler } from "@/cli/routes/logs"
import { projectsAddHandler } from "@/cli/routes/projects.add"
import { projectsCreateHandler } from "@/cli/routes/projects.create"
import { projectsListHandler } from "@/cli/routes/projects.list"
import { agentsAddHandler } from "@/cli/routes/projects.$project.agents.add"
import { agentsListHandler } from "@/cli/routes/projects.$project.agents.list"
import { help as agentsNamedHelp } from "@/cli/routes/projects.$project.agents.$agent.help"
import { channelsAddHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.add"
import { channelsListHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.list"
import { help as channelsNamedHelp } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.help"
import { channelsRemoveHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.remove"
import { agentsMoveToHandler } from "@/cli/routes/projects.$project.agents.$agent.move-to"
import { agentsRemoveHandler } from "@/cli/routes/projects.$project.agents.$agent.remove"
import { agentsRenameHandler } from "@/cli/routes/projects.$project.agents.$agent.rename"
import { agentsResetHandler } from "@/cli/routes/projects.$project.agents.$agent.reset"
import { agentsRestartHandler } from "@/cli/routes/projects.$project.agents.$agent.restart"
import { agentsStartHandler } from "@/cli/routes/projects.$project.agents.$agent.start"
import { agentsStopHandler } from "@/cli/routes/projects.$project.agents.$agent.stop"
import { channelsRenameHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.rename"
import { channelsRestartHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.restart"
import { schedulesAddHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.schedules.add"
import { schedulesListHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.schedules.list"
import { schedulesRemoveHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.schedules.remove"
import { channelsSetTokensHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.set-tokens"
import { channelsStartHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.start"
import { channelsStopHandler } from "@/cli/routes/projects.$project.agents.$agent.channels.$channel.stop"
import { help as projectsNamedHelp } from "@/cli/routes/projects.$project.help"
import { projectsRemoveHandler } from "@/cli/routes/projects.$project.remove"
import { projectsRenameHandler } from "@/cli/routes/projects.$project.rename"
import { restartHandler } from "@/cli/routes/restart"
import { rootHandler } from "@/cli/routes/root"
import { runHandler } from "@/cli/routes/run"
import { slackCallHandler } from "@/cli/routes/slack.call"
import { help as slackHelp } from "@/cli/routes/slack.help"
import { startHandler } from "@/cli/routes/start"
import { statusHandler } from "@/cli/routes/status"
import { stopHandler } from "@/cli/routes/stop"
import { tuiHandler } from "@/cli/routes/tui"
import { updateHandler } from "@/cli/routes/update"
import { groupHelpHandler } from "@/cli/utils/group-help-handler"

const base = factory.createApp()

base.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.text(`error: ${error.message}`, error.status)
  }

  return c.text(`error: ${error instanceof Error ? error.message : String(error)}`, 500)
})

base.notFound((c) => {
  const cmd = c.req.path.replace(/^\//, "").replace(/\//g, " ")
  return c.text(`unknown command: ${cmd}\n\n${groupHelp}`, 404)
})

/**
 * Top-level leuco CLI app. Each subcommand is a `POST /<cmd>` route and the
 * argv → URL/body conversion lives in `@/cli/utils/to-request`. Bare `leuco`
 * routes to `/`, which opens the TUI when the daemon is running and otherwise
 * starts it.
 *
 * Route file naming mirrors the URL: `<segments>.ts` for `/<segments>`,
 * `$<param>` in the file name stands in for `:<param>` in the URL.
 */
export const app = base
  .post("/", ...rootHandler)
  .post("/start", ...startHandler)
  .post("/stop", ...stopHandler)
  .post("/status", ...statusHandler)
  .post("/restart", ...restartHandler)
  .post("/run", ...runHandler)
  .post("/logs", ...logsHandler)
  .post("/tui", ...tuiHandler)
  .post("/update", ...updateHandler)

  // Collection URLs (`/projects`, `/projects/:p/agents`, etc) return the list
  // directly so `leuco projects` is enough to see what's registered. The
  // explicit `/list` aliases stay for backwards-compat scripts. Each leaf
  // handler honours `--help` itself so `leuco projects --help` keeps working.
  .post("/projects", ...projectsListHandler)
  .post("/projects/list", ...projectsListHandler)
  .post("/projects/create", ...projectsCreateHandler)
  .post("/projects/add", ...projectsAddHandler)
  .post("/projects/:project", ...groupHelpHandler(projectsNamedHelp))
  .post("/projects/:project/remove", ...projectsRemoveHandler)
  .post("/projects/:project/rename", ...projectsRenameHandler)

  .post("/projects/:project/agents", ...agentsListHandler)
  .post("/projects/:project/agents/list", ...agentsListHandler)
  .post("/projects/:project/agents/add", ...agentsAddHandler)
  .post("/projects/:project/agents/:agent", ...groupHelpHandler(agentsNamedHelp))
  .post("/projects/:project/agents/:agent/remove", ...agentsRemoveHandler)
  .post("/projects/:project/agents/:agent/rename", ...agentsRenameHandler)
  .post("/projects/:project/agents/:agent/move-to", ...agentsMoveToHandler)
  .post("/projects/:project/agents/:agent/start", ...agentsStartHandler)
  .post("/projects/:project/agents/:agent/stop", ...agentsStopHandler)
  .post("/projects/:project/agents/:agent/restart", ...agentsRestartHandler)
  .post("/projects/:project/agents/:agent/reset", ...agentsResetHandler)

  .post("/projects/:project/agents/:agent/channels", ...channelsListHandler)
  .post("/projects/:project/agents/:agent/channels/list", ...channelsListHandler)
  .post("/projects/:project/agents/:agent/channels/add", ...channelsAddHandler)
  .post(
    "/projects/:project/agents/:agent/channels/:channel",
    ...groupHelpHandler(channelsNamedHelp),
  )
  .post("/projects/:project/agents/:agent/channels/:channel/remove", ...channelsRemoveHandler)
  .post("/projects/:project/agents/:agent/channels/:channel/rename", ...channelsRenameHandler)
  .post("/projects/:project/agents/:agent/channels/:channel/start", ...channelsStartHandler)
  .post("/projects/:project/agents/:agent/channels/:channel/stop", ...channelsStopHandler)
  .post("/projects/:project/agents/:agent/channels/:channel/restart", ...channelsRestartHandler)
  .post(
    "/projects/:project/agents/:agent/channels/:channel/set-tokens",
    ...channelsSetTokensHandler,
  )
  .post(
    "/projects/:project/agents/:agent/channels/:channel/schedules",
    ...schedulesListHandler,
  )
  .post("/projects/:project/agents/:agent/channels/:channel/schedules/add", ...schedulesAddHandler)
  .post(
    "/projects/:project/agents/:agent/channels/:channel/schedules/list",
    ...schedulesListHandler,
  )
  .post(
    "/projects/:project/agents/:agent/channels/:channel/schedules/remove",
    ...schedulesRemoveHandler,
  )

  .post("/slack", ...groupHelpHandler(slackHelp))
  .post("/slack/call", ...slackCallHandler)

  .post("/config", ...configListHandler)
  .post("/config/list", ...configListHandler)
  .post("/config/get", ...configGetHandler)
  .post("/config/set", ...configSetHandler)

  .post("/boot", ...bootStatusHandler)
  .post("/boot/install", ...bootInstallHandler)
  .post("/boot/uninstall", ...bootUninstallHandler)
  .post("/boot/status", ...bootStatusHandler)
