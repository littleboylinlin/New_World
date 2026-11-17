(() => {
  const root = document.documentElement
  const key = 'nw-site-lang'
  const valid = (value) => value === 'zh' || value === 'en'
  root.classList.add('js')

  let lang = new URLSearchParams(location.search).get('lang')
  if (!valid(lang)) {
    try { lang = localStorage.getItem(key) } catch { lang = null }
  }
  if (!valid(lang)) {
    const preferred = (navigator.languages?.length ? navigator.languages : [navigator.language]).find((item) => /^(zh|en)\b/i.test(item || ''))
    lang = preferred && /^zh/i.test(preferred) ? 'zh' : 'en'
  }

  const apply = (next) => {
    lang = next
    root.lang = next === 'zh' ? 'zh-CN' : 'en'
    root.dataset.lang = next
    for (const node of document.head.querySelectorAll('[data-en]')) {
      const attr = node.tagName === 'TITLE' ? null : 'content'
      if (!node.dataset.zh) node.dataset.zh = attr ? node.getAttribute(attr) : node.textContent
      const text = next === 'en' ? node.dataset.en : node.dataset.zh
      if (attr) node.setAttribute(attr, text)
      else node.textContent = text
    }
  }
  apply(lang)

  window.siteLang = () => lang
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('[data-lang-toggle]')) return
    apply(lang === 'zh' ? 'en' : 'zh')
    try { localStorage.setItem(key, lang) } catch { /* The choice still applies to this page. */ }
    document.dispatchEvent(new CustomEvent('site:lang', { detail: lang }))
  })
})()
