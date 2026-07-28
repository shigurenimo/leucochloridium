import { describe, expect, expectTypeOf, it } from "vitest"
import {
  EventJournal,
  LeucoEventJournal,
  LeucoRuntime,
  MemoryEventJournal,
  SqliteEventJournal,
  leucoEventSchema,
  projectSchema,
} from "@/api"
import type { Connector, LeucoEventJournalProps, LeucoRuntimeProps, Project } from "@/api"

describe("public API", () => {
  it("exports only the stable composition, configuration, connector, and journal values", () => {
    expect(LeucoRuntime).toBeTypeOf("function")
    expect(EventJournal).toBeTypeOf("function")
    expect(MemoryEventJournal).toBeTypeOf("function")
    expect(SqliteEventJournal).toBeTypeOf("function")
    expect(LeucoEventJournal).toBeTypeOf("function")
    expect(projectSchema).toBeDefined()
    expect(leucoEventSchema).toBeDefined()
  })

  it("exports the contracts required by embedders", () => {
    expectTypeOf<LeucoRuntimeProps>().toHaveProperty("env")
    expectTypeOf<LeucoEventJournalProps>().toHaveProperty("eventLogPath")
    expectTypeOf<Project>().toHaveProperty("path")
    expectTypeOf<Connector>().toHaveProperty("start")
  })
})
