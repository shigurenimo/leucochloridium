import { describe, expect, it } from "vitest"
import { parseCliInvocation } from "@/cli/utils/parse-cli-invocation"

describe("parseCliInvocation", () => {
  it("maps bare invocation to /", () => {
    const r = parseCliInvocation([])
    expect(r.path).toBe("/")
    expect(r.parsed).toEqual({ args: [], flags: {} })
  })

  it("maps single top-level command to /<cmd>", () => {
    expect(parseCliInvocation(["start"]).path).toBe("/start")
    expect(parseCliInvocation(["status"]).path).toBe("/status")
    expect(parseCliInvocation(["update"]).path).toBe("/update")
  })

  it("expands /projects/<leaf>", () => {
    expect(parseCliInvocation(["projects", "list"]).path).toBe("/projects/list")
    expect(parseCliInvocation(["projects", "add"]).path).toBe("/projects/add")
  })

  it("treats unknown arg after `projects` as project name", () => {
    expect(parseCliInvocation(["projects", "leuco-debug", "remove"]).path).toBe(
      "/projects/leuco-debug/remove",
    )
  })

  it("expands /projects/<name>/connectors/<leaf>", () => {
    expect(parseCliInvocation(["projects", "leuco-debug", "connectors", "list"]).path).toBe(
      "/projects/leuco-debug/connectors/list",
    )
    expect(parseCliInvocation(["projects", "leuco-debug", "connectors", "add"]).path).toBe(
      "/projects/leuco-debug/connectors/add",
    )
  })

  it("expands /projects/<name>/connectors/<name>/<leaf>", () => {
    expect(parseCliInvocation(["projects", "p", "connectors", "main", "remove"]).path).toBe(
      "/projects/p/connectors/main/remove",
    )
  })

  it("expands channel download-file", () => {
    const r = parseCliInvocation([
      "projects",
      "azamino",
      "connectors",
      "slack",
      "download-file",
      "--file",
      "F123",
      "--out",
      "/tmp/image.png",
    ])
    expect(r.path).toBe("/projects/azamino/connectors/slack/download-file")
    expect(r.parsed.flags).toEqual({
      file: "F123",
      out: "/tmp/image.png",
    })
  })

  it("expands the full /projects/<p>/connectors/<leaf> with positional", () => {
    const r = parseCliInvocation(["projects", "p", "connectors", "add", "slack"])
    expect(r.path).toBe("/projects/p/connectors/add")
    expect(r.parsed.args).toEqual(["slack"])
  })

  it("treats `rename` as a named-leaf and trailing args as positional", () => {
    const r = parseCliInvocation(["projects", "old", "rename", "new"])
    expect(r.path).toBe("/projects/old/rename")
    expect(r.parsed.args).toEqual(["new"])
  })

  it("threads `rename` through the connectors level", () => {
    expect(parseCliInvocation(["projects", "p", "connectors", "old", "rename", "new"]).path).toBe(
      "/projects/p/connectors/old/rename",
    )
  })

  it("treats remaining tokens as positional args", () => {
    const r = parseCliInvocation(["projects", "add", "/tmp/repo"])
    expect(r.path).toBe("/projects/add")
    expect(r.parsed.args).toEqual(["/tmp/repo"])
  })

  it("does not consume a second segment for unknown top-level commands", () => {
    const r = parseCliInvocation(["start", "extra"])
    expect(r.path).toBe("/start")
    expect(r.parsed.args).toEqual(["extra"])
  })

  it("maps project path keys as positional data", () => {
    const r = parseCliInvocation(["projects", "azamino", "path", "agents"])
    expect(r.path).toBe("/projects/azamino/path")
    expect(r.parsed.args).toEqual(["agents"])
  })

  it("maps project cwd changes with the directory as positional data", () => {
    const r = parseCliInvocation(["projects", "cocolococo-hiract", "cwd", "/tmp/worktree"])
    expect(r.path).toBe("/projects/cocolococo-hiract/cwd")
    expect(r.parsed.args).toEqual(["/tmp/worktree"])
  })

  it("expands project session reset", () => {
    expect(parseCliInvocation(["projects", "azamino", "session"]).path).toBe(
      "/projects/azamino/session",
    )
    expect(parseCliInvocation(["projects", "azamino", "session", "reset"]).path).toBe(
      "/projects/azamino/session/reset",
    )
  })

  it("maps project conversation scope as a session subcommand", () => {
    const request = parseCliInvocation(["projects", "azamino", "session", "scope", "thread"])

    expect(request.path).toBe("/projects/azamino/session/scope")
    expect(request.parsed.args).toEqual(["thread"])
  })

  it("expands /boot/<leaf>", () => {
    expect(parseCliInvocation(["boot", "install"]).path).toBe("/boot/install")
    expect(parseCliInvocation(["boot", "uninstall"]).path).toBe("/boot/uninstall")
    expect(parseCliInvocation(["boot", "status"]).path).toBe("/boot/status")
  })

  it("expands Slack DM diagnostics with the conversation ID as positional data", () => {
    const r = parseCliInvocation(["slack", "dm", "D0123ABC", "--project", "cocolococo-hiract"])
    expect(r.path).toBe("/slack/dm")
    expect(r.parsed.args).toEqual(["D0123ABC"])
    expect(r.parsed.flags).toEqual({ project: "cocolococo-hiract" })
  })

  it("expands Slack DM diagnostics without a conversation ID", () => {
    const r = parseCliInvocation(["slack", "dm", "--project", "cocolococo-hiract"])
    expect(r.path).toBe("/slack/dm")
    expect(r.parsed.args).toEqual([])
    expect(r.parsed.flags).toEqual({ project: "cocolococo-hiract" })
  })

  it("collects --key value flags interspersed with segments", () => {
    const r = parseCliInvocation(["projects", "add", "/p", "--name", "foo"])
    expect(r.path).toBe("/projects/add")
    expect(r.parsed.args).toEqual(["/p"])
    expect(r.parsed.flags).toEqual({ name: "foo" })
  })

  it("collects bare --flag as boolean true", () => {
    const r = parseCliInvocation(["logs", "--follow"])
    expect(r.parsed.flags).toEqual({ follow: true })
  })

  it("expands short flags via SHORT_FLAGS", () => {
    expect(parseCliInvocation(["logs", "-f"]).parsed.flags.follow).toBe(true)
    expect(parseCliInvocation(["-h"]).parsed.flags.help).toBe(true)
    expect(parseCliInvocation(["-v"]).parsed.flags.version).toBe(true)
  })

  it("ignores unknown short flags", () => {
    const r = parseCliInvocation(["start", "-z"])
    expect(r.parsed.flags).toEqual({})
  })

  it("serializes body as JSON matching parsed", () => {
    const r = parseCliInvocation(["projects", "add", "/tmp/x", "--name", "x"])
    expect(JSON.parse(r.body)).toEqual(r.parsed)
  })

  it("expands schedules under a named channel", () => {
    expect(parseCliInvocation(["projects", "p", "connectors", "c", "schedules", "list"]).path).toBe(
      "/projects/p/connectors/c/schedules/list",
    )

    const remove = parseCliInvocation([
      "projects",
      "p",
      "connectors",
      "c",
      "schedules",
      "remove",
      "morning",
    ])
    expect(remove.path).toBe("/projects/p/connectors/c/schedules/remove")
    expect(remove.parsed.args).toEqual(["morning"])
  })

  it("expands project-level start/stop/restart", () => {
    expect(parseCliInvocation(["projects", "p", "start"]).path).toBe("/projects/p/start")
    expect(parseCliInvocation(["projects", "p", "stop"]).path).toBe("/projects/p/stop")
    expect(parseCliInvocation(["projects", "p", "restart"]).path).toBe("/projects/p/restart")
  })

  it("parses --key=value form", () => {
    const r = parseCliInvocation(["events", "--limit=50", "--project=foo"])
    expect(r.parsed.flags).toEqual({ limit: "50", project: "foo" })
  })

  it("accepts a negative-number flag value", () => {
    const r = parseCliInvocation(["events", "--offset", "-5"])
    expect(r.parsed.flags).toEqual({ offset: "-5" })
  })
})
