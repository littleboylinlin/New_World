import type { PopupRect } from './model'

export interface InlineAnchor { id: string; rect: PopupRect }
export interface InlinePlacement { ids: string[]; rect: PopupRect; anchor: PopupRect; compact: boolean }
const intersects = (a: PopupRect, b: PopupRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/** Use only existing whitespace. Close endpoints share a marker instead of stacking. */
export function inlinePlacements(anchors: InlineAnchor[], text: PopupRect[], bounds: PopupRect): InlinePlacement[] {
  const rows: InlineAnchor[][] = []
  for (const anchor of [...anchors].filter((item) => item.rect.right >= bounds.left && item.rect.left <= bounds.right).sort((a, b) => a.rect.top - b.rect.top || a.rect.right - b.rect.right || a.id.localeCompare(b.id))) {
    const row = rows.find((entries) => Math.abs(entries[0].rect.top - anchor.rect.top) < 2)
    if (row) row.push(anchor)
    else rows.push([anchor])
  }
  const placed: InlinePlacement[] = []
  for (const row of rows) {
    const groups: { ids: string[]; anchor: PopupRect; left: number }[] = []
    for (const item of row) {
      const left = Math.max(bounds.left, Math.min(item.rect.right - 8, bounds.right - 12))
      const previous = groups.at(-1)
      if (previous && left - previous.left < 28) previous.ids.push(item.id)
      else groups.push({ ids: [item.id], anchor: item.rect, left })
    }
    for (const [i, group] of groups.entries()) {
      const right = Math.min(bounds.right, group.left + 200, (groups[i + 1]?.left ?? bounds.right + 4) - 4)
      const width = right - group.left
      if (width < 8) continue
      let result: InlinePlacement | undefined
      for (const height of [12, 4]) {
        for (const top of [group.anchor.top - height - 1, group.anchor.bottom + 1]) {
          const rect = { left: group.left, right, top, bottom: top + height }
          if (top < bounds.top || rect.bottom > bounds.bottom || text.some((glyph) => intersects(rect, glyph))
            || placed.some((item) => intersects(rect, item.rect))) continue
          result = { ids: group.ids, rect, anchor: group.anchor, compact: height < 12 || width < 30 }
          break
        }
        if (result) break
      }
      if (result) placed.push(result)
      else {
        // A neighboring marker in this same gap can represent all owners without overlap.
        const neighbor = placed.find((item) => Math.abs(item.anchor.top - group.anchor.top) < 2 && Math.abs(item.anchor.right - group.anchor.right) < 40)
        if (neighbor) neighbor.ids.push(...group.ids)
      }
    }
  }
  return placed
}
