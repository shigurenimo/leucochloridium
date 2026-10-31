import { describe, expect, it } from "vitest"
import { assertSlackFileUrl } from "@/actions/slack/assert-slack-file-url"

describe("assertSlackFileUrl", () => {
  it("accepts files.slack.com url_private_download", () => {
    const url = "https://files.slack.com/files-pri/T0-F0/download/example.png"
    expect(assertSlackFileUrl(url).href).toBe(url)
  })

  it("accepts any *.slack.com host", () => {
    expect(() => assertSlackFileUrl("https://files-edge.slack.com/x")).not.toThrow()
    expect(() => assertSlackFileUrl("https://slack.com/x")).not.toThrow()
  })

  it("rejects a non-slack host", () => {
    expect(() => assertSlackFileUrl("https://evil.example.com/steal")).toThrow(/non-slack host/)
  })

  it("rejects a lookalike host that only ends in slack.com", () => {
    expect(() => assertSlackFileUrl("https://notslack.com/x")).toThrow(/non-slack host/)
    expect(() => assertSlackFileUrl("https://evilslack.com/x")).toThrow(/non-slack host/)
  })

  it("rejects userinfo smuggling that puts slack.com before @", () => {
    expect(() => assertSlackFileUrl("https://files.slack.com@evil.example.com/x")).toThrow(
      /non-slack host/,
    )
  })

  it("rejects a slack.com host nested as a subdomain of an attacker domain", () => {
    expect(() => assertSlackFileUrl("https://files.slack.com.evil.example.com/x")).toThrow(
      /non-slack host/,
    )
  })

  it("rejects non-https schemes", () => {
    expect(() => assertSlackFileUrl("http://files.slack.com/x")).toThrow(/must be https/)
    expect(() => assertSlackFileUrl("file:///etc/passwd")).toThrow(/must be https/)
  })

  it("rejects malformed urls", () => {
    expect(() => assertSlackFileUrl("not a url")).toThrow(/invalid download url/)
  })
})

it("does not quote malformed download URLs in diagnostics", () => {
  const raw = "https://user:private-password@[invalid?ticket=private-ticket"
  const failure = (() => {
    try {
      assertSlackFileUrl(raw)
    } catch (error) {
      return error
    }
  })()
  expect(String(failure)).toContain("invalid download url")
  expect(String(failure)).not.toContain("private-")
  expect(String(failure)).toContain(String(raw.length))
})
it("rejects URL credentials before an authenticated fetch", () => {
  expect(() => assertSlackFileUrl("https://user:private-password@files.slack.com/file")).toThrow(
    "credentials",
  )
})
