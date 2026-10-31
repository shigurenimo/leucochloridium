import { z } from "zod"

const maintenance = z.record(z.string(), z.unknown()).nullable().optional()
export const runningDaemonStatusSchema = z.strictObject({
  running: z.literal(true),
  ready: z.boolean(),
  pid: z.number().int().positive(),
  cwd: z.string().min(1),
  runtime: z.record(z.string(), z.unknown()).optional(),
  maintenance,
})
export const daemonStatusSchema = z.discriminatedUnion("running", [
  runningDaemonStatusSchema,
  z.strictObject({ running: z.literal(false), maintenance }),
])
