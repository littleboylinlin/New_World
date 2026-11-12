import { t } from '../i18n'
export const exportStyles = {
  standard: { label: t('exportStyle.standard'), fontPt: 13, lineHeight: 1.95, paragraphGap: 1, marginMm: 18 },
  compact: { label: t('exportStyle.compact'), fontPt: 11, lineHeight: 1.6, paragraphGap: .65, marginMm: 15 },
  spacious: { label: t('exportStyle.spacious'), fontPt: 14, lineHeight: 2.15, paragraphGap: 1.15, marginMm: 24 },
} as const

export type ExportStyle = keyof typeof exportStyles
export type ExportPreset = typeof exportStyles[ExportStyle]

export const a4 = { width: 210, height: 297 }
export const headingScales = [1.8, 1.42, 1.23, 1.1, 1, 1]
export const headingLayout = { lineHeight: 1.4, before: .7, after: .45 }

export function applyExportStyle(paper: HTMLElement, preset: ExportPreset) {
  paper.style.setProperty('--export-font-size', preset.fontPt + 'pt')
  paper.style.setProperty('--export-line-height', String(preset.lineHeight))
  paper.style.setProperty('--export-paragraph-gap', preset.paragraphGap + 'em')
  paper.style.setProperty('--export-margin', preset.marginMm + 'mm')
  paper.style.setProperty('--export-image-height', (a4.height - 2 * preset.marginMm - 18) + 'mm')
  paper.style.setProperty('--export-heading-line-height', String(headingLayout.lineHeight))
  paper.style.setProperty('--export-heading-before', headingLayout.before + 'em')
  paper.style.setProperty('--export-heading-after', headingLayout.after + 'em')
  headingScales.forEach((scale, index) => {
    paper.style.setProperty('--export-h' + (index + 1), scale + 'em')
  })
}

export function printPageStyle(preset: ExportPreset) {
  return '@page { size: A4; margin: ' + preset.marginMm + 'mm; }'
}
