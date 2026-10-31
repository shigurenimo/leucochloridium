export type LeucoEventQuery = {
  sinceTs?: number
  requestId?: string
  sinceSeq?: number
  type?: string
  summary?: boolean
  /** Non-negative safe integer; zero selects no entries. */
  limit?: number
  order?: "asc" | "desc"
}
