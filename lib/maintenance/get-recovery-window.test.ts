import { describe, expect, it } from "vitest"
import { getRecoveryWindow } from "@/maintenance/get-recovery-window"

describe("automatic restart window", () => {
  it("counts repeated crashes in one fixed window and resets only after that window", () => {
    expect(getRecoveryWindow(null, 0)).toEqual({ attempt: 1, startedAt: 0 })
    expect(getRecoveryWindow({ attempt: 3, startedAt: 0 }, 59999)).toEqual({
      attempt: 4,
      startedAt: 0,
    })
    expect(getRecoveryWindow({ attempt: 3, startedAt: 0 }, 60000)).toEqual({
      attempt: 1,
      startedAt: 60000,
    })
  })
})
