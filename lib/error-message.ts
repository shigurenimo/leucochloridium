export const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message
  return String(err)
}
