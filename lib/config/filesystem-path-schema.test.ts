import { expect, it } from "vitest"
import { settingsSchema } from "@/config/config-schema"
import { leucoHomeSchema } from "@/config/leuco-home-schema"
import { launchSchema } from "@/maintenance/maintenance-schema"

it.each(["cwd", "soul"])("rejects NUL bytes in saved %s", (field) => {
  expect(settingsSchema.safeParse({ [field]: "/tmp/invalid\0path" }).success).toBe(false)
})

it.each(["cwd", "soul", "workingDirectory", "codexHome"])(
  "rejects NUL bytes in launch %s",
  (field) => {
    expect(
      launchSchema.safeParse({
        workingDirectory: "/tmp/work",
        codexHome: null,
        [field]: "/tmp/invalid\0path",
      }).success,
    ).toBe(false)
  },
)

it("rejects NUL bytes in Leuco home before resolving it", () => {
  expect(leucoHomeSchema.safeParse("invalid\0path").success).toBe(false)
})

it("keeps spaces, Unicode, nullable settings and relative home paths supported", () => {
  const path = "/tmp/作業 folder"
  expect(settingsSchema.parse({ cwd: path, soul: path })).toMatchObject({ cwd: path, soul: path })
  expect(settingsSchema.parse({ cwd: null, soul: null })).toMatchObject({ cwd: null, soul: null })
  expect(launchSchema.parse({ workingDirectory: path, codexHome: "relative home" })).toEqual({
    workingDirectory: path,
    codexHome: "relative home",
  })
  expect(leucoHomeSchema.parse("relative home")).toMatch(/\/relative home$/)
})
