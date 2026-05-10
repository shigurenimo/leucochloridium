import { describe, expect, it } from "vitest"
import { LeucoHumanLogger } from "@/logger/leuco-human-logger"
import type { LeucoHumanRecord } from "@/logger/leuco-human-record"
import type { LeucoHumanWriter } from "@/logger/leuco-human-writer"

class FakeWriter implements LeucoHumanWriter {
  readonly records: LeucoHumanRecord[] = []
  closed = 0

  write(record: LeucoHumanRecord): void {
    this.records.push(record)
  }

  close(): void {
    this.closed += 1
  }
}

describe("LeucoHumanLogger", () => {
  it("emits info, warn, error records to the writer", () => {
    const writer = new FakeWriter()
    const log = new LeucoHumanLogger({ writer })

    log.info("hello", { port: 9742 })
    log.warn("slow")
    log.error("boom", { stack: "..." })

    expect(writer.records.length).toBe(3)
    expect(writer.records[0]?.level).toBe("info")
    expect(writer.records[0]?.message).toBe("hello")
    expect(writer.records[0]?.meta).toEqual({ port: 9742 })
    expect(writer.records[1]?.level).toBe("warn")
    expect(writer.records[1]?.meta).toBeNull()
    expect(writer.records[2]?.level).toBe("error")
    expect(writer.records[2]?.meta).toEqual({ stack: "..." })
  })

  it("respects minimum level", () => {
    const writer = new FakeWriter()
    const log = new LeucoHumanLogger({ writer, level: "warn" })

    log.info("dropped")
    log.warn("kept")
    log.error("kept")

    expect(writer.records.map((r) => r.level)).toEqual(["warn", "error"])
  })

  it("dropping at minimum level skips writer entirely", () => {
    let called = 0
    const writer: LeucoHumanWriter = {
      write: () => {
        called += 1
      },
    }
    const log = new LeucoHumanLogger({ writer, level: "error" })

    log.info("dropped")
    log.warn("dropped")

    expect(called).toBe(0)
  })

  it("uses the injected clock for ts", () => {
    const writer = new FakeWriter()
    const log = new LeucoHumanLogger({ writer, now: () => 1700000000000 })

    log.info("hi")

    expect(writer.records[0]?.ts).toBe(1700000000000)
  })

  it("isolates a throwing writer and surfaces errors via onWriteError", () => {
    const failing: LeucoHumanWriter = {
      write() {
        throw new Error("disk full")
      },
    }
    const errors: Error[] = []
    const log = new LeucoHumanLogger({
      writer: failing,
      onWriteError: (e) => errors.push(e),
    })

    log.info("hi")

    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toBe("disk full")
  })

  it("treats writer-returned Error like a thrown one", () => {
    const failing: LeucoHumanWriter = {
      write() {
        return new Error("nope")
      },
    }
    const errors: Error[] = []
    const log = new LeucoHumanLogger({
      writer: failing,
      onWriteError: (e) => errors.push(e),
    })

    log.warn("hi")

    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toBe("nope")
  })

  it("close calls writer.close once", () => {
    const writer = new FakeWriter()
    const log = new LeucoHumanLogger({ writer })

    log.close()

    expect(writer.closed).toBe(1)
  })

  it("close swallows writer.close exceptions", () => {
    const writer: LeucoHumanWriter = {
      write: () => {},
      close: () => {
        throw new Error("close failed")
      },
    }
    const log = new LeucoHumanLogger({ writer })

    expect(() => log.close()).not.toThrow()
  })
})
