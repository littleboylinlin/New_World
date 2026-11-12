// Applies the saved theme, fonts and text size before the first paint.
// src/appearance.ts reads and writes the same record afterwards.
(function () {
  var root = document.documentElement
  var saved = {}
  try { saved = JSON.parse(localStorage.getItem('new-world:appearance') || '{}') || {} } catch (error) { saved = {} }
  function pick(value, allowed, fallback) { return allowed.indexOf(value) >= 0 ? value : fallback }
  root.dataset.theme = pick(saved.theme, ['system', 'white', 'dark', 'beige'], 'system')
  root.dataset.latinFont = pick(saved.latin, ['times', 'georgia', 'lora', 'inter', 'system'], 'times')
  root.dataset.cjkFont = pick(saved.cjk, ['auto', 'song', 'hei', 'kai'], 'auto')
  if (typeof saved.size === 'number' && saved.size >= 14 && saved.size <= 28) root.style.setProperty('--reading-size', Math.round(saved.size) + 'px')
})()
