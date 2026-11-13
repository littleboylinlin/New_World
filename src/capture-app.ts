// The small always-on-top window the desktop shortcut opens: only the quick note form.

import { t } from './i18n'
import { captureForm } from './idea-capture'
import { element } from './ui'

const desktop = window.newWorldDesktop
document.documentElement.classList.add('capture-window')
document.title = t('ideas.capture')

const panel = element('main', 'capture-panel')
const heading = element('h1', 'capture-title', t('ideas.capture'))
const hide = () => { void desktop?.hideCapture?.() }
const capture = captureForm(() => { window.setTimeout(hide, 450) }, hide)
panel.append(heading, capture.form)
document.body.replaceChildren(panel)

async function shown() {
  await capture.refresh()
  capture.focus()
}
desktop?.onCaptureShown?.(() => { void shown() })
void shown()
