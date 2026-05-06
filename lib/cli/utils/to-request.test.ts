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

  it("expands /projects/<name>/agents/<leaf>", () => {
    expect(toRequest(["projects", "leuco-debug", "agents", "list"]).path).toBe(
      "/projects/leuco-debug/agents/list",
    )
    expect(toRequest(["projects", "leuco-debug", "agents", "add"]).path).toBe(
      "/projects/leuco-debug/agents/add",
    )
  })

  it("expands /projects/<name>/agents/<name>/<leaf>", () => {
    expect(toRequest(["projects", "p", "agents", "reviewer", "remove"]).path).toBe(
      "/projects/p/agents/reviewer/remove",
    )
  })

  it("expands the full /projects/<p>/agents/<a>/channels/<leaf>", () => {
    const r = toRequest(["projects", "p", "agents", "reviewer", "channels", "add", "slack"])
    expect(r.path).toBe("/projects/p/agents/reviewer/channels/add")
    expect(r.parsed.args).toEqual(["slack"])
  })

  it("expands the full /projects/<p>/agents/<a>/channels/<name>/<leaf>", () => {
    const r = toRequest([
      "projects",
      "p",
      "agents",
      "reviewer",
      "channels",
      "main",
      "remove",
    ])
    expect(r.path).toBe("/projects/p/agents/reviewer/channels/main/remove")
    expect(r.parsed.args).toEqual([])
  })

  it("treats `rename` as a named-leaf and trailing args as positional", () => {
    const r = toRequest(["projects", "old", "rename", "new"])
    expect(r.path).toBe("/projects/old/rename")
    expect(r.parsed.args).toEqual(["new"])
  })

  it("threads `rename` through the agents and channels levels", () => {
    expect(toRequest(["projects", "p", "agents", "old", "rename", "new"]).path).toBe(
      "/projects/p/agents/old/rename",
    )
    expect(
      toRequest(["projects", "p", "agents", "a", "channels", "old", "rename", "new"]).path,
    ).toBe("/projects/p/agents/a/channels/old/rename")
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
})
