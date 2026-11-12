import './styles.css'
import { initializeLanguage } from './i18n'

async function start() {
  try {
    await initializeLanguage()
  } catch {
    const panel = document.createElement('main')
    panel.className = 'shell main-content language-startup'
    panel.setAttribute('role', 'alert')
    const message = document.createElement('p')
    message.textContent = 'Unable to load the language pack. Check your connection and retry. / 无法加载语言包，请联网后重试。'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'button button-primary'
    retry.textContent = 'Retry / 重试'
    retry.addEventListener('click', () => location.reload())
    panel.append(message, retry)
    document.body.replaceChildren(panel)
    return
  }
  await import('./app')
}

void start()
