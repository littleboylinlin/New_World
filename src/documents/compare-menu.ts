// The library as a menu of things to read beside the text: work → version → chapter, with each
// work's original files after its versions. The editor's "read beside" menu and a reading
// window's "switch" menu share it, so both list the same things in the same order.

import { t } from '../i18n'
import type { ShellMenuItem } from '../shell/popover'
import type { CatalogWork, ReferenceSource } from './compare'
import type { Edition } from './model'

/** The chapter being edited: it is shown, marked, and cannot be picked. */
export interface CompareHere { library: string; bookId: string; editionId: string; chapterId: string }

export const isOwnWork = (work: CatalogWork, here: CompareHere | undefined) =>
  Boolean(here && work.book.library === here.library && work.book.id === here.bookId)

/** Works with something to read, this work first. */
export function readableWorks(catalog: CatalogWork[], here: CompareHere | undefined) {
  const readable = catalog.filter((work) => work.editions.some((item) => item.chapters.length) || work.files.length)
  return [...readable.filter((work) => isOwnWork(work, here)), ...readable.filter((work) => !isOwnWork(work, here))]
}

/** Versions with chapters, the one being edited first. */
export function readableEditions(work: CatalogWork, here: CompareHere | undefined) {
  const editions = work.editions.filter((item) => item.chapters.length)
  return [...editions.filter((item) => item.id === here?.editionId), ...editions.filter((item) => item.id !== here?.editionId)]
}

export const chapterNumber = (index: number) => String(index + 1).padStart(2, '0')

export function sourceMenu(catalog: CatalogWork[], here: CompareHere | undefined, pick: (source: ReferenceSource) => void, current?: ReferenceSource): ShellMenuItem[] {
  const same = (source: ReferenceSource) => Boolean(current && JSON.stringify(current) === JSON.stringify(source))
  const chapters = (edition: Edition): ShellMenuItem[] => edition.chapters.map(({ id, title }, index) => {
    const source: ReferenceSource = { kind: 'chapter', library: edition.library, bookId: edition.bookId, editionId: edition.id, chapterId: id }
    const editing = here?.editionId === edition.id && here.chapterId === id
    return {
      label: `${chapterNumber(index)}  ${title}`,
      hint: editing ? t('compare.editing') : undefined,
      disabled: editing,
      ...(current ? { radio: true, checked: same(source) } : {}),
      action: () => pick(source),
    }
  })
  const work = (item: CatalogWork): ShellMenuItem[] => {
    const editions = readableEditions(item, here)
    const items: ShellMenuItem[] = editions.length === 1
      ? chapters(editions[0])
      : editions.map((edition) => ({
        label: edition.name, icon: 'copy' as const,
        hint: edition.id === here?.editionId ? t('compare.currentVersion') : t('compare.chapterCount', [edition.chapters.length]),
        children: () => chapters(edition),
      }))
    for (const file of item.files) {
      const source: ReferenceSource = { kind: 'file', library: file.library, bookId: file.id }
      items.push({ label: file === item.book ? t('compare.originalFile') : file.title, icon: 'file', ...(current ? { radio: true, checked: same(source) } : {}), action: () => pick(source) })
    }
    return items
  }
  const works = readableWorks(catalog, here)
  if (!works.length) return [{ label: t('compare.empty'), disabled: true }]
  const items: ShellMenuItem[] = []
  for (const [index, item] of works.entries()) {
    const own = isOwnWork(item, here)
    items.push({ label: item.book.title, icon: 'book', hint: own ? t('compare.thisWork') : undefined, children: () => work(item) })
    if (own && index < works.length - 1) items.push({ separator: true, label: '' })
  }
  return items
}
