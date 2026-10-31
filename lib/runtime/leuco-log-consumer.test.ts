import { afterEach, expect, it, vi } from "vitest"
import { LeucoLogConsumer } from "@/runtime/leuco-log-consumer"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.useRealTimers())

it("keeps asynchronous failure masked and correlated, with recovery and isolated health snapshots", async () => {
  const events = new LeucoEventLog()
  const secret = "synthetic-private-consumer-secret"
  events.addRedactionSecrets([secret])
  const pending = Promise.withResolvers<void>()
  const onLog = vi.fn<() => void | Promise<void>>().mockReturnValueOnce(pending.promise)
  const consumer = new LeucoLogConsumer({ eventLog: events, onLog })
  consumer.write("record", "warn", "original-request")
  pending.reject(Object.assign(new Error(`${"x".repeat(3980)}${secret}`), { code: "EIO" }))
  await vi.waitFor(() => expect(consumer.getHealth().pending).toBe(0))
  const health = consumer.getHealth()
  expect(health).toMatchObject({
    healthy: false,
    lastFailure: {
      requestId: "original-request",
      causes: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
    },
  })
  expect(JSON.stringify(health)).not.toContain("synthetic-private")
  expect(JSON.stringify(events.query())).not.toContain("synthetic-private")
  expect(events.query({ requestId: "original-request" })).toHaveLength(1)
  health.lastFailure!.causes[0]!.message = "caller mutation"
  expect(JSON.stringify(consumer.getHealth())).not.toContain("caller mutation")
  consumer.write("recovered", "info", "next-request")
  expect(consumer.getHealth()).toMatchObject({
    healthy: true,
    lastFailure: { requestId: "original-request" },
  })
  await consumer.close()
  events.close()
})
it("does not let an older success erase a newer failure", async () => {
  const events = new LeucoEventLog()
  const pending = Promise.withResolvers<void>()
  const onLog = vi
    .fn<() => void | Promise<void>>()
    .mockReturnValueOnce(pending.promise)
    .mockImplementationOnce(() => {
      throw new Error("newer failure")
    })
  const consumer = new LeucoLogConsumer({ eventLog: events, onLog })
  consumer.write("old", "info", "old-request")
  consumer.write("new", "error", "new-request")
  pending.resolve()
  await vi.waitFor(() => expect(consumer.getHealth().pending).toBe(0))
  expect(consumer.getHealth()).toMatchObject({
    healthy: false,
    lastFailure: { requestId: "new-request", message: "newer failure" },
  })
  await consumer.close()
  events.close()
})
it("bounds shutdown and contains late rejection without delivering again", async () => {
  vi.useFakeTimers()
  const events = new LeucoEventLog()
  const pending = Promise.withResolvers<void>()
  const onLog = vi.fn(() => pending.promise)
  const consumer = new LeucoLogConsumer({ eventLog: events, onLog })
  consumer.write("record", "info", "request")
  const closing = consumer.close()
  await vi.advanceTimersByTimeAsync(1000)
  await closing
  expect(consumer.getHealth()).toMatchObject({
    pending: 0,
    healthy: false,
    lastFailure: { message: expect.stringContaining("timed out after 1000ms") },
  })
  expect(events.query()).toHaveLength(1)
  pending.reject(new Error("late rejection"))
  await vi.advanceTimersByTimeAsync(1)
  consumer.write("after close", "info", "late-request")
  expect(onLog).toHaveBeenCalledOnce()
  expect(events.query()).toHaveLength(1)
  events.close()
})
it("bounds unconfirmed deliveries during a burst", async () => {
  vi.useFakeTimers()
  const events = new LeucoEventLog()
  const onLog = vi.fn(() => new Promise<void>(() => {}))
  const consumer = new LeucoLogConsumer({ eventLog: events, onLog })
  for (const index of Array.from({ length: 65 }).keys())
    consumer.write(`record-${index}`, "info", String(index))
  expect(onLog).toHaveBeenCalledTimes(64)
  expect(consumer.getHealth()).toMatchObject({
    pending: 64,
    maxPending: 64,
    healthy: false,
    lastFailure: { requestId: "64", message: expect.stringContaining("64 unconfirmed") },
  })
  const closing = consumer.close()
  await vi.advanceTimersByTimeAsync(1000)
  await closing
  expect(consumer.getHealth().pending).toBe(0)
  events.close()
})

it("keeps callbacks that synchronously return an incidental value compatible", async () => {
  const events = new LeucoEventLog()
  const lines: string[] = []
  const consumer = new LeucoLogConsumer({ eventLog: events, onLog: (line) => lines.push(line) })
  consumer.write("record", "info", null)
  expect(lines).toEqual(["record"])
  expect(consumer.getHealth()).toMatchObject({ healthy: true, pending: 0 })
  await consumer.close()
  events.close()
})

it("does not mistake incidental returned objects for pending asynchronous deliveries", async () => {
  const events = new LeucoEventLog()
  const onLog = vi.fn(() => ({ accepted: true }))
  const consumer = new LeucoLogConsumer({ eventLog: events, onLog })
  for (const index of Array.from({ length: 65 }).keys()) consumer.write(String(index), "info", null)
  expect(onLog).toHaveBeenCalledTimes(65)
  expect(consumer.getHealth()).toMatchObject({ healthy: true, pending: 0 })
  await consumer.close()
  events.close()
})

it("passes the original request ID to host log receivers and leaves background records unassociated", async () => {
  const events = new LeucoEventLog()
  const onLog = vi.fn()
  const consumer = new LeucoLogConsumer({ eventLog: events, onLog })
  consumer.write("request record", "warn", "request-one")
  consumer.write("background record", "info", null)
  expect(onLog).toHaveBeenNthCalledWith(1, "request record", "warn", "request-one")
  expect(onLog).toHaveBeenNthCalledWith(2, "background record", "info", undefined)
  await consumer.close()
  events.close()
})
