import { filesystemPathSchema } from "@/config/filesystem-path-schema"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const leucoHomeSchema = filesystemPathSchema
  .min(1, "Leuco home must not be empty; unset LEUCO_HOME for ~/.leuco or provide a directory")
  .default(() => join(homedir(), ".leuco"))
  .transform((home) => resolve(home))
