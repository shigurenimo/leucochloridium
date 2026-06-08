import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

export const groupHelpHandler = (help: string) =>
  factory.createHandlers(async (c) => {
    const body = await readCliBody(c)

    if (flagBool(body.flags.help)) return c.text(help)

    throw new HTTPException(400, { message: `leuco: missing subcommand\n\n${help}` })
  })
