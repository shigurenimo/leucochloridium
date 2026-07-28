export type LeucoEventQuery = {
  sinceSeq?: number
  type?: string
  project?: string
  limit?: number
  order?: "asc" | "desc"
}
