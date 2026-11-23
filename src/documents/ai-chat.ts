import { ai } from '../ai-provider'
import type { AiRun } from '../ai-provider'
import { aiSettingsHash, confirmDialog, readAiConfig, requireBookAi } from '../ai/access'
import { chatTitle } from '../ai/book-chat-model'
import type { BookChat, ChatReply, ChatTurn } from '../ai/book-chat-model'
import { deleteBookChat, finishChatTurn, listBookChats, startChatTurn } from '../ai/book-chat-store'
import { buildBookQuestion } from '../ai/book-context'
import type { BookRequestSource } from '../ai/book-context'
import { clarificationView, contextDetails, copyReply, readableReply } from '../ai/book-reply-view'
import { parseClarification } from '../ai/clarification'
import { describeAiError } from '../ai/errors'
import { profileFor } from '../ai/features'
import { wasTruncated } from '../ai/prompts'
import { t } from '../i18n'
import { storageError } from '../library'
import type { StoryWork } from '../story-settings/model'
import { button, element } from '../ui'
import { showNotice } from '../undo'
import './ai-chat.css'

interface ChatOptions {
  work: StoryWork
  source: () => BookRequestSource
  insert: (text: string, profileName: string) => Promise<void>
  editing: () => boolean
  close: () => void
  signal: AbortSignal
}

interface ActiveTurn {
  stopped: boolean
  run?: AiRun
}

export function mountAiChat(options: ChatOptions) {
  const { work, signal } = options
  const panel = element('section', 'ai-chat')
  panel.setAttribute('aria-label', t('aiChat.title'))
  const toolbar = element('div', 'ai-chat-tools')
  const history = element('select', 'editor-select ai-chat-history')
  history.setAttribute('aria-label', t('aiChat.history'))
  const create = button('', 'format-button', 'plus')
  create.title = t('aiChat.new')
  create.setAttribute('aria-label', create.title)
  const remove = button('', 'format-button ai-chat-delete', 'trash')
  remove.title = t('aiChat.delete')
  remove.setAttribute('aria-label', remove.title)
  const close = button('', 'format-button', 'close')
  close.title = t('aiChat.close')
  close.setAttribute('aria-label', close.title)
  close.addEventListener('click', options.close)
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    options.close()
  })
  toolbar.append(history, create, remove, close)

  const transcript = element('div', 'ai-chat-transcript')
  transcript.setAttribute('role', 'log')
  transcript.setAttribute('aria-label', t('aiChat.transcript'))
  // Announce progress and completion below; updating a live region per streamed token is noisy.
  transcript.setAttribute('aria-live', 'off')
  const help = element('div', 'ai-chat-setup')
  const helpText = element('p', 'dialog-help')
  const settings = element('a', 'button button-small', t('aiAccess.openSettings'))
  settings.href = aiSettingsHash
  help.append(helpText, settings)

  const status = element('p', 'ai-chat-status')
  status.setAttribute('role', 'status')
  const form = element('form', 'ai-chat-compose')
  const input = element('textarea', 'title-input')
  input.rows = 2
  input.placeholder = t('aiChat.placeholder')
  input.setAttribute('aria-label', t('aiChat.message'))
  const send = button(t('aiAssist.send'), 'button button-primary button-small')
  send.type = 'submit'
  const stop = button(t('aiAssist.stop'), 'button button-quiet button-small')
  form.append(input, send, stop)
  panel.append(toolbar, transcript, help, status, form)

  let chats: BookChat[] = []
  let selected: BookChat | undefined
  let ready = false
  let refreshing = 0
  let configured = false
  let deleting = false
  let active: ActiveTurn | undefined

  function setStatus(text: string, error = false, quiet = false) {
    status.textContent = text
    status.hidden = !text
    status.classList.toggle('ai-assist-error', error)
    status.classList.toggle('visually-hidden', quiet)
  }

  function paintControls() {
    const locked = !ready || Boolean(active) || deleting
    history.disabled = create.disabled = locked
    remove.disabled = locked || !selected
    form.hidden = !configured
    input.readOnly = locked
    send.hidden = Boolean(active)
    send.disabled = locked || !input.value.trim()
    stop.hidden = !active
    stop.disabled = Boolean(active?.stopped)
    for (const choice of transcript.querySelectorAll<HTMLButtonElement>('.ai-clarification button')) {
      if (locked || !configured) choice.disabled = true
    }
  }

  function paintHistory() {
    const draft = element('option', '', t('aiChat.new'))
    draft.value = ''
    const rows = chats.map((chat) => {
      const option = element('option', '', chatTitle(chat))
      option.value = chat.id
      return option
    })
    history.replaceChildren(draft, ...rows)
    history.value = selected?.id ?? ''
  }

  function scrollToEnd() {
    transcript.scrollTop = transcript.scrollHeight
  }

  function replyBody(reply: ChatReply, allowOptions: boolean) {
    const node = element('article', 'ai-chat-reply')
    node.setAttribute('aria-label', t('aiChat.reply'))
    const answer = reply.status === 'complete' ? parseClarification(reply.text) : { text: reply.text }
    const text = element('p', 'ai-chat-text', allowOptions ? answer.text : readableReply(answer))
    if (text.textContent) node.append(text)
    if (allowOptions && answer.questions) node.append(clarificationView(answer.questions, (value) => { void submit(value) }))
    if (reply.status !== 'complete') {
      const label = reply.status === 'truncated' ? 'aiAssist.truncatedAnswer'
        : reply.status === 'stopped' ? 'aiAssist.stopped' : 'aiChat.incomplete'
      node.append(element('p', 'ai-chat-reply-status', t(label)))
    }
    node.append(contextDetails(reply.context))
    const content = readableReply(answer)
    if (content) {
      const actions = element('div', 'ai-chat-reply-actions')
      const copy = button(t('aiAssist.copy'), 'button button-quiet button-small')
      copy.addEventListener('click', () => { void copyReply(content) })
      const insert = button(t('aiChat.insert'), 'button button-quiet button-small ai-chat-insert')
      insert.hidden = !options.editing()
      insert.addEventListener('mousedown', (event) => event.preventDefault())
      insert.addEventListener('click', async () => {
        insert.disabled = true
        try {
          await options.insert(content, reply.profileName)
          showNotice(t('aiAssist.inserted'))
        } catch (cause) {
          showNotice(t('aiAssist.saveFailed', [storageError(cause)]))
        } finally { insert.disabled = false }
      })
      actions.append(copy, insert)
      node.append(actions)
    }
    return node
  }

  function paintTranscript() {
    const turns = selected?.turns ?? []
    transcript.replaceChildren()
    const last = turns.at(-1)?.reply
    input.placeholder = t(last?.status === 'complete' && parseClarification(last.text).questions
      ? 'aiChat.replyPlaceholder' : 'aiChat.placeholder')
    if (!turns.length) {
      if (configured) transcript.append(element('p', 'dialog-help ai-chat-empty', t('aiChat.empty')))
      return
    }
    for (const [index, turn] of turns.entries()) {
      const user = element('p', 'ai-chat-user ai-chat-text', turn.question)
      transcript.append(user)
      if (turn.reply) transcript.append(replyBody(turn.reply, configured && index === turns.length - 1))
    }
    if (!panel.closest('[hidden]')) scrollToEnd()
  }

  function select(chat?: BookChat) {
    selected = chat
    input.value = ''
    setStatus('')
    paintHistory()
    paintTranscript()
    paintControls()
  }

  function remember(row: BookChat) {
    chats = [row, ...chats.filter(({ id }) => id !== row.id)]
    selected = row
  }

  async function open() {
    const version = ++refreshing
    try {
      const [config, rows] = await Promise.all([readAiConfig(), listBookChats(work)])
      if (signal.aborted || version !== refreshing) return
      if (active || deleting) { scrollToEnd(); return }
      const found = config ? profileFor(config, 'ask') : undefined
      configured = found?.ok === true
      help.hidden = configured
      helpText.textContent = t(found && !found.ok && found.reason === 'disabled' ? 'aiAccess.disabledCopy' : 'aiAccess.setupCopy')
      chats = rows
      selected = ready ? chats.find(({ id }) => id === selected?.id) : chats[0]
      ready = true
      paintHistory()
      paintTranscript()
      paintControls()
    } catch (cause) {
      if (!signal.aborted && version === refreshing) setStatus(storageError(cause), true)
    }
  }

  async function submit(text: string) {
    const question = text.trim()
    if (!question || active || deleting || !ready || !configured || signal.aborted) return
    const current: ActiveTurn = { stopped: false }
    const stopped = () => current.stopped || signal.aborted
    active = current
    setStatus('')
    paintControls()
    try {
      const profile = await requireBookAi()
      if (!profile || stopped()) return
      const source = options.source()
      const turn: ChatTurn = { id: crypto.randomUUID(), question }
      const saved = await startChatTurn(work, selected, turn)
      remember(saved)
      if (signal.aborted) return
      input.value = ''
      paintHistory()
      paintTranscript()
      if (stopped()) { setStatus(t('aiAssist.stopped')); return }
      setStatus(t('aiAssist.waiting'))
      const request = await buildBookQuestion(source, profile.config, question, saved.turns.slice(0, -1), undefined, stopped)
      if (!request || stopped()) { setStatus(t('aiAssist.stopped')); return }
      if (!request.messages.length) { setStatus(t('aiContext.tooSmall')); return }
      const reply: ChatReply = { text: '', profileName: profile.config.name, context: request.sources, status: 'error' }
      const stream = element('p', 'ai-chat-text ai-chat-reply ai-assist-streaming')
      transcript.append(stream)
      current.run = ai.generate({
        feature: 'ask', profileId: profile.id, expectedProfileRevision: profile.revision,
        stream: true, messages: request.messages,
      })
      let error = ''
      for await (const event of current.run.events) {
        if (event.type === 'delta') {
          const follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48
          if (!reply.text && !signal.aborted) setStatus(t('aiAssist.writing'))
          reply.text += event.text
          stream.textContent = reply.text
          if (follow) scrollToEnd()
        } else if (event.type === 'done') {
          reply.text = event.text
          reply.status = wasTruncated(event.finishReason) ? 'truncated' : 'complete'
        } else if (event.type === 'cancelled') reply.status = 'stopped'
        else error = describeAiError(event.error)
      }
      const stored = await finishChatTurn(work, saved.id, turn.id, reply).catch((cause) => {
        // The answer can still be copied when a local write fails.
        remember({ ...saved, turns: [...saved.turns.slice(0, -1), { ...turn, reply }] })
        throw cause
      })
      if (!stored && !signal.aborted) {
        chats = await listBookChats(work)
        selected = chats.find(({ id }) => id === saved.id)
        paintHistory()
        throw new Error(t('aiChat.changed'))
      }
      if (stored) remember(stored)
      if (!signal.aborted) setStatus(error || (reply.status === 'complete' ? t('aiChat.finished') : ''), Boolean(error), reply.status === 'complete')
    } catch (cause) {
      if (!signal.aborted) setStatus(storageError(cause), true)
    } finally {
      active = undefined
      if (!signal.aborted) {
        paintTranscript()
        paintControls()
      }
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (matchMedia('(pointer: coarse)').matches) input.blur()
    void submit(input.value)
  })
  input.addEventListener('input', paintControls)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault()
      void submit(input.value)
    }
  })
  stop.addEventListener('click', () => {
    if (!active) return
    active.stopped = true
    active.run?.cancel()
    stop.disabled = true
  })
  signal.addEventListener('abort', () => active?.run?.cancel(), { once: true })
  create.addEventListener('click', () => { select(); if (configured) input.focus() })
  history.addEventListener('change', () => select(chats.find(({ id }) => id === history.value)))
  remove.addEventListener('click', async () => {
    const chat = selected
    if (!chat || active || deleting) return
    deleting = true
    paintControls()
    try {
      if (!await confirmDialog(t('aiChat.deleteTitle'), [t('aiChat.deleteCopy', [chatTitle(chat)])], t('aiChat.delete'), true) || signal.aborted) return
      await deleteBookChat(work, chat.id)
      if (signal.aborted) return
      chats = chats.filter(({ id }) => id !== chat.id)
      select(chats[0])
    } catch (cause) {
      if (!signal.aborted) setStatus(storageError(cause), true)
    } finally {
      deleting = false
      if (!signal.aborted) { paintTranscript(); paintControls() }
    }
  })
  help.hidden = true
  setStatus('')
  paintControls()

  return {
    panel, open,
    refreshEditing() {
      for (const insert of transcript.querySelectorAll<HTMLButtonElement>('.ai-chat-insert')) insert.hidden = !options.editing()
    },
  }
}
