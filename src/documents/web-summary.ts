import { ai } from '../ai-provider'
import type { AiError, AiRun } from '../ai-provider'
import { aiSettingsHash, requireAi } from '../ai/access'
import { describeAiError } from '../ai/errors'
import { wasTruncated } from '../ai/prompts'
import { locale, t } from '../i18n'
import type { LibraryId } from '../library'
import { showNotice } from '../undo'
import { button, element } from '../ui'
import { keepFromWeb } from './web-keep'
import './web-summary.css'

export const webSummaryFeature = 'extension:webSummary' as const
/** Without a known context size, this much of a page is sent. */
const defaultLimit = 12000

export interface WebSummaryEntry { scope: 'selection' | 'page'; text: string; title: string; url: string }

function messages(entry: WebSummaryEntry, text: string, cut: boolean) {
  const zh = locale === 'zh-CN'
  const system = zh
    ? '你是小说作者的资料助手。概括用户提供的网页内容里对写作有用的信息：要点、事实、人物、地点和时间、可以借鉴的细节。分条列出，简洁准确；只依据给出的文字，不要编造其中没有的内容。'
    : "You are a novelist's research assistant. Summarise what in the given web text is useful for writing: key points, facts, people, places and dates, and details worth borrowing. Use concise bullet points, and rely only on the given text without inventing anything."
  const head = zh
    ? `${entry.title ? `网页标题：${entry.title}\n` : ''}${entry.scope === 'selection' ? '以下是网页上选中的一段' : '以下是网页正文'}${cut ? '（只是开头部分）' : ''}：`
    : `${entry.title ? `Page title: ${entry.title}\n` : ''}${entry.scope === 'selection' ? 'A passage selected on the page' : 'The page text'}${cut ? ' (its opening only)' : ''}:`
  return [{ role: 'system' as const, text: system }, { role: 'user' as const, text: `${head}\n\n${text}` }]
}

/**
 * Summarises text from a web pane and offers to keep the summary as an idea or a task of the work,
 * through the same dialog as keeping selected text (which asks whether to add the link). Only the
 * text of the page the writer asked about is sent, and only now.
 */
export async function summarizeWeb(entry: WebSummaryEntry, work: { library: LibraryId; bookId: string; title: string }) {
  if (!entry.text.trim()) return
  const profile = await requireAi(webSummaryFeature)
  if (!profile) return
  const contextTokens = profile.config.generation?.contextTokens
  const limit = contextTokens ? Math.max(2000, Math.min(60000, Math.floor(contextTokens * 0.6))) : defaultLimit
  const cut = entry.text.length > limit
  const text = cut ? entry.text.slice(0, limit) : entry.text

  const dialog = element('dialog', 'manage-dialog web-summary-dialog')
  const form = element('form', 'manage-form')
  form.method = 'dialog'
  const heading = element('h2', '', entry.scope === 'selection' ? t('web.summarizeSelection') : t('web.summarizePage'))
  heading.id = `web-summary-${crypto.randomUUID()}`
  dialog.setAttribute('aria-labelledby', heading.id)
  const source = element('p', 'dialog-help', entry.title ? t('web.from', [entry.title]) : t('web.untitled'))
  const sent = element('p', 'dialog-help web-summary-sent', cut ? t('webSummary.sentCut', [text.length, entry.text.length, profile.config.name]) : t('webSummary.sent', [text.length, profile.config.name]))
  const output = element('div', 'web-summary-output')
  output.setAttribute('aria-live', 'polite')
  const status = element('p', 'web-summary-status')
  status.setAttribute('role', 'status')
  const controls = element('div', 'dialog-controls web-summary-controls')
  form.append(heading, source, sent, output, status, controls)
  dialog.append(form)
  document.body.append(dialog)

  let run: AiRun | undefined
  let summary = ''
  const control = (label: string, act: () => void, primary = false) => {
    const node = button(label, primary ? 'button button-primary' : 'button button-quiet')
    node.addEventListener('click', (event) => { event.preventDefault(); act() })
    return node
  }
  const close = () => dialog.close()
  dialog.addEventListener('close', () => { run?.cancel(); dialog.remove() }, { once: true })

  /** Hands the summary to the keep dialog, which asks whether to add the page's address. */
  const keep = (kind: 'idea' | 'task') => {
    const passage = { text: summary.trim(), title: entry.title, url: entry.url }
    dialog.close()
    keepFromWeb(kind, passage, work)
  }

  async function start() {
    summary = ''
    output.textContent = ''
    output.classList.add('web-summary-streaming')
    status.className = 'web-summary-status'
    status.textContent = t('aiAssist.waiting')
    const stop = control(t('aiAssist.stop'), () => run?.cancel())
    controls.replaceChildren(stop)
    const live = ai.generate({ feature: webSummaryFeature, profileId: profile!.id, messages: messages(entry, text, cut) })
    run = live
    let failure: AiError | undefined
    let stopped = false
    let finishReason: string | undefined
    try {
      for await (const event of live.events) {
        if (event.type === 'delta') { summary += event.text; output.textContent = summary; status.textContent = t('aiAssist.writing') }
        else if (event.type === 'done') { summary = event.text; finishReason = event.finishReason }
        else if (event.type === 'cancelled') stopped = true
        else failure = event.error
      }
    } catch (cause) {
      failure = { code: 'network', message: cause instanceof Error ? cause.message : String(cause) }
    }
    if (!dialog.open || run !== live) return
    run = undefined
    output.classList.remove('web-summary-streaming')
    output.textContent = summary
    const again = control(t('aiAssist.retry'), () => { void start() })
    if (failure) {
      status.className = 'web-summary-status field-error'
      status.textContent = [describeAiError(failure), failure.message && failure.message !== describeAiError(failure) ? failure.message : ''].filter(Boolean).join(' ')
      controls.replaceChildren(control(t('common.close'), close), control(t('aiAccess.openSettings'), () => { close(); location.hash = aiSettingsHash }), again)
      return
    }
    if (stopped || !summary.trim()) {
      status.textContent = stopped ? t('aiAssist.stopped') : t('aiAssist.noChanges')
      controls.replaceChildren(control(t('common.close'), close), again)
      return
    }
    status.textContent = wasTruncated(finishReason) ? t('aiAssist.truncatedAnswer') : ''
    const copy = control(t('aiAssist.copy'), () => {
      void navigator.clipboard?.writeText(summary).then(() => showNotice(t('aiAssist.copied')), () => showNotice(t('aiAssist.copyFailed')))
    })
    controls.replaceChildren(control(t('common.close'), close), again, copy, control(t('web.toTask'), () => keep('task')), control(t('web.toIdea'), () => keep('idea'), true))
  }

  dialog.showModal()
  void start()
}
