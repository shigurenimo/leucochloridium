import type { ZodError } from "zod"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

export function getBoundedValidationIssues(error: ZodError, secrets: ReadonlyArray<string> = []) {
  return {
    issues: error.issues.slice(0, 8).map((issue) => ({
      code: issue.code,
      path: issue.path
        .slice(0, 16)
        .map((part) => truncateDiagnosticText(redactPublicText(String(part), secrets), 200)),
      message: truncateDiagnosticText(redactPublicText(issue.message, secrets), 1000),
    })),
    omittedIssues: Math.max(0, error.issues.length - 8),
  }
}
