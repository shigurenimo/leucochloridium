import { describe, expect, expectTypeOf, it } from "vitest"
import {
  LeucoEventBus,
  LeucoMemorySlackWebClient,
  LeucoPaths,
  LeucoRuntime,
  globalSettingsSchema,
  leucoEventSchema,
} from "@/api"
import type {
  LeucoEventBusProps,
  LeucoMemorySlackWebClientProps,
  LeucoPathsProps,
  LeucoRuntimeProps,
  LeucoTenantProps,
} from "@/api"

describe("public API", () => {
  it("exports runtime values from the package root", () => {
    expect(LeucoRuntime).toBeTypeOf("function")
    expect(LeucoPaths).toBeTypeOf("function")
    expect(LeucoEventBus).toBeTypeOf("function")
    expect(LeucoMemorySlackWebClient).toBeTypeOf("function")
    expect(globalSettingsSchema).toBeDefined()
    expect(leucoEventSchema).toBeDefined()
  })

  it("exports constructor and builder contracts", () => {
    expectTypeOf<LeucoRuntimeProps>().toHaveProperty("env")
    expectTypeOf<LeucoPathsProps>().toHaveProperty("home")
    expectTypeOf<LeucoEventBusProps>().toHaveProperty("eventLogPath")
    expectTypeOf<LeucoMemorySlackWebClientProps>().toHaveProperty("authTest")
    expectTypeOf<LeucoTenantProps>().toHaveProperty("turnIdleTimeoutMs")
  })
})
