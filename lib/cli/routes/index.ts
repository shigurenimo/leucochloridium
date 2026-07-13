import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { errorMessage } from "@/error-message"
import { bootInstallHandler } from "@/cli/routes/boot.install"
import { bootStatusHandler } from "@/cli/routes/boot.status"
import { bootUninstallHandler } from "@/cli/routes/boot.uninstall"
import { doctorHandler } from "@/cli/routes/doctor"
import { eventsHandler } from "@/cli/routes/events"
import { killHandler } from "@/cli/routes/kill"
import { configGetHandler } from "@/cli/routes/config.get"
import { configListHandler } from "@/cli/routes/config.list"
import { configSetHandler } from "@/cli/routes/config.set"
import { logsHandler } from "@/cli/routes/logs"
import { projectsAddHandler } from "@/cli/routes/projects.add"
import { projectsCreateHandler } from "@/cli/routes/projects.create"
import { projectsListHandler } from "@/cli/routes/projects.list"
import { channelsAddHandler } from "@/cli/routes/projects.$project.channels.add"
import { channelsListHandler } from "@/cli/routes/projects.$project.channels.list"
import { help as channelsNamedHelp } from "@/cli/routes/projects.$project.channels.$channel.help"
import { channelsDownloadFileHandler } from "@/cli/routes/projects.$project.channels.$channel.download-file"
import { channelsRemoveHandler } from "@/cli/routes/projects.$project.channels.$channel.remove"
import { channelsRenameHandler } from "@/cli/routes/projects.$project.channels.$channel.rename"
import { channelsRestartHandler } from "@/cli/routes/projects.$project.channels.$channel.restart"
import { channelsSetTokensHandler } from "@/cli/routes/projects.$project.channels.$channel.set-tokens"
import { channelsStartHandler } from "@/cli/routes/projects.$project.channels.$channel.start"
import { channelsStopHandler } from "@/cli/routes/projects.$project.channels.$channel.stop"
import { schedulesAddHandler } from "@/cli/routes/projects.$project.channels.$channel.schedules.add"
import { schedulesListHandler } from "@/cli/routes/projects.$project.channels.$channel.schedules.list"
import { schedulesRemoveHandler } from "@/cli/routes/projects.$project.channels.$channel.schedules.remove"
import { help as projectsNamedHelp } from "@/cli/routes/projects.$project.help"
import { projectsPathHandler } from "@/cli/routes/projects.$project.path"
import { projectsCwdHandler } from "@/cli/routes/projects.$project.cwd"
import { projectsRelocateHandler } from "@/cli/routes/projects.$project.relocate"
import { projectsRemoveHandler } from "@/cli/routes/projects.$project.remove"
import { projectsRenameHandler } from "@/cli/routes/projects.$project.rename"
import { projectsRestartHandler } from "@/cli/routes/projects.$project.restart"
import { projectsResetHandler } from "@/cli/routes/projects.$project.reset"
import { projectsSessionHandler } from "@/cli/routes/projects.$project.session"
import { projectsSessionResetHandler } from "@/cli/routes/projects.$project.session.reset"
import { projectsStartHandler } from "@/cli/routes/projects.$project.start"
import { projectsStopHandler } from "@/cli/routes/projects.$project.stop"
import { restartHandler } from "@/cli/routes/restart"
import { rootHandler } from "@/cli/routes/root"
import { runHandler } from "@/cli/routes/run"
import { slackCallHandler } from "@/cli/routes/slack.call"
import { slackDmHandler } from "@/cli/routes/slack.dm"
import { help as slackHelp } from "@/cli/routes/slack.help"
import { startHandler } from "@/cli/routes/start"
import { statusHandler } from "@/cli/routes/status"
import { stopHandler } from "@/cli/routes/stop"
import { updateHandler } from "@/cli/routes/update"
import { groupHelpHandler } from "@/cli/utils/group-help-handler"

const base = factory.createApp()

base.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.text(`error: ${error.message}`, error.status)
  }

  return c.text(`error: ${errorMessage(error)}`, 500)
})

base.notFound((c) => {
  const cmd = c.req.path.replace(/^\//, "").replace(/\//g, " ")
  return c.text(`unknown command: ${cmd}\n\nrun \`leuco --help\` for available commands`, 404)
})

/**
 * Top-level leuco CLI app. Each subcommand is a `POST /<cmd>` route and the
 * argv → URL/body conversion lives in `@/cli/utils/to-request`. Bare `leuco`
 * routes to `/`, which prints status when the daemon is running and otherwise
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
  .post("/events", ...eventsHandler)
  .post("/update", ...updateHandler)
  .post("/doctor", ...doctorHandler)
  .post("/kill", ...killHandler)

  // Collection URLs (`/projects`, `/projects/:p/channels`, etc) return the list
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
  .post("/projects/:project/relocate", ...projectsRelocateHandler)
  .post("/projects/:project/start", ...projectsStartHandler)
  .post("/projects/:project/stop", ...projectsStopHandler)
  .post("/projects/:project/restart", ...projectsRestartHandler)
  .post("/projects/:project/reset", ...projectsResetHandler)
  .post("/projects/:project/path", ...projectsPathHandler)
  .post("/projects/:project/cwd", ...projectsCwdHandler)
  .post("/projects/:project/session", ...projectsSessionHandler)
  .post("/projects/:project/session/reset", ...projectsSessionResetHandler)

  .post("/projects/:project/channels", ...channelsListHandler)
  .post("/projects/:project/channels/list", ...channelsListHandler)
  .post("/projects/:project/channels/add", ...channelsAddHandler)
  .post("/projects/:project/channels/:channel", ...groupHelpHandler(channelsNamedHelp))
  .post("/projects/:project/channels/:channel/download-file", ...channelsDownloadFileHandler)
  .post("/projects/:project/channels/:channel/remove", ...channelsRemoveHandler)
  .post("/projects/:project/channels/:channel/rename", ...channelsRenameHandler)
  .post("/projects/:project/channels/:channel/start", ...channelsStartHandler)
  .post("/projects/:project/channels/:channel/stop", ...channelsStopHandler)
  .post("/projects/:project/channels/:channel/restart", ...channelsRestartHandler)
  .post("/projects/:project/channels/:channel/set-tokens", ...channelsSetTokensHandler)
  .post("/projects/:project/channels/:channel/schedules", ...schedulesListHandler)
  .post("/projects/:project/channels/:channel/schedules/add", ...schedulesAddHandler)
  .post("/projects/:project/channels/:channel/schedules/list", ...schedulesListHandler)
  .post("/projects/:project/channels/:channel/schedules/remove", ...schedulesRemoveHandler)

  .post("/slack", ...groupHelpHandler(slackHelp))
  .post("/slack/call", ...slackCallHandler)
  .post("/slack/dm", ...slackDmHandler)

  .post("/config", ...configListHandler)
  .post("/config/list", ...configListHandler)
  .post("/config/get", ...configGetHandler)
  .post("/config/set", ...configSetHandler)

  .post("/boot", ...bootStatusHandler)
  .post("/boot/install", ...bootInstallHandler)
  .post("/boot/uninstall", ...bootUninstallHandler)
  .post("/boot/status", ...bootStatusHandler)
