const data = JSON.parse(document.getElementById('site-data').textContent)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const lang = () => window.siteLang?.() ?? 'zh'

const DOWNLOADS = {
  'windows-x64': { zh: 'Windows', en: 'Windows' },
  'macos-arm64': { zh: 'Apple 芯片', en: 'Apple silicon' },
  'macos-x64': { zh: 'Intel 芯片', en: 'Intel chip' },
}

async function detectPlatform() {
  const ua = navigator.userAgent
  const hints = navigator.userAgentData
  let os = 'other'
  if (hints?.platform === 'Windows' || (!hints?.platform && /Windows NT/.test(ua))) os = 'windows'
  else if (hints?.platform === 'macOS' || (!hints?.platform && /Macintosh|Mac OS X/.test(ua))) os = 'mac'
  // iPadOS reports a Mac user agent; a touch screen gives it away.
  if (os === 'mac' && navigator.maxTouchPoints > 1) os = 'other'
  if (os !== 'mac') return { os, arch: null }
  try {
    const { architecture } = await hints.getHighEntropyValues(['architecture'])
    return { os, arch: architecture === 'arm' ? 'arm64' : architecture === 'x86' ? 'x64' : null }
  } catch {
    return { os, arch: null }
  }
}

function downloadButton(key, tone) {
  const asset = data.latest.assets[key]
  const label = DOWNLOADS[key]
  const link = document.createElement('a')
  link.className = `btn ${tone}`
  link.href = asset.url
  link.dataset.download = key
  link.dataset.sha256 = asset.sha256
  link.title = `${asset.name}\nSHA-256: ${asset.sha256}`
  link.innerHTML = `<span class="btn-face">
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>
    <span data-l="zh">下载</span><span data-l="en" lang="en">Download</span>
    <small><span data-l="zh">${label.zh}</span><span data-l="en" lang="en">${label.en}</span></small>
  </span>`
  return link
}

async function setUpDownloads() {
  const { os, arch } = await detectPlatform()
  let keys = []
  if (os === 'windows') keys = ['windows-x64']
  else if (os === 'mac') keys = arch ? [`macos-${arch}`] : ['macos-arm64', 'macos-x64']
  if (!keys.length) return
  const tones = ['btn-primary', 'btn-primary btn-blue']
  document.getElementById('downloads').replaceChildren(...keys.map((key, index) => downloadButton(key, tones[index])))
}

const PASSAGES = {
  zh: [
    { chapter: '第一章　雾港', text: '雾|从|海面上|漫过来|的时候，|林栖|正把|最后|一盏灯|点亮。|远处|传来|汽笛声，|像|很久以前|有人|喊过|她的|名字。' },
    { chapter: '第二章　回信', text: '她|把|那封|没寄出|的信|又|读了|一遍。|窗外|的雨|刚好|停了，|这一次，|她|决定|亲手|写下|结局。' },
  ],
  en: [
    { chapter: 'CHAPTER ONE', text: 'The fog rolled in from the sea just as Lin lit the last lamp. Far off, a ship’s horn sounded, like someone calling her name long ago.' },
    { chapter: 'CHAPTER TWO', text: 'She read the unsent letter once more. The rain outside had just stopped, and this time she would write the ending herself.' },
  ],
}

function writingDemo() {
  const sheet = document.querySelector('.sheet')
  const text = document.getElementById('demo-text')
  const caret = document.getElementById('demo-caret')
  const chapter = document.getElementById('demo-chapter')
  const count = document.getElementById('demo-count')
  if (!sheet || !text || !caret) return

  let run = 0
  let chars = []
  let shown = 0
  let lineTop = null
  let visible = true
  let resume = null

  const chunksOf = (passage, language) => language === 'zh' ? passage.text.split('|') : [...passage.text]
  const countOf = (value) => lang() === 'zh' ? value.replace(/[\s，。、；：！？“”‘’（）—…,.!?;:'"()-]/g, '').length : value.split(/\s+/).filter(Boolean).length

  function build(passage, language) {
    chapter.textContent = passage.chapter
    chars = []
    const fragment = document.createDocumentFragment()
    for (const ch of chunksOf(passage, language).join('')) {
      const span = document.createElement('span')
      span.className = 'ch'
      span.textContent = ch
      fragment.append(span)
      chars.push(span)
    }
    text.replaceChildren(fragment)
    shown = 0
    lineTop = null
    count.textContent = '0'
  }

  function caretTarget() {
    const box = sheet.getBoundingClientRect()
    const height = caret.offsetHeight
    const anchor = chars[Math.max(shown - 1, 0)]
    if (!anchor) {
      const r = text.getBoundingClientRect()
      return { x: r.left - box.left, y: r.top - box.top }
    }
    const rects = anchor.getClientRects()
    const r = rects[rects.length - 1]
    return { x: (shown ? r.right : r.left) - box.left, y: r.top - box.top + (r.height - height) / 2 }
  }

  function placeCaret(duration) {
    const { x, y } = caretTarget()
    const to = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
    // Moves along a line glide; jumping to a new line is immediate, as in the editor.
    if (duration && lineTop !== null && Math.abs(lineTop - y) < 2) {
      const from = getComputedStyle(caret).transform
      caret.animate([{ transform: from }, { transform: to }], { duration, easing: 'cubic-bezier(.25, .8, .25, 1)' })
    }
    caret.style.transform = to
    lineTop = y
  }

  async function wait(ms, id) {
    await new Promise((resolve) => setTimeout(resolve, ms))
    while (id === run && (!visible || document.hidden)) await new Promise((resolve) => { resume = resolve })
    return id === run
  }

  function showFinal() {
    const passage = PASSAGES[lang()][0]
    build(passage, lang())
    for (const span of chars) span.classList.add('on')
    shown = chars.length
    count.textContent = String(countOf(passage.text.replaceAll('|', '')))
    caret.classList.remove('idle')
    placeCaret(0)
  }

  async function play(id) {
    const language = lang()
    for (let round = 0; ; round++) {
      const passage = PASSAGES[language][round % PASSAGES[language].length]
      build(passage, language)
      text.style.opacity = '1'
      placeCaret(0)
      caret.classList.add('idle')
      if (!await wait(700, id)) return
      caret.classList.remove('idle')
      let typed = ''
      for (const chunk of chunksOf(passage, language)) {
        for (let i = 0; i < chunk.length; i++) chars[shown + i].classList.add('on')
        shown += chunk.length
        typed += chunk
        count.textContent = String(countOf(typed))
        placeCaret(Math.min(70 + chunk.length * 28, 190))
        const last = chunk.at(-1)
        let pause = language === 'zh' ? 150 + Math.random() * 170 : 38 + Math.random() * 62
        if (/[，,;；]/.test(last)) pause += 240
        if (/[。.!?！？]/.test(last)) pause += 420
        if (!await wait(pause, id)) return
      }
      caret.classList.add('idle')
      if (!await wait(2600, id)) return
      await text.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-in', fill: 'forwards' }).finished
      text.getAnimations().forEach((animation) => animation.cancel())
      text.style.opacity = '0'
      if (id !== run) return
    }
  }

  function start() {
    const id = ++run
    resume?.()
    text.style.opacity = '1'
    caret.getAnimations().forEach((animation) => animation.cancel())
    if (reducedMotion.matches) showFinal()
    else play(id)
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) resume?.()
  }).observe(sheet)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume?.() })
  addEventListener('resize', () => placeCaret(0))
  document.addEventListener('site:lang', start)
  reducedMotion.addEventListener('change', start)
  start()
}

function revealOnScroll() {
  const nodes = document.querySelectorAll('[data-reveal]')
  if (reducedMotion.matches || !('IntersectionObserver' in window)) {
    nodes.forEach((node) => node.classList.add('in'))
    return
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('in')
      observer.unobserve(entry.target)
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.15 })
  nodes.forEach((node) => observer.observe(node))
}

setUpDownloads()
writingDemo()
revealOnScroll()
