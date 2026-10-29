import { errorDetailsSchema } from "@/error-details-schema"
import { z } from "zod"

export const launchSchema = z.strictObject({
  workingDirectory: z.string(),
  codexHome: z.string().nullable(),
  cwd: z.string().optional(),
  soul: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  codexBin: z.string().optional(),
})
export const operationSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(["accepted", "stopping", "starting", "ready", "failed", "uncertain"]),
  requestedAt: z.number(),
  updatedAt: z.number(),
  workerPid: z.number().int().positive().nullable(),
  oldPid: z.number().int().positive().nullable(),
  oldLeaseId: z.string().nullable(),
  recovery: z.object({ attempt: z.number().int().positive(), startedAt: z.number() }).nullable(),
  newPid: z.number().int().positive().nullable(),
  error: z.string().nullable(),
  causes: errorDetailsSchema.optional(),
  eventLogError: z.string().nullable().optional(),
  launch: launchSchema,
})
export type LaunchConfiguration = z.infer<typeof launchSchema>
export type MaintenanceOperation = z.infer<typeof operationSchema>
