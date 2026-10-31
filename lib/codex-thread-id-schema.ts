import { z } from "zod"

export const codexThreadIdSchema = z.string().regex(/\S/, "Codex thread ID must not be blank")
