import { expect, it } from "vitest"
import { storedLeucoEventTypes } from "@/events/stored-leuco-event-types"

it.each(["__proto__", "constructor", "toString", "unknown.event"])(
  "treats %s as an ordinary event name",
  (type) => expect(storedLeucoEventTypes(type)).toEqual([type]),
)
