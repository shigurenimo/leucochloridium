import { z } from "zod"

export const filesystemPathSchema = z
  .string()
  .refine((path) => !path.includes("\0"), "Path must not contain NUL bytes")
