import { validateWorkMetadata } from '../work-metadata'
import type { WorkMetadata } from '../work-metadata'
import { element } from '../ui'
import { t } from '../i18n'

export interface WorkExportSource { title: string; metadata?: WorkMetadata }
export interface WorkExportSelection { title: boolean; author: boolean; synopsis: boolean }
export interface ExportWorkInfo { title?: string; subtitle?: string; author?: string; synopsis?: string }

export function selectedWorkInfo(work: WorkExportSource, selection: WorkExportSelection): ExportWorkInfo | undefined {
  if (work.metadata !== undefined) validateWorkMetadata(work.metadata)
  const result: ExportWorkInfo = {
    ...(selection.title ? { title: work.title, ...(work.metadata?.subtitle ? { subtitle: work.metadata.subtitle } : {}) } : {}),
    ...(selection.author && work.metadata?.author ? { author: work.metadata.author } : {}),
    ...(selection.synopsis && work.metadata?.synopsis ? { synopsis: work.metadata.synopsis } : {}),
  }
  return Object.keys(result).length ? result : undefined
}
export function workInfoText(info?: ExportWorkInfo) {
  if (!info) return ''
  return [info.title, info.subtitle, info.author ? t('work.author') + ': ' + info.author : undefined,
    info.synopsis ? t('work.synopsis') + '\n\n' + info.synopsis : undefined].filter((part) => part !== undefined).join('\n\n')
}
export function workInfoSection(info?: ExportWorkInfo) {
  if (!info || !Object.values(info).some(Boolean)) return undefined
  const section = element('section', 'export-work-info')
  if (info.title) section.append(element('h1', 'export-work-title', info.title))
  if (info.subtitle) section.append(element('p', 'export-work-subtitle', info.subtitle))
  if (info.author) section.append(element('p', 'export-work-author', t('work.author') + ': ' + info.author))
  if (info.synopsis) {
    const text = element('p', 'export-work-synopsis')
    info.synopsis.split(/\r\n|\r|\n/).forEach((line, index) => { if (index) text.append(element('br')); text.append(document.createTextNode(line)) })
    section.append(element('h2', '', t('work.synopsis')), text)
  }
  return section
}
