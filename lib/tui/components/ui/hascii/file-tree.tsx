import { useState } from "react"
import type { HasciiTheme } from "@/tui/utils/hascii/theme"
import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"
import { usePressable } from "@/tui/components/hooks/hascii/use-pressable"

export type FileTreeNode = {
  id: string
  label: string
  children?: FileTreeNode[]
}

export type Props = {
  nodes: FileTreeNode[]
  indent?: number
  defaultExpanded?: string[]
  expanded?: string[]
  onToggle?: (id: string, isOpen: boolean) => void
  selectedId?: string | null
  onSelect?: (id: string) => void
}

type Row = {
  node: FileTreeNode
  depth: number
  hasChildren: boolean
  isOpen: boolean
}

type RowProps = {
  row: Row
  indent: number
  isSelected: boolean
  onPress: () => void
}

const pickRowBg = (
  isActive: boolean,
  isHovered: boolean,
  isPressed: boolean,
  theme: HasciiTheme,
): string | undefined => {
  if (isPressed) return theme.color.secondaryActive
  if (isHovered && isActive) return theme.color.hoverActive
  if (isHovered) return theme.color.secondaryHover
  if (isActive) return theme.color.secondaryActive
  return undefined
}

/** Internal row used by HasciiFileTree. Tracks the standard hover/active palette and renders ▾/▸ for folders. */
function HasciiFileTreeRow(props: RowProps) {
  const theme = useHasciiTheme()
  const press = usePressable({ onPress: props.onPress })

  const bg = pickRowBg(props.isSelected, press.isHovered, press.isPressed, theme)

  const indentText = " ".repeat(props.row.depth * props.indent)
  const marker = !props.row.hasChildren ? " " : props.row.isOpen ? "▾" : "▸"

  return (
    <box
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      height={1}
      backgroundColor={bg}
      {...press.bind}
    >
      <text fg={theme.color.mutedForeground}>{indentText}</text>
      <text fg={theme.color.mutedForeground}>{marker} </text>
      <text fg={theme.color.foreground}>{props.row.node.label}</text>
    </box>
  )
}

const flatten = (nodes: FileTreeNode[], depth: number, openSet: Set<string>): Row[] => {
  const rows: Row[] = []

  for (const node of nodes) {
    const hasChildren = (node.children?.length ?? 0) > 0
    const isOpen = openSet.has(node.id)

    rows.push({ node, depth, hasChildren, isOpen })

    if (hasChildren && isOpen) {
      const childRows = flatten(node.children ?? [], depth + 1, openSet)
      for (const childRow of childRows) rows.push(childRow)
    }
  }

  return rows
}

/** Indented IDE-style file tree. Folder rows show ▾/▸ and toggle on click; leaf rows just select. */
export function HasciiFileTree(props: Props) {
  const indent = props.indent ?? 2

  const internalState = useState<string[]>(props.defaultExpanded ?? [])
  const internalOpen = internalState[0]
  const setInternalOpen = internalState[1]

  const expanded = props.expanded ?? internalOpen
  const openSet = new Set(expanded)

  const selectedState = useState<string | null>(props.selectedId ?? null)
  const internalSelected = selectedState[0]
  const setInternalSelected = selectedState[1]

  const selected = props.selectedId !== undefined ? props.selectedId : internalSelected

  const toggle = (id: string) => {
    const isOpen = openSet.has(id)
    const next = isOpen ? expanded.filter((entry) => entry !== id) : [...expanded, id]

    if (props.expanded === undefined) setInternalOpen(next)
    props.onToggle?.(id, !isOpen)
  }

  const select = (id: string) => {
    if (props.selectedId === undefined) setInternalSelected(id)
    props.onSelect?.(id)
  }

  const rows = flatten(props.nodes, 0, openSet)

  return (
    <box flexDirection="column">
      {rows.map((row) => (
        <HasciiFileTreeRow
          key={row.node.id}
          row={row}
          indent={indent}
          isSelected={row.node.id === selected}
          onPress={() => {
            select(row.node.id)
            if (row.hasChildren) toggle(row.node.id)
          }}
        />
      ))}
    </box>
  )
}
