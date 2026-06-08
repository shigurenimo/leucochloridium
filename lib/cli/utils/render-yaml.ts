import { stringify } from "yaml"

export const renderYaml = (value: unknown): string => {
  if (typeof value === "string") return value

  return stringify(value, { indent: 2, lineWidth: 0, defaultStringType: "PLAIN" })
}
