import { describe, expect, it } from "vitest"
import { parseLegacyDaemonPid } from "@/daemon/legacy-pid-lease/parse-legacy-daemon-pid"

describe("parseLegacyDaemonPid", () => {
  it("accepts the numeric pid format written before 0.16", () => {
    expect(parseLegacyDaemonPid("40178")).toBe(40178)
  })

  it.each(["", "0", "-1", "1.5", "123junk", "9007199254740992", "{}"])(
    "rejects unsafe legacy pid text %s",
    (text) => {
      expect(parseLegacyDaemonPid(text)).toBeNull()
    },
  )
})
