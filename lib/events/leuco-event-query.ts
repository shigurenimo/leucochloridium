export type LeucoEventQuery = {
  sinceSeq?: number
  type?: string
  runtime?: string
  limit?: number
  order?: "asc" | "desc"
}
