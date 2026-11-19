import { t } from './i18n'
import { appearanceMenu } from './appearance-view'
import { parseSourceRoute } from './documents/compare'
import { referencePane } from './documents/reference-pane'
import { selectionToolbar } from './documents/selection-toolbar'
import { openCaptureDialog } from './idea-capture'
import { lastWork } from './ideas'
import { fixedPage } from './shell/fixed-page'
import { menuButton } from './shell/popover'
import { button, element, notice } from './ui'
import './documents/editor.css'

// A separate desktop window that shows one reference on its own: the same pane, places and
// appearance as a pane beside the text, with a slim bar for its name, chapters and Aa.

const source = parseSourceRoute(location.hash)
document.documentElement.classList.add('reading-window')
const main = element('main', 'main-content reading-window-main')
document.body.replaceChildren(main)
const signal = new AbortController().signal
fixedPage(main, signal)

if (!source) {
  main.append(notice(t('compare.missing'), true))
} else {
  const page = element('section', 'reading-window-page')
  const bar = element('header', 'editor-toolbar reading-window-bar')
  const row = element('div', 'toolbar-row')
  const names = element('div', 'toolbar-title')
  const name = element('span', 'toolbar-name work-name toolbar-name-text')
  const chapter = button('', 'toolbar-name chapter-name')
  const chapterText = element('span', 'toolbar-name-text')
  chapter.append(chapterText, element('span', 'dropdown-caret', '▾'))
  const line = element('div', 'toolbar-names')
  line.append(name, element('span', 'toolbar-name-separator', '/'), chapter)
  names.append(line, element('div', 'toolbar-status', t('compare.readOnly')))
  const spacer = element('div', 'reading-window-spacer')
  row.append(names, spacer, appearanceMenu())
  const strip = element('div')
  bar.append(row, strip)
  const pane = referencePane({
    source, signal,
    menu: () => [],
    onChange: () => {
      name.textContent = pane.title()
      chapterText.textContent = pane.part()
      chapter.disabled = pane.chapters().length < 2
      document.title = t('window.title', [pane.part() || pane.title(), pane.title()])
    },
  })
  // The window has no corner menu; switching chapters lives under the chapter's name.
  pane.element.querySelector('.pane-corner')?.remove()
  menuButton(chapter, t('editor.switchChapter'), () => {
    const current = pane.source()
    return pane.chapters().map(({ id, title }, index) => ({
      label: `${String(index + 1).padStart(2, '0')}  ${title}`, radio: true, checked: current.kind === 'chapter' && current.chapterId === id,
      action: () => { void pane.switchChapter(id) },
    }))
  }, 'chapter-menu')
  page.append(bar, pane.element)
  main.append(page)
  selectionToolbar({
    strip, signal,
    targets: () => {
      const root = pane.textRoot()
      return root ? [{ root, scroller: pane.scroller, editor: pane.editor(), editing: false, kinds: ['idea'] }] : []
    },
    actions: { bold: () => {}, italic: () => {}, task: () => {}, annotate: () => {}, idea: (text) => openCaptureDialog(lastWork(), text) },
  })
  window.addEventListener('pagehide', () => pane.capture())
  document.addEventListener('visibilitychange', () => { if (document.hidden) pane.capture() })
}
