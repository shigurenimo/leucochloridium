import { useState } from "react"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type TreeNode = {
  id: string
  label: string
  children?: TreeNode[]
}

export type Props = {
  nodes: TreeNode[]
  indent?: number
}

type Row = {
  node: TreeNode
  prefix: string
}

type RowProps = {
  row: Row
}

/** Internal row used by HasciiTree. Hover-only background; no click handler. */
function HasciiTreeRow(props: RowProps) {
  const theme = useHasciiTheme()

  const hoveredState = useState(false)
  const isHovered = hoveredState[0]
  const setHovered = hoveredState[1]

  const bg = isHovered ? theme.color.secondaryHover : undefined

  return (
    <box
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      height={1}
      backgroundColor={bg}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={theme.color.mutedForeground}>{props.row.prefix}</text>
      <text fg={theme.color.foreground}>{props.row.node.label}</text>
    </box>
  )
}

const buildSegment = (
  kind: "ancestor-bar" | "ancestor-blank" | "tee" | "elbow",
  indent: number,
): string => {
  const head =
    kind === "ancestor-bar" ? "│" : kind === "ancestor-blank" ? " " : kind === "tee" ? "├" : "└"
  const tail =
    kind === "tee" || kind === "elbow"
      ? "─".repeat(Math.max(0, indent - 1))
      : " ".repeat(Math.max(0, indent - 1))
  return `${head}${tail}`
}

const flatten = (nodes: TreeNode[], ancestorsAreLast: boolean[], indent: number): Row[] => {
  const rows: Row[] = []

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node === undefined) continue

    const isLast = index === nodes.length - 1

    let prefix = ""
    for (const isAncestorLast of ancestorsAreLast) {
      prefix += buildSegment(isAncestorLast ? "ancestor-blank" : "ancestor-bar", indent)
    }
    prefix += buildSegment(isLast ? "elbow" : "tee", indent)
    prefix += " "

    rows.push({ node, prefix })

    if (node.children && node.children.length > 0) {
      const childRows = flatten(node.children, [...ancestorsAreLast, isLast], indent)
      for (const childRow of childRows) rows.push(childRow)
    }
  }

  return rows
}

/** Static read-only file-tree drawn with ├/└/│ box-drawing characters. Hover highlights a row but rows are not clickable. */
export function HasciiTree(props: Props) {
  const indent = props.indent ?? 2

  const rows = flatten(props.nodes, [], indent)

  return (
    <box flexDirection="column">
      {rows.map((row) => (
        <HasciiTreeRow key={row.node.id} row={row} />
      ))}
    </box>
  )
}
