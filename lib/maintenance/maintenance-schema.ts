import { filesystemPathSchema } from "@/config/filesystem-path-schema"
import { errorDetailsSchema } from "@/error-details-schema"
import { z } from "zod"
import { isAbsolute } from "node:path"

export const launchSchema = z.strictObject({
  workingDirectory: filesystemPathSchema.refine(isAbsolute, "workingDirectory must be absolute"),
  codexHome: filesystemPathSchema.nullable(),
  cwd: filesystemPathSchema.refine(isAbsolute, "cwd must be absolute").optional(),
  soul: filesystemPathSchema.refine(isAbsolute, "soul must be absolute").nullable().optional(),
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
  eventLogCauses: errorDetailsSchema.optional(),
  launch: launchSchema,
})
export type LaunchConfiguration = z.infer<typeof launchSchema>
export type MaintenanceOperation = z.infer<typeof operationSchema>
