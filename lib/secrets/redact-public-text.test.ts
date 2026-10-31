import { expect, it } from "vitest"
import { redactPublicText } from "@/secrets/redact-public-text"

it.each([
  { prefix: "context", token: "xoxb-synthetic-private-token" },
  { prefix: "context_", token: "xoxb-synthetic-private-token" },
  { prefix: "context", token: "xapp-synthetic-private-token" },
  { prefix: "context_", token: "xapp-synthetic-private-token" },
])("masks a Slack token joined directly to $prefix ($token)", (probe) => {
  expect(redactPublicText(`${probe.prefix}${probe.token} diagnostic`)).toBe(
    `${probe.prefix}[redacted] diagnostic`,
  )
})
it("preserves surrounding diagnostics and masks every occurrence", () => {
  expect(redactPublicText("before xoxb-synthetic-one / xapp-synthetic-two after")).toBe(
    "before [redacted] / [redacted] after",
  )
  expect(redactPublicText("prefix xoxb- / xapp- suffix")).toBe("prefix xoxb- / xapp- suffix")
})

it.each(["ws", "wss", "WSS"])(
  "masks temporary %s connection query credentials and preserves the endpoint and cause",
  (protocol) => {
    const endpoint = `${protocol}://wss-primary.slack.com/link/`
    const text = `WebSocket connection to '${endpoint}?ticket=synthetic-socket-ticket&app_id=synthetic-app' failed: read ECONNRESET`
    expect(redactPublicText(text)).toBe(
      `WebSocket connection to '${endpoint}?[redacted]' failed: read ECONNRESET`,
    )
  },
)
it("preserves WebSocket endpoints without a query", () => {
  expect(redactPublicText("wss://localhost/events and ws://localhost/channel")).toBe(
    "wss://localhost/events and ws://localhost/channel",
  )
})

it.each([
  { short: "private-control", full: "private-control-value" },
  { short: "control-value", full: "private-control-value" },
])("masks contained secrets independently of registration order: $short", (probe) => {
  const text = `before ${probe.full} / ${probe.short} after`
  const expected = "before [redacted] / [redacted] after"
  expect(redactPublicText(text, Object.freeze([probe.short, probe.full]))).toBe(expected)
  expect(redactPublicText(text, Object.freeze([probe.full, probe.short]))).toBe(expected)
})

it("masks the union of partially overlapping known secrets", () => {
  expect(redactPublicText("before abcde after", ["abcd", "bcde"])).toBe("before [redacted] after")
  expect(redactPublicText("before abcde after", ["bcde", "abcd"])).toBe("before [redacted] after")
})
it("does not let a known token prefix hide the remaining Slack token", () => {
  expect(redactPublicText("before xoxb-synthetic-private-tail after", ["xoxb-synthetic"])).toBe(
    "before [redacted] after",
  )
})
it("does not process replacement markers as new secrets", () => {
  expect(redactPublicText("private-full-secret", ["private-full-secret", "redacted"])).toBe(
    "[redacted]",
  )
})
it("preserves WebSocket endpoints when a query value is also a known secret", () => {
  expect(
    redactPublicText("wss://localhost/link/?ticket=private-ticket&other=value", ["private-ticket"]),
  ).toBe("wss://localhost/link/?[redacted]")
  const full = "private wss://localhost/link/?ticket=value after"
  expect(redactPublicText(full, [full])).toBe("[redacted]")
})
it("keeps literal regex characters and Unicode intact around adjacent secrets", () => {
  expect(redactPublicText("前 a+b?😀a+b? 後", ["a+b?", "😀"])).toBe(
    "前 [redacted][redacted][redacted] 後",
  )
})

it.each(["https", "http", "wss", "ws", "HTTPS"])(
  "masks %s URL credentials while keeping the public endpoint",
  (scheme) => {
    expect(redactPublicText(`${scheme}://private-user:private-password@host.example/path`)).toBe(
      `${scheme}://[redacted]@host.example/path`,
    )
  },
)
it("combines URL credentials and WebSocket query masking", () => {
  expect(
    redactPublicText("wss://private-user:private-password@host.example/path?ticket=private-ticket"),
  ).toBe("wss://[redacted]@host.example/path?[redacted]")
})
it("does not confuse an @ in a path with URL credentials", () => {
  expect(redactPublicText("https://host.example/path/user@name")).toBe(
    "https://host.example/path/user@name",
  )
})
it("masks all userinfo before the last authority @", () => {
  expect(
    redactPublicText("https://private-first@private-second:private-password@host.example/path"),
  ).toBe("https://[redacted]@host.example/path")
})

it("masks apostrophes within URL credentials together with WebSocket query values", () => {
  expect(redactPublicText("wss://private-user:pa'ss@host.example/path?ticket=private-ticket")).toBe(
    "wss://[redacted]@host.example/path?[redacted]",
  )
})

it("handles a long authority without a query without nested matching work", () => {
  const text = `wss://${"a@".repeat(100000)}host.example/path`
  expect(redactPublicText(text)).toBe("wss://[redacted]@host.example/path")
})

it("consumes concatenated queryless WebSocket text without repeated suffix searches", () => {
  const text = "wss://".repeat(20000)
  expect(redactPublicText(text)).toBe(text)
})
