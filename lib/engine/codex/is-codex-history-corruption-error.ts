export const isCodexHistoryCorruptionError = (error: Error): boolean => {
  return (
    error.message.includes("invalid_request_error") && /input\[\d+\]\.arguments/.test(error.message)
  )
}
