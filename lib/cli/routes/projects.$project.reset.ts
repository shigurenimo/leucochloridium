import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { readCliBody } from "@/cli/utils/read-cli-body"

export const projectsResetHandler = factory.createHandlers(async (c) => {
  await readCliBody(c)
  const projectName = c.req.param("project")!
  throw new HTTPException(410, {
    message: `use instead: leuco projects ${projectName} session reset`,
  })
})
