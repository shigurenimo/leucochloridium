import type { FlumeCron } from "@interactive-inc/flume/time"
import { flumeCollectCatchupMatches } from "@interactive-inc/flume/time"

type Props = {
  cron: FlumeCron
  lastFiredAt: number
  now: number
  maxWindowMs: number
}

export function latestScheduleCatchup(props: Props): number | null {
  const collected = flumeCollectCatchupMatches({
    cron: props.cron,
    lastFiredAt: props.lastFiredAt,
    now: props.now,
    policy: { mode: "missed", maxWindowMs: props.maxWindowMs },
  })

  if (collected instanceof Error) return null

  return collected.matches[collected.matches.length - 1] ?? null
}
