import { describe, expect, it } from "vitest"
import { toRequest } from "@/cli/utils/to-request"

describe("toRequest", () => {
  it("maps bare invocation to /", () => {
    const r = toRequest([])
    expect(r.method).toBe("POST")
    expect(r.path).toBe("/")
    expect(r.parsed).toEqual({ args: [], flags: {} })
  })

  it("maps single top-level command to /<cmd>", () => {
    expect(toRequest(["start"]).path).toBe("/start")
    expect(toRequest(["status"]).path).toBe("/status")
  })

  it("expands /projects/<leaf>", () => {
    expect(toRequest(["projects", "list"]).path).toBe("/projects/list")
    expect(toRequest(["projects", "create"]).path).toBe("/projects/create")
    expect(toRequest(["projects", "add"]).path).toBe("/projects/add")
  })

  it("treats unknown arg after `projects` as project name", () => {
    expect(toRequest(["projects", "leuco-debug", "remove"]).path).toBe(
      "/projects/leuco-debug/remove",
    )
  })

  it("expands /projects/<name>/channels/<leaf>", () => {
    expect(toRequest(["projects", "leuco-debug", "channels", "list"]).path).toBe(
      "/projects/leuco-debug/channels/list",
    )
    expect(toRequest(["projects", "leuco-debug", "channels", "add"]).path).toBe(
      "/projects/leuco-debug/channels/add",
    )
  })

  it("expands /projects/<name>/channels/<name>/<leaf>", () => {
    expect(toRequest(["projects", "p", "channels", "main", "remove"]).path).toBe(
      "/projects/p/channels/main/remove",
    )
  })

  it("expands the full /projects/<p>/channels/<leaf> with positional", () => {
    const r = toRequest(["projects", "p", "channels", "add", "slack"])
    expect(r.path).toBe("/projects/p/channels/add")
    expect(r.parsed.args).toEqual(["slack"])
  })

  it("treats `rename` as a named-leaf and trailing args as positional", () => {
    const r = toRequest(["projects", "old", "rename", "new"])
    expect(r.path).toBe("/projects/old/rename")
    expect(r.parsed.args).toEqual(["new"])
  })

  it("threads `rename` through the channels level", () => {
    expect(toRequest(["projects", "p", "channels", "old", "rename", "new"]).path).toBe(
      "/projects/p/channels/old/rename",
    )
  })

  it("treats `relocate` as a named-leaf with the new path as positional", () => {
    const r = toRequest(["projects", "old", "relocate", "/tmp/new"])
    expect(r.path).toBe("/projects/old/relocate")
    expect(r.parsed.args).toEqual(["/tmp/new"])
  })

  it("treats remaining tokens as positional args", () => {
    const r = toRequest(["projects", "create", "/tmp/repo"])
    expect(r.path).toBe("/projects/create")
    expect(r.parsed.args).toEqual(["/tmp/repo"])
  })

  it("does not consume a second segment for unknown top-level commands", () => {
    const r = toRequest(["start", "extra"])
    expect(r.path).toBe("/start")
    expect(r.parsed.args).toEqual(["extra"])
  })

  it("expands /boot/<leaf>", () => {
    expect(toRequest(["boot", "install"]).path).toBe("/boot/install")
    expect(toRequest(["boot", "uninstall"]).path).toBe("/boot/uninstall")
    expect(toRequest(["boot", "status"]).path).toBe("/boot/status")
  })

  it("collects --key value flags interspersed with segments", () => {
    const r = toRequest(["projects", "create", "/p", "--name", "foo"])
    expect(r.path).toBe("/projects/create")
    expect(r.parsed.args).toEqual(["/p"])
    expect(r.parsed.flags).toEqual({ name: "foo" })
  })

  it("collects bare --flag as boolean true", () => {
    const r = toRequest(["logs", "--follow"])
    expect(r.parsed.flags).toEqual({ follow: true })
  })

  it("expands short flags via SHORT_FLAGS", () => {
    expect(toRequest(["logs", "-f"]).parsed.flags.follow).toBe(true)
    expect(toRequest(["-h"]).parsed.flags.help).toBe(true)
    expect(toRequest(["-v"]).parsed.flags.version).toBe(true)
  })

  it("ignores unknown short flags", () => {
    const r = toRequest(["start", "-z"])
    expect(r.parsed.flags).toEqual({})
  })

  it("serializes body as JSON matching parsed", () => {
    const r = toRequest(["projects", "create", "/tmp/x", "--name", "x"])
    expect(JSON.parse(r.body)).toEqual(r.parsed)
  })

  it("builds full URL with localhost", () => {
    const r = toRequest(["status"])
    expect(r.url).toBe("http://localhost/status")
  })

  it("expands schedules under a named channel", () => {
    expect(toRequest(["projects", "p", "channels", "c", "schedules", "list"]).path).toBe(
      "/projects/p/channels/c/schedules/list",
    )

    const remove = toRequest(["projects", "p", "channels", "c", "schedules", "remove", "morning"])
    expect(remove.path).toBe("/projects/p/channels/c/schedules/remove")
    expect(remove.parsed.args).toEqual(["morning"])
  })

  it("expands project-level start/stop/restart/reset", () => {
    expect(toRequest(["projects", "p", "start"]).path).toBe("/projects/p/start")
    expect(toRequest(["projects", "p", "stop"]).path).toBe("/projects/p/stop")
    expect(toRequest(["projects", "p", "restart"]).path).toBe("/projects/p/restart")
    expect(toRequest(["projects", "p", "reset"]).path).toBe("/projects/p/reset")
  })
})
