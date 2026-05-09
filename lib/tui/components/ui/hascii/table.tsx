import { useHasciiTheme } from "@/tui/utils/hascii/theme-context"

export type TableColumn = {
  key: string
  label: string
  width?: number
  align?: "left" | "right"
}

export type TableRow = Record<string, string | number>

export type Props = {
  columns: TableColumn[]
  rows: TableRow[]
  selectedIndex?: number
  onSelect?: (index: number) => void
}

const padCell = (text: string, width: number, align: "left" | "right"): string => {
  const truncated = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
  const pad = " ".repeat(Math.max(0, width - truncated.length))
  return align === "right" ? `${pad}${truncated}` : `${truncated}${pad}`
}

const resolveColumnWidth = (column: TableColumn, rows: TableRow[]): number => {
  if (column.width !== undefined) return column.width

  let width = column.label.length

  for (const row of rows) {
    const value = String(row[column.key] ?? "")
    if (value.length > width) width = value.length
  }

  return width
}

/** Static row/column table. Cell text is padded to the column width; rows are clickable when onSelect is provided. */
export function HasciiTable(props: Props) {
  const theme = useHasciiTheme()

  const widths = props.columns.map((column) => resolveColumnWidth(column, props.rows))

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1} height={1}>
        {props.columns.map((column, columnIndex) => (
          <text key={column.key} fg={theme.color.mutedForeground}>
            {padCell(column.label, widths[columnIndex] ?? column.label.length, column.align ?? "left")}
          </text>
        ))}
      </box>
      <box flexDirection="row" paddingLeft={1} paddingRight={1} height={1}>
        <text fg={theme.color.border}>
          {"─".repeat(
            widths.reduce((sum, width) => sum + width, 0) +
              Math.max(0, props.columns.length - 1) * 2,
          )}
        </text>
      </box>
      {props.rows.map((row, rowIndex) => {
        const isSelected = props.selectedIndex === rowIndex
        const rowBg = isSelected ? theme.color.secondaryActive : undefined
        const rowFg = isSelected ? theme.color.foreground : theme.color.foreground

        return (
          <box
            key={`row-${rowIndex}`}
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            paddingRight={1}
            height={1}
            backgroundColor={rowBg}
            onMouseUp={props.onSelect !== undefined ? () => props.onSelect?.(rowIndex) : undefined}
          >
            {props.columns.map((column, columnIndex) => (
              <text key={column.key} fg={rowFg}>
                {padCell(
                  String(row[column.key] ?? ""),
                  widths[columnIndex] ?? 0,
                  column.align ?? "left",
                )}
              </text>
            ))}
          </box>
        )
      })}
    </box>
  )
}
