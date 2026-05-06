import { createFactory } from "hono/factory"
import type { LeucoDaemon } from "@/daemon/leuco-daemon"
import type { LoadEnvFileResult } from "@/env/leuco-env"

export type EnvFiles = {
  local: LoadEnvFileResult
  base: LoadEnvFileResult
}

export type Env = {
  Variables: {
    daemon: LeucoDaemon
    cwd: string
    binPath: string
    envFiles: EnvFiles
    version: string
  }
}

export const factory = createFactory<Env>()
