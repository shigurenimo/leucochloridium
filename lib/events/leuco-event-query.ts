export type LeucoEventQuery = {
  sinceTs?: number
  requestId?: string
  sinceSeq?: number
  type?: string
  runtime?: string
  limit?: number
  order?: "asc" | "desc"
}
