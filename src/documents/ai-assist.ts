import type { Editor } from '@tiptap/core'
import { Mapping } from '@tiptap/pm/transform'
import type { Transaction } from '@tiptap/pm/state'
import { ai } from '../ai-provider'
import type { AiError, AiRun, SavedProfile } from '../ai-provider'
import { aiSettingsHash, requireAi } from '../ai/access'
import { describeAiError } from '../ai/errors'
import { assistFeatures, assistMessages, editingActions, wasTruncated } from '../ai/prompts'
import type { AssistAction, Tone } from '../ai/prompts'
import { t } from '../i18n'
import { afterTransition } from '../motion'
import { setExpanded } from '../shell/collapse'
import type { ShellMenuItem } from '../shell/popover'
import { visibleArea } from '../shell/popover'
import { showNotice } from '../undo'
import { button, element, icon } from '../ui'
import {
  acceptAll, acceptSuggestion, blocksText, clearSuggestions, currentSuggestions, insertParagraphsAfter,
  readBlocks, rejectSuggestion, replyParagraphs, showSuggestions, suggestionsFor,
} from './ai-suggest'
import type { TextBlock } from './ai-suggest'
import './ai-assist.css'

const tones: Tone[] = ['formal', 'casual', 'gentle', 'cold', 'humorous', 'tense']
const settingsCodes = new Set(['unauthorized', 'forbidden', 'not_configured', 'invalid_config', 'cors', 'network', 'quota_exceeded', 'timeout'])

export interface AssistOptions {
  editor: () => Editor
  editing: () => boolean
  /** The pane the panel centres on. */
  area: () => HTMLElement
  /**
   * Runs once per panel before its first change to the text: the editor saves, and the chapter as
   * it was is kept in its history.
   */
  beforeChange: (input: { action: AssistAction; profile: SavedProfile }) => Promise<void>
  signal: AbortSignal
}

interface Session {
  action: AssistAction
  tone?: Tone
  question?: string
  blocks: TextBlock[]
  /** The selection as it moves with edits made while the panel is open. */
  from: number
  to: number
  /** Positions of the request mapped to now, for the reply's suggestions. */
  mapping: Mapping
  /** The selected text was edited after the request, so its suggestions no longer fit. */
  touched: boolean
  profile?: SavedProfile
  run?: AiRun
  reply: string
  prepared: boolean
  accepted: number
}

/**
 * Asking AI about selected text: the actions offered by the selection tools, and the panel that
 * streams the reply and lets the user take its changes whole, one by one, or as new paragraphs.
 */
export function aiAssist(options: AssistOptions) {
  const panel = element('section', 'ai-assist')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'false')
  panel.hidden = true
  panel.dataset.state = 'closed'
  const head = element('div', 'ai-assist-head')
  const title = element('h2', 'ai-assist-title')
  title.id = `ai-assist-title-${crypto.randomUUID()}`
  panel.setAttribute('aria-labelledby', title.id)
  const via = element('span', 'ai-assist-via')
  const close = button('', 'ai-assist-close', 'close')
  close.setAttribute('aria-label', t('common.close'))
  head.append(icon('ai'), title, via, close)

  const ask = element('form', 'ai-assist-ask')
  const question = element('textarea', 'title-input ai-assist-question')
  question.rows = 2
  question.placeholder = t('aiAssist.askPlaceholder')
  question.setAttribute('aria-label', t('aiAssist.askLabel'))
  const send = button(t('aiAssist.send'), 'button button-primary button-small')
  send.type = 'submit'
  ask.append(question, send)

  const output = element('div', 'ai-assist-output')
  output.setAttribute('aria-live', 'polite')
  const outputText = element('p', 'ai-assist-text')
  output.append(outputText)
  const message = element('div', 'ai-assist-message')
  message.setAttribute('role', 'status')
  const actions = element('div', 'ai-assist-actions')
  panel.append(head, ask, output, message, actions)
  document.body.append(panel)

  let session: Session | undefined
  let stopListening: (() => void) | undefined
  let finish: (() => void) | undefined

  // ——— Placement and opening ———
  function place() {
    if (panel.hidden) return
    const area = visibleArea()
    const pane = options.area().getBoundingClientRect()
    const left = Math.max(area.left, pane.left)
    const right = Math.min(area.right, pane.right)
    const width = Math.min(560, right - left - 24)
    panel.style.width = `${Math.max(240, width)}px`
    panel.style.left = `${Math.round(left + (right - left - panel.offsetWidth) / 2)}px`
    panel.style.bottom = `${Math.round(innerHeight - Math.min(area.bottom, pane.bottom) + 16)}px`
  }
  window.addEventListener('resize', place, { signal: options.signal })
  window.visualViewport?.addEventListener('resize', place, { signal: options.signal })

  function openPanel() {
    finish?.()
    if (!panel.hidden && panel.dataset.state === 'open') return
    panel.hidden = false
    panel.dataset.state = 'closed'
    place()
    void panel.offsetWidth
    panel.dataset.state = 'open'
  }

  function closePanel() {
    session?.run?.cancel()
    stopListening?.()
    stopListening = undefined
    const editor = options.editor()
    if (editor && !editor.isDestroyed) clearSuggestions(editor.view)
    session = undefined
    if (panel.hidden) return
    panel.dataset.state = 'closing'
    finish = afterTransition(panel, 'fast', () => {
      finish = undefined
      if (panel.dataset.state === 'closing') { panel.hidden = true; panel.dataset.state = 'closed' }
    })
  }
  /**
   * Returns to the text with the caret after what was selected. Focus alone can leave the editor
   * believing the old selection is still drawn while the page shows none.
   */
  function backToText() {
    const editor = options.editor()
    if (!editor || editor.isDestroyed) return
    editor.chain().focus().setTextSelection(editor.state.selection.to).run()
  }
  close.addEventListener('click', () => { closePanel(); backToText() })
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closePanel()
    backToText()
  })

  // ——— Following edits made while the panel is open ———
  function follow(editor: Editor, current: Session) {
    const listener = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || session !== current) return
      for (const map of transaction.mapping.maps) {
        map.forEach((start, end) => { if (start <= current.to && end >= current.from) current.touched = true })
        current.from = map.map(current.from, -1)
        current.to = map.map(current.to, 1)
      }
      current.mapping.appendMapping(transaction.mapping)
    }
    editor.on('transaction', listener)
    return () => editor.off('transaction', listener)
  }

  // ——— Painting ———
  function label(action: AssistAction, tone?: Tone) {
    return action === 'tone' && tone ? t('aiAssist.toneTitle', [t(`aiAssist.tone.${tone}`)]) : t(`aiAssist.action.${action}`)
  }

  function setActions(...nodes: HTMLElement[]) {
    actions.replaceChildren(...nodes)
  }

  function setMessage(text: string, kind: 'info' | 'error' | 'warning' = 'info', extra: HTMLElement[] = []) {
    message.className = `ai-assist-message ai-assist-${kind}`
    message.replaceChildren(...(text ? [element('p', '', text)] : []), ...extra)
    message.hidden = !text && !extra.length
  }

  function action(labelText: string, run: () => void, primary = false) {
    const node = button(labelText, primary ? 'button button-primary button-small' : 'button button-quiet button-small')
    node.addEventListener('mousedown', (event) => event.preventDefault())
    node.addEventListener('click', run)
    return node
  }

  function settingsLink() {
    return action(t('aiAccess.openSettings'), () => { closePanel(); location.hash = aiSettingsHash })
  }

  function showOutput(show: boolean) {
    setExpanded(output, show)
  }

  // ——— Running ———
  async function start(next: AssistAction, tone?: Tone) {
    const editor = options.editor()
    if (!editor || editor.isDestroyed) return
    if (next !== 'ask' && !options.editing()) return
    const { from, to } = editor.state.selection
    const blocks = readBlocks(editor.state.doc, from, to)
    if (!blocks.length) { showNotice(t('aiAssist.selectFirst')); return }
    const profile = await requireAi(assistFeatures[next])
    if (!profile || editor.isDestroyed) return
    closePanel()
    finish?.()
    const current: Session = {
      action: next, tone, blocks, from, to, mapping: new Mapping(), touched: false, profile, reply: '', prepared: false, accepted: 0,
    }
    session = current
    stopListening = follow(editor, current)
    title.textContent = label(next, tone)
    via.textContent = profile.config.name
    via.title = t('aiAssist.via', [profile.config.name])
    outputText.textContent = ''
    output.hidden = true
    setMessage('')
    setActions()
    if (next === 'ask') {
      ask.hidden = false
      question.value = ''
      openPanel()
      question.focus()
      return
    }
    ask.hidden = true
    openPanel()
    void run(current)
  }

  ask.addEventListener('submit', (event) => {
    event.preventDefault()
    const current = session
    if (!current || !question.value.trim()) return
    current.question = question.value.trim()
    setExpanded(ask, false)
    void run(current)
  })

  async function run(current: Session) {
    if (session !== current) return
    current.reply = ''
    outputText.textContent = ''
    outputText.classList.add('ai-assist-streaming')
    showOutput(true)
    setMessage(t('aiAssist.waiting'))
    const stop = action(t('aiAssist.stop'), () => current.run?.cancel())
    stop.classList.add('ai-assist-stop')
    setActions(stop)
    stop.focus({ preventScroll: true })
    const messages = assistMessages({
      action: current.action, text: blocksText(current.blocks), paragraphs: current.blocks.length,
      tone: current.tone ? t(`aiAssist.tone.${current.tone}`) : undefined, question: current.question,
    })
    const live = ai.generate({ feature: assistFeatures[current.action], profileId: current.profile?.id, messages })
    current.run = live
    let finishReason: string | undefined
    let failure: AiError | undefined
    let stopped = false
    try {
      for await (const event of live.events) {
        if (session !== current) return
        if (event.type === 'delta') {
          if (!current.reply) setMessage(t('aiAssist.writing'))
          current.reply += event.text
          outputText.textContent = current.reply
          output.scrollTop = output.scrollHeight
        } else if (event.type === 'done') {
          current.reply = event.text
          finishReason = event.finishReason
        } else if (event.type === 'cancelled') stopped = true
        else failure = event.error
      }
    } catch (cause) {
      failure = { code: 'network', message: cause instanceof Error ? cause.message : String(cause) }
    }
    if (session !== current) return
    outputText.classList.remove('ai-assist-streaming')
    outputText.textContent = current.reply
    current.run = undefined
    const retry = () => action(t('aiAssist.retry'), () => { void run(current) })
    const dismiss = () => action(t('common.close'), () => { closePanel(); backToText() })
    if (failure) {
      const detail = failure.message && failure.message !== describeAiError(failure) ? [element('p', 'ai-assist-detail', failure.message)] : []
      setMessage(describeAiError(failure), 'error', detail)
      setActions(retry(), ...(settingsCodes.has(failure.code) ? [settingsLink()] : []), dismiss())
      return
    }
    if (stopped) {
      setMessage(t('aiAssist.stopped'), 'info')
      setActions(retry(), dismiss())
      return
    }
    const truncated = wasTruncated(finishReason)
    if (current.action === 'ask') { finishAnswer(current, truncated); return }
    if (truncated) {
      setMessage(t('aiAssist.truncated'), 'warning')
      setActions(retry(), settingsLink(), dismiss())
      return
    }
    finishEdit(current)
  }

  function finishAnswer(current: Session, truncated: boolean) {
    setMessage(truncated ? t('aiAssist.truncatedAnswer') : '', truncated ? 'warning' : 'info')
    const copy = action(t('aiAssist.copy'), () => {
      void navigator.clipboard?.writeText(current.reply).then(() => showNotice(t('aiAssist.copied')), () => showNotice(t('aiAssist.copyFailed')))
    })
    const insert = action(t('aiAssist.insertAfter'), () => { void insertAfter(current) }, true)
    insert.hidden = !options.editing()
    setActions(insert, copy, action(t('aiAssist.askAgain'), () => {
      current.question = undefined
      question.value = ''
      setExpanded(ask, true, () => question.focus())
    }), action(t('common.close'), () => closePanel()))
  }

  function finishEdit(current: Session) {
    const editor = options.editor()
    if (current.touched) {
      setMessage(t('aiAssist.textChanged'), 'warning')
      setActions(action(t('aiAssist.retry'), () => { void restart(current) }), action(t('common.close'), () => closePanel()))
      return
    }
    const items = suggestionsFor(current.blocks, current.reply).map((item) => {
      const from = current.mapping.map(item.from, 1)
      return { ...item, from, to: Math.max(from, current.mapping.map(item.to, -1)) }
    })
    if (!items.length) {
      setMessage(t('aiAssist.noChanges'))
      setActions(action(t('common.close'), () => closePanel()))
      return
    }
    showOutput(false)
    showSuggestions(editor.view, items, {
      accept: (id) => { void adopt(current, () => acceptSuggestion(editor.view, id)) },
      reject: (id) => rejectSuggestion(editor.view, id),
      changed: () => { if (session === current) paintReview(current) },
    })
    paintReview(current)
  }

  /** Builds the request again from the selection as it is now. */
  async function restart(current: Session) {
    const editor = options.editor()
    const blocks = readBlocks(editor.state.doc, current.from, current.to)
    if (!blocks.length) { closePanel(); return }
    current.blocks = blocks
    current.mapping = new Mapping()
    current.touched = false
    await run(current)
  }

  function paintReview(current: Session) {
    const editor = options.editor()
    const { items, stale } = currentSuggestions(editor.state)
    const notes: string[] = []
    if (items.length) notes.push(t('aiAssist.changesLeft', [items.length]))
    if (current.accepted) notes.push(t('aiAssist.changesTaken', [current.accepted]))
    if (stale) notes.push(t('aiAssist.changesStale', [stale]))
    if (!items.length && !current.accepted) notes.push(t('aiAssist.allRejected'))
    setMessage(notes.join(' '), stale ? 'warning' : 'info', items.length ? [element('p', 'ai-assist-hint', t('aiAssist.reviewHint'))] : [])
    const undo = action(t('aiAssist.undo'), () => {
      editor.commands.undo()
      current.accepted = Math.max(0, current.accepted - 1)
      paintReview(current)
    })
    undo.hidden = !current.accepted
    if (items.length) {
      setActions(
        action(t('aiAssist.acceptAll'), () => { void adopt(current, () => acceptAll(editor.view), items.length) }, true),
        action(t('aiAssist.insertParagraphs'), () => { void insertAfter(current) }),
        undo,
        action(t('aiAssist.discard'), () => { closePanel(); backToText() }),
      )
    } else setActions(undo, action(t('common.close'), () => { closePanel(); backToText() }, true))
  }

  /** Every change to the text goes through here, so the chapter is kept in history first. */
  async function adopt(current: Session, change: () => boolean | void, count = 1) {
    if (session !== current) return
    if (!current.prepared) {
      setActions()
      setMessage(t('aiAssist.saving'))
      try {
        await options.beforeChange({ action: current.action, profile: current.profile! })
      } catch (cause) {
        if (session !== current) return
        setMessage(t('aiAssist.saveFailed', [cause instanceof Error ? cause.message : String(cause)]), 'error')
        paintReview(current)
        return
      }
      if (session !== current) return
      current.prepared = true
    }
    if (change() !== false) current.accepted += count
    paintReview(current)
  }

  async function insertAfter(current: Session) {
    const editor = options.editor()
    const paragraphs = replyParagraphs(current.reply)
    if (!paragraphs.length) return
    await adopt(current, () => {
      clearSuggestions(editor.view)
      insertParagraphsAfter(editor.view, current.to, paragraphs)
    })
    if (session !== current) return
    setMessage(t('aiAssist.inserted'))
    const undo = action(t('aiAssist.undo'), () => { editor.commands.undo(); closePanel() })
    setActions(undo, action(t('common.close'), () => { closePanel(); backToText() }, true))
  }

  // ——— The entries in the selection tools ———
  function menuItems(): ShellMenuItem[] {
    const editing = options.editing()
    const item = (next: AssistAction): ShellMenuItem => ({ label: t(`aiAssist.action.${next}`), disabled: !editing, action: () => { void start(next) } })
    return [
      ...editingActions.filter((next) => next !== 'tone').map(item),
      {
        label: t('aiAssist.action.tone'), disabled: !editing,
        children: () => tones.map((tone) => ({ label: t(`aiAssist.tone.${tone}`), action: () => { void start('tone', tone) } })),
      },
      { label: '', separator: true },
      { label: t('aiAssist.action.ask'), icon: 'ai', action: () => { void start('ask') } },
    ]
  }

  options.signal.addEventListener('abort', () => { closePanel(); panel.remove() }, { once: true })

  return {
    menuItems,
    start,
    /** Ends the panel, e.g. when the chapter or the mode changes. */
    close: closePanel,
    isOpen: () => Boolean(session),
  }
}
