import { t } from '../i18n'
import { openDatabase, resultOf, writing } from '../library'
import type { Book } from '../library'
import type { StoryWork } from '../story-settings/model'
import type { BookChat, ChatReply, ChatTurn } from './book-chat-model'

const keyOf = (work: StoryWork) => [work.library, work.bookId]
const belongsTo = (chat: BookChat | undefined, work: StoryWork): chat is BookChat =>
  chat?.library === work.library && chat.bookId === work.bookId

export async function listBookChats(work: StoryWork): Promise<BookChat[]> {
  const db = await openDatabase()
  const chats = await resultOf<BookChat[]>(db.transaction('bookChats').objectStore('bookChats').index('byBook').getAll(keyOf(work)))
  return chats.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
}

export async function startChatTurn(work: StoryWork, previous: BookChat | undefined, turn: ChatTurn) {
  const db = await openDatabase()
  const tx = db.transaction(['books', 'bookChats'], 'readwrite', { durability: 'strict' })
  const chats = tx.objectStore('bookChats')
  const { step, done } = writing<BookChat>(tx)
  const current = previous && chats.get(previous.id)
  const owner = tx.objectStore('books').get(keyOf(work))
  owner.onsuccess = step(() => {
    const book: Book | undefined = owner.result
    if (!book || book.workId) throw new Error(t('story.workUnavailable'))
    const stored: BookChat | undefined = current?.result
    if (previous && (!belongsTo(stored, work) || stored.turns.at(-1)?.id !== previous.turns.at(-1)?.id)) {
      throw new Error(t('aiChat.changed'))
    }
    const next: BookChat = { ...work, id: stored?.id ?? crypto.randomUUID(), updatedAt: Date.now(), turns: [...(stored?.turns ?? []), turn] }
    chats.put(next)
    return next
  })
  return done()
}

export async function finishChatTurn(work: StoryWork, chatId: string, turnId: string, reply: ChatReply) {
  const db = await openDatabase()
  const tx = db.transaction('bookChats', 'readwrite', { durability: 'strict' })
  const chats = tx.objectStore('bookChats')
  const { step, done } = writing<BookChat | undefined>(tx)
  const current = chats.get(chatId)
  current.onsuccess = step(() => {
    const stored: BookChat | undefined = current.result
    if (!belongsTo(stored, work)) return
    const turn = stored.turns.find(({ id }) => id === turnId)
    if (!turn || turn.reply) return
    turn.reply = reply
    chats.put(stored)
    return stored
  })
  return done()
}

export async function deleteBookChat(work: StoryWork, chatId: string) {
  const db = await openDatabase()
  const tx = db.transaction('bookChats', 'readwrite', { durability: 'strict' })
  const chats = tx.objectStore('bookChats')
  const { step, done } = writing<void>(tx)
  const current = chats.get(chatId)
  current.onsuccess = step(() => {
    if (belongsTo(current.result, work)) chats.delete(chatId)
  })
  await done()
}
