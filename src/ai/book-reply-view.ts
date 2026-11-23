import { t } from '../i18n'
import { button, element } from '../ui'
import { showNotice } from '../undo'
import type { ContextChapter, ContextSources } from './book-chat-model'
import type { Clarification } from './clarification'

export async function copyReply(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    showNotice(t('aiAssist.copied'))
  } catch {
    showNotice(t('aiAssist.copyFailed'))
  }
}

export function readableReply(answer: { text: string; questions?: Clarification[] }) {
  return [answer.text, ...(answer.questions ?? []).map(({ question, options }) => [question, ...options.map((option) => '• ' + option)].join('\n'))]
    .filter(Boolean).join('\n\n')
}

/** Multiple questions share one submit, so the next turn receives the whole round together. */
export function clarificationView(questions: readonly Clarification[], answer: (text: string) => void) {
  const list = element('div', 'ai-clarification')
  const chosen = new Map<Clarification, string>()
  function submit() {
    if (chosen.size !== questions.length) return
    answer(questions.map((item) => `${item.question}\n${chosen.get(item)}`).join('\n\n'))
  }
  const send = button(t('aiChat.sendChoices'), 'button button-primary button-small')
  send.disabled = true
  send.addEventListener('click', submit)
  for (const item of questions) {
    const group = element('fieldset', 'ai-clarification-group')
    group.append(element('legend', '', item.question))
    const choices = element('div', 'ai-clarification-choices')
    const nodes = item.options.map((option) => {
      const node = button(option, 'button button-quiet button-small ai-clarification-choice')
      if (questions.length > 1) node.setAttribute('aria-pressed', 'false')
      node.addEventListener('click', () => {
        chosen.set(item, option)
        if (questions.length === 1) { submit(); return }
        for (const other of nodes) other.setAttribute('aria-pressed', String(other === node))
        send.disabled = chosen.size !== questions.length
      })
      return node
    })
    choices.append(...nodes)
    group.append(choices)
    list.append(group)
  }
  if (questions.length > 1) list.append(send)
  return list
}

const chapterNumbers = (chapter: ContextChapter) => t('aiContext.chapterNumber', [chapter.number])
const chapterLabel = (chapter: ContextChapter) => t('aiContext.chapterTitle', [chapter.number, chapter.title])

export function contextDetails(sources: ContextSources) {
  const node = element('details', 'ai-context-details')
  const counts = [
    sources.current ? chapterNumbers(sources.current) : '',
    sources.cards.length ? t('aiContext.cardCount', [sources.cards.length]) : '',
    sources.bookSummary ? t('aiContext.bookSummary') : '',
    sources.summaries.length ? t('aiContext.summaryCount', [sources.summaries.length]) : '',
    sources.excerpts.length ? t('aiContext.excerptCount', [sources.excerpts.length]) : '',
  ].filter(Boolean)
  const title = counts.join(' · ') || t('aiContext.empty')
  node.append(element('summary', '', title))
  const list = element('ul')
  function add(key: string, value?: string) {
    list.append(element('li', '', t(key, value === undefined ? undefined : [value])))
  }
  if (sources.current) add('aiContext.currentDetails', chapterLabel(sources.current))
  if (sources.selectedText) add('aiContext.selection')
  if (sources.cards.length) add('aiContext.cardsDetails', sources.cards.join(t('story.nameSeparator')))
  if (sources.bookSummary) add('aiContext.bookSummary')
  if (sources.summaries.length) add('aiContext.summariesDetails', sources.summaries.map(chapterLabel).join(t('story.nameSeparator')))
  if (sources.excerpts.length) add('aiContext.excerptsDetails', sources.excerpts.map(chapterLabel).join(t('story.nameSeparator')))
  if (sources.clipped) add('aiContext.clipped')
  if (list.childElementCount) node.append(list)
  return node
}
