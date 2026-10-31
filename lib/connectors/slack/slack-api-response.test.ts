import { expect, it, vi } from "vitest"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { errorDetails } from "@/error-details"

it.each([
  { label: "null", response: null },
  { label: "array", response: [] },
  { label: "text", response: "unexpected body" },
  { label: "number", response: 1 },
  { label: "missing success flag", response: {} },
  { label: "string success flag", response: { ok: "true" } },
  { label: "null success flag", response: { ok: null } },
  { label: "Slack error", response: { ok: false, error: "missing_scope" } },
])("does not report or retry a successful write for $label", async (scenario) => {
  const fetchFn = vi.fn(async () => Response.json(scenario.response))
  const client = new LeucoFetchSlackWebClient({ botToken: "synthetic-token", fetchFn })
  const failure = await client
    .apiCall("chat.postMessage", { channel: "C1", text: "message" })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain("slack chat.postMessage:")
  if (scenario.label === "Slack error") expect(String(failure)).toContain("missing_scope")
  expect(fetchFn).toHaveBeenCalledOnce()
})

it.each([
  { ok: true },
  { ok: true, user_id: null },
  { ok: true, user_id: 42 },
  { ok: true, user_id: "" },
  { ok: true, user_id: " \t" },
  { ok: true, user_id: "U1", bot_id: 42 },
  { ok: true, user_id: "U1", bot_id: "" },
])("rejects invalid auth identities without losing schema causes: %j", async (response) => {
  const fetchFn = vi.fn(async () => Response.json(response))
  const client = new LeucoFetchSlackWebClient({ botToken: "synthetic-token", fetchFn })
  const failure = await client.authTest().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain("slack auth.test: invalid identity response")
  expect(errorDetails(failure).some((cause) => cause.name === "ZodError")).toBe(true)
  expect(fetchFn).toHaveBeenCalledOnce()
})
