import type { Editor } from '@tiptap/core'
import { Mapping } from '@tiptap/pm/transform'
import type { Transaction } from '@tiptap/pm/state'
import { ai } from '../ai-provider'
import type { AiError, AiRun, GenerateRequest, ResolvedProfile, SavedProfile } from '../ai-provider'
import { aiSettingsHash, requireAi, requireBookAi } from '../ai/access'
import { buildBookQuestion } from '../ai/book-context'
import type { BookRequestSource } from '../ai/book-context'
import type { ChatTurn, ContextSources } from '../ai/book-chat-model'
import { clarificationView, contextDetails, copyReply, readableReply } from '../ai/book-reply-view'
import { parseClarification } from '../ai/clarification'
import { describeAiError } from '../ai/errors'
import { assistFeatures, assistMessages, editingActions, styledActions, wasTruncated } from '../ai/prompts'
import { allStyles, isBuiltin, setWorkStyle, styleInstructions, workStyle } from '../ai/styles'
import type { WritingStyle } from '../ai/styles'
import type { LibraryId } from '../library'
import { addIdea } from '../ideas'
import { bookMessages, cachedBookSummaries, chapterSummaries, collect, parseProofread, proofreadChunks, proofreadMessages, summaryMessages } from '../ai/review'
import type { ProofreadEdit } from '../ai/review'
import type { Feature } from '../ai-provider'
import { chapterText } from './model'
import type { DocumentContent } from './model'
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
  readBlocks, rejectSuggestion, replyParagraphs, showSuggestions, suggestionsFor, suggestionsFromEdits,
} from './ai-suggest'
import type { Suggestion, TextBlock } from './ai-suggest'
import './ai-assist.css'

const tones: Tone[] = ['formal', 'casual', 'gentle', 'cold', 'humorous', 'tense']
const settingsCodes = new Set(['unauthorized', 'forbidden', 'not_configured', 'invalid_config', 'cors', 'network', 'quota_exceeded', 'timeout'])

export interface AssistOptions {
  editor: () => Editor
  editing: () => boolean
  /** The pane the panel centres on. */
  area: () => HTMLElement
  /** The work being edited, whose default writing style the panel starts with. */
  work: () => { library: LibraryId; bookId: string }
  /** The work's and the open chapter's names, for summaries. */
  titles: () => { book: string; chapter: string }
  /** Every chapter of the version being edited, with the open one as it is on screen. */
  chapters: () => Promise<{ title: string; content: DocumentContent }[]>
  context: () => BookRequestSource
  /**
   * Runs once per panel before its first change to the text: the editor saves, and the chapter as
   * it was is kept in its history.
   */
  beforeChange: (input: { action: AssistAction | 'storyCheck'; profileName: string }) => Promise<void>
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
  profile?: SavedProfile | ResolvedProfile
  storyFix?: { profileName: string }
  /** Earlier questions and replies in this selection panel. */
  history: ChatTurn[]
  run?: AiRun
  reply: string
  prepared: boolean
  accepted: number
  /** The writing style the request asks for, if any. */
  style?: WritingStyle
  /** Counts requests, so a reply that was replaced by a newer one is ignored. */
  turn: number
  /** What a proofread or a summary covers. */
  scope: Scope
  /** Set by the stop button, so a run of several requests ends too. */
  halted: boolean
  /** A remark kept beside the review, e.g. parts the proofreading could not read. */
  remark?: string
}

export type Scope = 'selection' | 'chapter' | 'book'

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
  const replyExtras = element('div')
  output.append(outputText, replyExtras)
  const message = element('div', 'ai-assist-message')
  message.setAttribute('role', 'status')
  const actions = element('div', 'ai-assist-actions')
  // The writing style, for the actions that write text.
  const styleRow = element('div', 'ai-assist-style')
  const styleLabel = element('label', 'ai-assist-style-label')
  const styleSelect = element('select', 'editor-select ai-assist-style-select')
  styleLabel.append(element('span', '', t('aiAssist.style')), styleSelect)
  const makeDefault = button(t('aiAssist.styleMakeDefault'), 'button button-quiet button-small')
  makeDefault.addEventListener('mousedown', (event) => event.preventDefault())
  styleRow.append(styleLabel, makeDefault)
  let styleChoices: WritingStyle[] = []
  let workDefault: string | undefined

  panel.append(head, styleRow, ask, output, message, actions)
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
  const featureOf = (next: AssistAction, scope: Scope): Feature => next === 'summary' && scope === 'book' ? 'bookSummary' : assistFeatures[next]

  async function start(next: AssistAction, tone?: Tone, scope: Scope = 'selection') {
    const editor = options.editor()
    if (!editor || editor.isDestroyed) return
    if (next !== 'ask' && next !== 'summary' && !options.editing()) return
    const whole = scope !== 'selection'
    const from = whole ? 0 : editor.state.selection.from
    const to = whole ? editor.state.doc.content.size : editor.state.selection.to
    const blocks = scope === 'book' ? [] : readBlocks(editor.state.doc, from, to)
    if (!blocks.length && scope !== 'book') { showNotice(scope === 'chapter' ? t('aiAssist.chapterEmpty') : t('aiAssist.selectFirst')); return }
    const profile = next === 'ask' ? await requireBookAi() : await requireAi(featureOf(next, scope))
    if (!profile || editor.isDestroyed || editor !== options.editor() || options.signal.aborted) return
    closePanel()
    finish?.()
    const current: Session = {
      action: next, tone, blocks, from, to, mapping: new Mapping(), touched: false, profile, reply: '', prepared: false, accepted: 0, turn: 0,
      scope, halted: false, history: [],
    }
    styleRow.hidden = !styledActions.includes(next)
    if (!styleRow.hidden) {
      try {
        const work = options.work()
        const [choices, preferred] = await Promise.all([allStyles(), workStyle(work.library, work.bookId)])
        styleChoices = choices
        workDefault = preferred?.id
        current.style = preferred
      } catch {
        styleChoices = []
        workDefault = undefined
      }
      paintStyles(current)
    }
    session = current
    stopListening = follow(editor, current)
    title.textContent = next === 'proofread' || next === 'summary' ? t(`aiAssist.${next}.${scope}`) : label(next, tone)
    via.textContent = profile.config.name
    via.title = t('aiAssist.via', [profile.config.name])
    outputText.textContent = ''
    replyExtras.replaceChildren()
    output.hidden = true
    setMessage('')
    setActions()
    if (next === 'ask') {
      setExpanded(ask, true)
      question.value = ''
      question.placeholder = t('aiAssist.askPlaceholder')
      openPanel()
      question.focus()
      return
    }
    setExpanded(ask, false)
    openPanel()
    void run(current)
  }

  function paintStyles(current: Session) {
    styleSelect.replaceChildren()
    const none = element('option', '', t('aiAssist.styleNone'))
    none.value = ''
    styleSelect.append(none)
    const own = element('optgroup')
    own.label = t('aiAssist.styleOwn')
    const builtin = element('optgroup')
    builtin.label = t('aiAssist.styleBuiltin')
    for (const style of styleChoices) {
      const option = element('option', '', style.name)
      option.value = style.id
      ;(isBuiltin(style.id) ? builtin : own).append(option)
    }
    if (own.children.length) styleSelect.append(own)
    styleSelect.append(builtin)
    styleSelect.value = current.style?.id ?? ''
    makeDefault.hidden = (current.style?.id ?? undefined) === workDefault
  }

  styleSelect.addEventListener('change', () => {
    const current = session
    if (!current) return
    current.style = styleChoices.find((style) => style.id === styleSelect.value)
    makeDefault.hidden = (current.style?.id ?? undefined) === workDefault
    // A new style asks again, unless some of the last reply was already taken.
    if (current.accepted || current.prepared) return
    clearSuggestions(options.editor().view)
    if (current.action === 'continue' || editingActions.includes(current.action)) void run(current)
  })
  makeDefault.addEventListener('click', async () => {
    const current = session
    if (!current) return
    const work = options.work()
    try {
      await setWorkStyle(work.library, work.bookId, current.style?.id ?? null)
      workDefault = current.style?.id
      makeDefault.hidden = true
      showNotice(current.style ? t('aiAssist.styleDefaultSet', [current.style.name]) : t('aiAssist.styleDefaultCleared'))
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : String(cause))
    }
  })

  function submitQuestion(current: Session, value: string) {
    if (session !== current || current.action !== 'ask' || !value.trim()) return
    current.question = value.trim()
    question.value = ''
    setExpanded(ask, false)
    void run(current)
  }

  ask.addEventListener('submit', (event) => {
    event.preventDefault()
    if (session) submitQuestion(session, question.value)
  })

  async function run(current: Session) {
    const profile = current.profile
    if (session !== current || !profile) return
    current.run?.cancel()
    const turn = ++current.turn
    const alive = () => session === current && current.turn === turn
    current.reply = ''
    outputText.textContent = ''
    replyExtras.replaceChildren()
    outputText.classList.add('ai-assist-streaming')
    showOutput(true)
    setMessage(t('aiAssist.waiting'))
    current.halted = false
    current.remark = undefined
    const stop = action(t('aiAssist.stop'), () => { current.halted = true; current.run?.cancel() })
    stop.classList.add('ai-assist-stop')
    setActions(stop)
    stop.focus({ preventScroll: true })
    const retry = () => action(t('aiAssist.retry'), () => { void run(current) })
    const dismiss = () => action(t('common.close'), () => { closePanel(); backToText() })
    const fail = (failure: AiError) => {
      const detail = failure.message && failure.message !== describeAiError(failure) ? [element('p', 'ai-assist-detail', failure.message)] : []
      outputText.classList.remove('ai-assist-streaming')
      setMessage(describeAiError(failure), 'error', detail)
      setActions(retry(), ...(settingsCodes.has(failure.code) ? [settingsLink()] : []), dismiss())
    }
    const halt = () => {
      outputText.classList.remove('ai-assist-streaming')
      setMessage(t('aiAssist.stopped'), 'info')
      setActions(retry(), dismiss())
    }
    if (current.action === 'proofread') { await proofread(current, alive, fail, halt); return }
    let book: { title: string; summary: string }[] | undefined
    let bookCacheToken: string | undefined
    let profileRevision = 'revision' in profile ? profile.revision : undefined
    if (current.action === 'summary' && current.scope === 'book') {
      // Chapters are split to fit the model, which needs its context size.
      if (!profile.config.generation?.contextTokens) {
        outputText.classList.remove('ai-assist-streaming')
        showOutput(false)
        setMessage(t('aiAssist.needContext', [profile.config.name]), 'warning')
        setActions(settingsLink(), dismiss())
        return
      }
      const chapters = (await options.chapters()).map((chapter) => ({ title: chapter.title, text: chapterText(chapter.content, '\n') }))
      if (!alive()) return
      const resolved = await ai.resolveProfile({ feature: 'bookSummary', profileId: profile.id })
      if (!alive()) return
      if (current.halted) { halt(); return }
      if (!resolved.ok) { fail(resolved.error); return }
      profileRevision = resolved.data.revision
      const cached = await cachedBookSummaries(options.titles().book, chapters, { profileId: profile.id, expectedProfileRevision: profileRevision })
      if (!alive()) return
      if (current.halted) { halt(); return }
      if (cached.ok) bookCacheToken = cached.data.bookCacheToken
      const result = await chapterSummaries(chapters, {
        profileId: profile.id,
        track: (live) => { current.run = live },
        stopped: () => !alive() || current.halted,
        progress: ({ done, total, cached, title: name }) => {
          if (alive()) setMessage(done < total ? t('aiAssist.bookProgress', [done + 1, total, name, cached]) : t('aiAssist.bookJoining', [total, cached]))
        },
      })
      if (!alive()) return
      if (!result.ok) { if (result.cancelled || current.halted) halt(); else if (result.error) fail(result.error); return }
      book = result.summaries
      current.remark = t('aiAssist.bookCached', [result.cached, chapters.length])
    }
    const titles = options.titles()
    let sources: ContextSources | undefined
    let messages: GenerateRequest['messages']
    if (current.action === 'ask') {
      try {
        const request = await buildBookQuestion(options.context(), profile.config, current.question ?? '', current.history,
          blocksText(current.blocks), () => !alive() || current.halted)
        if (!alive()) return
        if (!request || current.halted) { halt(); return }
        if (!request.messages.length) {
          outputText.classList.remove('ai-assist-streaming')
          showOutput(false)
          setMessage(t('aiContext.tooSmall'), 'warning')
          setActions(settingsLink(), dismiss())
          return
        }
        messages = request.messages
        sources = request.sources
      } catch {
        if (!alive()) return
        if (current.halted) halt()
        else fail({ code: 'storage', message: t('aiContext.readFailed') })
        return
      }
    } else {
      messages = book ? bookMessages(titles.book, book)
        : current.action === 'summary' ? summaryMessages(current.scope === 'chapter' ? 'chapter' : 'selection', blocksText(current.blocks), current.scope === 'chapter' ? titles.chapter : undefined)
        : assistMessages({
          action: current.action, text: blocksText(current.blocks), paragraphs: current.blocks.length,
          tone: current.tone ? t(`aiAssist.tone.${current.tone}`) : undefined,
          system: current.style && styledActions.includes(current.action) ? styleInstructions(current.style) : undefined,
        })
    }
    if (current.halted) { halt(); return }
    const live = ai.generate({
      feature: featureOf(current.action, current.scope), profileId: profile.id, expectedProfileRevision: profileRevision, messages,
      ...(current.action === 'ask' ? { stream: true } : {}),
    })
    current.run = live
    let finishReason: string | undefined
    let failure: AiError | undefined
    let stopped = false
    try {
      for await (const event of live.events) {
        if (!alive()) return
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
    if (!alive()) return
    outputText.classList.remove('ai-assist-streaming')
    outputText.textContent = current.reply
    current.run = undefined
    if (sources && current.reply) replyExtras.append(contextDetails(sources))
    if (failure) { fail(failure); return }
    if (stopped) { halt(); return }
    const truncated = wasTruncated(finishReason)
    if (current.action === 'summary') {
      if (bookCacheToken && !truncated && current.reply.trim()) await ai.saveChapterSummary(bookCacheToken, current.reply.trim())
      if (alive()) finishSummary(current, truncated)
      return
    }
    if (current.action === 'ask' || current.action === 'continue') {
      if (sources && current.question) current.history.push({ id: crypto.randomUUID(), question: current.question, reply: {
        text: current.reply, profileName: profile.config.name, context: sources, status: truncated ? 'truncated' : 'complete',
      } })
      finishAnswer(current, truncated)
      return
    }
    if (truncated) {
      setMessage(t('aiAssist.truncated'), 'warning')
      setActions(retry(), settingsLink(), dismiss())
      return
    }
    finishEdit(current)
  }

  /**
   * Proofreads the text a few paragraphs at a time; every finding becomes a change to take or
   * decline, located by its paragraph and the words around it.
   */
  async function proofread(current: Session, alive: () => boolean, fail: (error: AiError) => void, halt: () => void) {
    showOutput(false)
    const texts = current.blocks.map((block) => block.text)
    const chunks = proofreadChunks(texts)
    const edits: ProofreadEdit[] = []
    let unreadable = 0
    for (const [index, chunk] of chunks.entries()) {
      if (!alive()) return
      if (current.halted) { halt(); return }
      setMessage(chunks.length > 1 ? t('aiAssist.proofreadProgress', [index + 1, chunks.length]) : t('aiAssist.waiting'))
      const live = ai.generate({
        feature: 'proofread', profileId: current.profile?.id, stream: false,
        messages: proofreadMessages(texts.slice(chunk.start, chunk.start + chunk.count)),
      })
      current.run = live
      const outcome = await collect(live)
      if (!alive()) return
      if (!outcome.ok) {
        if (outcome.cancelled || current.halted) halt()
        else if (outcome.error) fail(outcome.error)
        return
      }
      try {
        if (wasTruncated(outcome.finishReason)) throw new Error('truncated')
        edits.push(...parseProofread(outcome.text, chunk.start, chunk.count))
      } catch {
        unreadable++
      }
    }
    current.run = undefined
    if (unreadable) current.remark = t('aiAssist.proofreadUnreadable', [unreadable, chunks.length])
    if (current.touched) {
      setMessage(t('aiAssist.textChanged'), 'warning')
      setActions(action(t('aiAssist.retry'), () => { void restart(current) }), action(t('common.close'), () => closePanel()))
      return
    }
    const items = suggestionsFromEdits(current.blocks, edits).map((item) => {
      const from = current.mapping.map(item.from, 1)
      return { ...item, from, to: Math.max(from, current.mapping.map(item.to, -1)) }
    })
    if (!items.length) {
      setMessage([t('aiAssist.proofreadClean'), current.remark].filter(Boolean).join(' '), unreadable ? 'warning' : 'info')
      setActions(action(unreadable ? t('aiAssist.retry') : t('common.close'), () => { if (unreadable) void run(current); else closePanel() }, !unreadable),
        ...(unreadable ? [action(t('common.close'), () => closePanel())] : []))
      return
    }
    reviewSuggestions(current, items)
  }

  function finishSummary(current: Session, truncated: boolean) {
    const notes = [truncated ? t('aiAssist.truncatedAnswer') : '', current.remark ?? ''].filter(Boolean)
    setMessage(notes.join(' '), truncated ? 'warning' : 'info')
    const keep = action(t('aiAssist.saveIdea'), async () => {
      const titles = options.titles()
      const heading = current.scope === 'book' ? t('aiAssist.ideaBook', [titles.book])
        : current.scope === 'chapter' ? t('aiAssist.ideaChapter', [titles.chapter]) : t('aiAssist.ideaSelection', [titles.chapter])
      try {
        await addIdea(`${heading}\n${current.reply.trim()}`, options.work())
        keep.disabled = true
        showNotice(t('aiAssist.ideaSaved'))
      } catch (cause) {
        showNotice(cause instanceof Error ? cause.message : String(cause))
      }
    }, true)
    const copy = action(t('aiAssist.copy'), () => {
      void navigator.clipboard?.writeText(current.reply).then(() => showNotice(t('aiAssist.copied')), () => showNotice(t('aiAssist.copyFailed')))
    })
    setActions(keep, copy, action(t('aiAssist.retry'), () => { void run(current) }), action(t('common.close'), () => closePanel()))
  }

  function finishAnswer(current: Session, truncated: boolean) {
    setMessage(truncated ? t('aiAssist.truncatedAnswer') : '', truncated ? 'warning' : 'info')
    const answer = current.action === 'ask' && !truncated ? parseClarification(current.reply) : { text: current.reply }
    const content = readableReply(answer)
    if (answer.questions) {
      outputText.textContent = answer.text
      replyExtras.prepend(clarificationView(answer.questions, (value) => submitQuestion(current, value)))
      output.scrollTop = 0
      question.placeholder = t('aiChat.replyPlaceholder')
      setExpanded(ask, true)
    }
    const copy = action(t('aiAssist.copy'), () => { void copyReply(content) })
    const insert = action(t('aiAssist.insertAfter'), () => { void insertAfter(current, content) }, true)
    insert.hidden = !options.editing()
    const again = current.action === 'ask'
      ? action(t('aiAssist.askAgain'), () => {
        current.question = undefined
        question.value = ''
        setExpanded(ask, true, () => question.focus())
      })
      : action(t('aiAssist.retry'), () => { void run(current) })
    setActions(insert, copy, ...(answer.questions ? [] : [again]), action(t('common.close'), () => closePanel()))
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
    reviewSuggestions(current, items)
  }

  function reviewSuggestions(current: Session, items: Suggestion[]) {
    const editor = options.editor()
    showSuggestions(editor.view, items, {
      accept: (id) => { void adopt(current, () => acceptSuggestion(editor.view, id)) },
      reject: (id) => rejectSuggestion(editor.view, id),
      changed: () => { if (session === current) paintReview(current) },
    })
    paintReview(current)
  }

  function reviewStoryFix(input: { from: number; to: number; original: string; replacement: string; reason: string; profileName: string }) {
    const editor = options.editor()
    if (!options.editing() || editor.view.composing) return false
    const { from, to, original, replacement, reason, profileName } = input
    const blocks = readBlocks(editor.state.doc, from, to)
    if (blocks.length !== 1 || blocks[0].text !== original) return false
    const items = suggestionsFromEdits(blocks, [{ block: 0, original, replacement, reason }])
    if (!items.length) return false
    closePanel()
    finish?.()
    const current: Session = {
      action: 'proofread', storyFix: { profileName }, blocks, from, to, mapping: new Mapping(), touched: false,
      reply: '', prepared: false, accepted: 0, turn: 0, scope: 'selection', halted: false, history: [],
    }
    session = current
    title.textContent = t('storyAi.check')
    via.textContent = profileName
    styleRow.hidden = true
    setExpanded(ask, false)
    showOutput(false)
    reviewSuggestions(current, items)
    openPanel()
    actions.querySelector('button')?.focus({ preventScroll: true })
    return true
  }

  /** Builds the request again from the selection as it is now. */
  async function restart(current: Session) {
    const editor = options.editor()
    const blocks = current.scope === 'chapter'
      ? readBlocks(editor.state.doc, 0, editor.state.doc.content.size)
      : readBlocks(editor.state.doc, current.from, current.to)
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
    if (current.remark) notes.push(current.remark)
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
        ...(current.storyFix ? [] : [action(t('aiAssist.insertParagraphs'), () => { void insertAfter(current) })]),
        undo,
        action(t('aiAssist.discard'), () => { closePanel(); backToText() }),
      )
    } else setActions(undo, action(t('common.close'), () => { closePanel(); backToText() }, true))
  }

  /** Every change to the text goes through here, so the chapter is kept in history first. */
  async function adopt(current: Session, change: () => boolean | void, count = 1) {
    if (session !== current) return false
    if (!current.prepared) {
      const previous = Array.from(actions.children) as HTMLElement[]
      setActions()
      setMessage(t('aiAssist.saving'))
      try {
        await options.beforeChange({
          action: current.storyFix ? 'storyCheck' : current.action,
          profileName: current.storyFix?.profileName ?? current.profile?.config.name ?? '',
        })
      } catch (cause) {
        if (session !== current) return false
        setMessage(t('aiAssist.saveFailed', [cause instanceof Error ? cause.message : String(cause)]), 'error')
        setActions(...previous)
        return false
      }
      if (session !== current) return false
      current.prepared = true
    }
    const applied = change() !== false
    if (applied) current.accepted += count
    paintReview(current)
    return applied
  }

  async function insertAfter(current: Session, text = current.reply) {
    const editor = options.editor()
    const paragraphs = replyParagraphs(text)
    if (!paragraphs.length) return
    const inserted = await adopt(current, () => {
      clearSuggestions(editor.view)
      insertParagraphsAfter(editor.view, current.to, paragraphs)
    })
    if (!inserted || session !== current) return
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
      item('continue'),
      { label: '', separator: true },
      { label: t('aiAssist.proofread.selection'), disabled: !editing, action: () => { void start('proofread') } },
      { label: t('aiAssist.summary.selection'), action: () => { void start('summary') } },
      { label: t('aiAssist.action.ask'), icon: 'ai', action: () => { void start('ask') } },
    ]
  }

  /** Whole-chapter and whole-book entries, for the editor's own menu. */
  function chapterItems(): ShellMenuItem[] {
    return [
      { label: t('aiAssist.proofread.chapter'), disabled: !options.editing(), action: () => { void start('proofread', undefined, 'chapter') } },
      { label: t('aiAssist.summary.chapter'), action: () => { void start('summary', undefined, 'chapter') } },
      { label: t('aiAssist.summary.book'), action: () => { void start('summary', undefined, 'book') } },
    ]
  }

  options.signal.addEventListener('abort', () => { closePanel(); panel.remove() }, { once: true })

  return {
    menuItems,
    chapterItems,
    start,
    reviewStoryFix,
    /** Ends the panel, e.g. when the chapter or the mode changes. */
    close: closePanel,
    isOpen: () => Boolean(session),
  }
}
