import { describe, expect, expectTypeOf, it } from "vitest"
import {
  EventLog,
  LeucoEventLog,
  LeucoRuntime,
  MemoryEventLog,
  SqliteEventLog,
  leucoEventSchema,
  projectSchema,
} from "@/api"
import type { Connector, LeucoEventLogProps, LeucoRuntimeProps, Project } from "@/api"

describe("public API", () => {
  it("exports only the stable composition, configuration, connector, and event-log values", () => {
    expect(LeucoRuntime).toBeTypeOf("function")
    expect(EventLog).toBeTypeOf("function")
    expect(MemoryEventLog).toBeTypeOf("function")
    expect(SqliteEventLog).toBeTypeOf("function")
    expect(LeucoEventLog).toBeTypeOf("function")
    expect(projectSchema).toBeDefined()
    expect(leucoEventSchema).toBeDefined()
  })

  it("exports the contracts required by embedders", () => {
    expectTypeOf<LeucoRuntimeProps>().toHaveProperty("env")
    expectTypeOf<LeucoRuntimeProps>().toHaveProperty("codexHome")
    expectTypeOf<LeucoEventLogProps>().toHaveProperty("eventLogPath")
    expectTypeOf<Project>().toHaveProperty("path")
    expectTypeOf<Connector>().toHaveProperty("start")
  })
})
