import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { errorMessage } from "@/error-message"
import { bootInstallHandler } from "@/cli/routes/boot.install"
import { bootStatusHandler } from "@/cli/routes/boot.status"
import { bootUninstallHandler } from "@/cli/routes/boot.uninstall"
import { doctorHandler } from "@/cli/routes/doctor"
import { eventsHandler } from "@/cli/routes/events"
import { configGetHandler } from "@/cli/routes/config.get"
import { configListHandler } from "@/cli/routes/config.list"
import { configSetHandler } from "@/cli/routes/config.set"
import { logsHandler } from "@/cli/routes/logs"
import { projectsAddHandler } from "@/cli/routes/projects.add"
import { projectsListHandler } from "@/cli/routes/projects.list"
import { connectorsAddHandler } from "@/cli/routes/projects.$project.connectors.add"
import { connectorsListHandler } from "@/cli/routes/projects.$project.connectors.list"
import { help as connectorsNamedHelp } from "@/cli/routes/projects.$project.connectors.$connector.help"
import { connectorsDownloadFileHandler } from "@/cli/routes/projects.$project.connectors.$connector.download-file"
import { connectorsRemoveHandler } from "@/cli/routes/projects.$project.connectors.$connector.remove"
import { connectorsRenameHandler } from "@/cli/routes/projects.$project.connectors.$connector.rename"
import { connectorsRestartHandler } from "@/cli/routes/projects.$project.connectors.$connector.restart"
import { connectorsSetTokensHandler } from "@/cli/routes/projects.$project.connectors.$connector.set-tokens"
import { connectorsStartHandler } from "@/cli/routes/projects.$project.connectors.$connector.start"
import { connectorsStopHandler } from "@/cli/routes/projects.$project.connectors.$connector.stop"
import { schedulesAddHandler } from "@/cli/routes/projects.$project.connectors.$connector.schedules.add"
import { schedulesListHandler } from "@/cli/routes/projects.$project.connectors.$connector.schedules.list"
import { schedulesRemoveHandler } from "@/cli/routes/projects.$project.connectors.$connector.schedules.remove"
import { help as projectsNamedHelp } from "@/cli/routes/projects.$project.help"
import { projectsPathHandler } from "@/cli/routes/projects.$project.path"
import { projectsCwdHandler } from "@/cli/routes/projects.$project.cwd"
import { projectsRemoveHandler } from "@/cli/routes/projects.$project.remove"
import { projectsRenameHandler } from "@/cli/routes/projects.$project.rename"
import { projectsRestartHandler } from "@/cli/routes/projects.$project.restart"
import { projectsSessionHandler } from "@/cli/routes/projects.$project.session"
import { projectsSessionResetHandler } from "@/cli/routes/projects.$project.session.reset"
import { projectsSessionScopeHandler } from "@/cli/routes/projects.$project.session.scope"
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
 * Top-level in-process command table. Paths are command identifiers, not HTTP
 * endpoints; `parseCliInvocation` maps argv into these identifiers.
 *
 * Route file naming mirrors the URL: `<segments>.ts` for `/<segments>`,
 * `$<param>` in the file name stands in for `:<param>` in the URL.
 */
export const app = base
  .command("/", ...rootHandler)
  .command("/start", ...startHandler)
  .command("/stop", ...stopHandler)
  .command("/status", ...statusHandler)
  .command("/restart", ...restartHandler)
  .command("/run", ...runHandler)
  .command("/logs", ...logsHandler)
  .command("/events", ...eventsHandler)
  .command("/doctor", ...doctorHandler)
  .command("/update", ...updateHandler)

  // Collection URLs (`/projects`, `/projects/:p/connectors`, etc) return the list
  // directly so `leuco projects` is enough to see what's registered. The
  // explicit `/list` aliases stay for backwards-compat scripts. Each leaf
  // handler honours `--help` itself so `leuco projects --help` keeps working.
  .command("/projects", ...projectsListHandler)
  .command("/projects/list", ...projectsListHandler)
  .command("/projects/add", ...projectsAddHandler)
  .command("/projects/:project", ...groupHelpHandler(projectsNamedHelp))
  .command("/projects/:project/remove", ...projectsRemoveHandler)
  .command("/projects/:project/rename", ...projectsRenameHandler)
  .command("/projects/:project/start", ...projectsStartHandler)
  .command("/projects/:project/stop", ...projectsStopHandler)
  .command("/projects/:project/restart", ...projectsRestartHandler)
  .command("/projects/:project/path", ...projectsPathHandler)
  .command("/projects/:project/cwd", ...projectsCwdHandler)
  .command("/projects/:project/session", ...projectsSessionHandler)
  .command("/projects/:project/session/reset", ...projectsSessionResetHandler)
  .command("/projects/:project/session/scope", ...projectsSessionScopeHandler)

  .command("/projects/:project/connectors", ...connectorsListHandler)
  .command("/projects/:project/connectors/list", ...connectorsListHandler)
  .command("/projects/:project/connectors/add", ...connectorsAddHandler)
  .command("/projects/:project/connectors/:connector", ...groupHelpHandler(connectorsNamedHelp))
  .command(
    "/projects/:project/connectors/:connector/download-file",
    ...connectorsDownloadFileHandler,
  )
  .command("/projects/:project/connectors/:connector/remove", ...connectorsRemoveHandler)
  .command("/projects/:project/connectors/:connector/rename", ...connectorsRenameHandler)
  .command("/projects/:project/connectors/:connector/start", ...connectorsStartHandler)
  .command("/projects/:project/connectors/:connector/stop", ...connectorsStopHandler)
  .command("/projects/:project/connectors/:connector/restart", ...connectorsRestartHandler)
  .command("/projects/:project/connectors/:connector/set-tokens", ...connectorsSetTokensHandler)
  .command("/projects/:project/connectors/:connector/schedules", ...schedulesListHandler)
  .command("/projects/:project/connectors/:connector/schedules/add", ...schedulesAddHandler)
  .command("/projects/:project/connectors/:connector/schedules/list", ...schedulesListHandler)
  .command("/projects/:project/connectors/:connector/schedules/remove", ...schedulesRemoveHandler)

  .command("/slack", ...groupHelpHandler(slackHelp))
  .command("/slack/call", ...slackCallHandler)
  .command("/slack/dm", ...slackDmHandler)

  .command("/config", ...configListHandler)
  .command("/config/list", ...configListHandler)
  .command("/config/get", ...configGetHandler)
  .command("/config/set", ...configSetHandler)

  .command("/boot", ...bootStatusHandler)
  .command("/boot/install", ...bootInstallHandler)
  .command("/boot/uninstall", ...bootUninstallHandler)
  .command("/boot/status", ...bootStatusHandler)
