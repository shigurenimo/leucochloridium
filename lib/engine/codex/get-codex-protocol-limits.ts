type Props = { maxFrameChars?: number; logPreviewChars?: number }

export function getCodexProtocolLimits(props: Props) {
  const limits = {
    maxFrameChars: props.maxFrameChars ?? 8 * 1024 * 1024,
    logPreviewChars: props.logPreviewChars ?? 2000,
  }
  for (const entry of [
    { name: "maxFrameChars", value: limits.maxFrameChars },
    { name: "logPreviewChars", value: limits.logPreviewChars },
  ])
    if (!Number.isSafeInteger(entry.value) || entry.value < 64)
      throw new Error(`${entry.name} must be an integer >= 64`)
  return limits
}
