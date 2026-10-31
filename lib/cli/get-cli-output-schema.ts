import type { JSONSchema } from "zod/v4/core"

export function getCliOutputSchema(
  command: string,
  resultSchema: JSONSchema.JSONSchema,
  definitions: Record<string, JSONSchema.JSONSchema> = {},
) {
  const encoded = JSON.stringify(resultSchema)
  return {
    type: "object",
    required: ["schemaVersion", "ok", "command", "requestId", "data"],
    properties: {
      schemaVersion: { const: 1 },
      ok: { const: true },
      command: { const: command },
      requestId: { type: "string", format: "uuid" },
      data: resultSchema,
    },
    additionalProperties: false,
    ...(encoded.includes("#/$defs/")
      ? {
          $defs: Object.fromEntries(
            Object.entries(definitions).filter(([name]) => encoded.includes(`#/$defs/${name}`)),
          ),
        }
      : {}),
  } satisfies JSONSchema.JSONSchema
}
