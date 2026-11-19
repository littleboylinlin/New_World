// The desktop cold-start intro: "New World" is typed out, the name fades, the door moves to the
// middle and closes, then swings fully open and its frame unfolds from the middle to reveal the home page.
// The main process adds ?intro only to the first visible main window of a launch, so tray, background,
// new and reading windows never play it. It runs before the app bundle and plays while the app loads;
// src/intro.ts tells it when the app is ready. The door, frame, horizon and sun are the parts of
// public/icons/app-light.svg and app-dark.svg, with the same coordinates and stroke widths.
(function () {
  if (!/(?:^\?|&)intro(?:=|&|$)/.test(location.search)) return
  // A reload (for example after a language change) must not play it again.
  try { history.replaceState(history.state, '', location.pathname + location.hash) } catch (error) { /* keep going */ }
  var saved = {}
  try { saved = JSON.parse(localStorage.getItem('new-world:appearance') || '{}') || {} } catch (error) { saved = {} }
  if (saved.intro === false) return
  if (!window.matchMedia || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  if (!document.body || !document.body.animate) return

  // Timeline in milliseconds. The app may only be waited for once the door is shut (WAIT).
  var TYPE_START = 80, CHAR = 55
  var FADE_START = 700, FADE = 200
  var MOVE_START = 900, MOVE = 380
  var CLOSE_START = 1280, CLOSE = 280, BOUNCE = 80
  var WAIT = 1720
  var OPEN = 320
  var EXPAND_START = 2000, EXPAND = 500, REVEAL = 200
  var HOME_START = 2000, HOME = 450, HOME_STEP = 40
  var END = 2500
  var GIVE_UP = 10000

  function bezier(x1, y1, x2, y2) {
    function at(a1, a2, t) { return ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t }
    function slope(a1, a2, t) { return 3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1 }
    return function (x) {
      if (x <= 0) return 0
      if (x >= 1) return 1
      var t = x
      for (var i = 0; i < 8; i++) {
        var d = slope(x1, x2, t)
        if (Math.abs(d) < 1e-6) break
        t -= (at(x1, x2, t) - x) / d
      }
      if (t < 0 || t > 1 || Math.abs(at(x1, x2, t) - x) > 1e-4) {
        var low = 0, high = 1
        t = x
        for (var j = 0; j < 30; j++) {
          if (at(x1, x2, t) < x) low = t; else high = t
          t = (low + high) / 2
        }
      }
      return at(y1, y2, t)
    }
  }
  var exit = bezier(.4, 0, 1, 1)
  var standard = bezier(.2, .75, .25, 1)
  var slam = bezier(.5, 0, .75, 0)
  var spring = bezier(.3, 1.3, .5, 1)
  var unfold = bezier(.7, 0, .2, 1)
  function progress(time, start, length) { return Math.min(1, Math.max(0, (time - start) / length)) }

  var root = document.documentElement
  var theme = root.dataset.theme
  var dark = theme === 'dark' || (theme !== 'white' && theme !== 'beige' && matchMedia('(prefers-color-scheme: dark)').matches)
  // The background is the page's own --paper so nothing jumps when the intro leaves; strokes are the icon's.
  var paper = dark ? '#131210' : theme === 'beige' ? '#ebdfc5' : '#f4eee2'
  var ink = dark ? '#ece6da' : '#16130f'
  var light = dark ? '#f2c66d' : '#e3a33b'

  var svgNs = 'http://www.w3.org/2000/svg'
  function make(name, attributes, parent) {
    var node = document.createElementNS(svgNs, name)
    for (var key in attributes) node.setAttribute(key, attributes[key])
    if (parent) parent.appendChild(node)
    return node
  }

  var style = document.createElement('style')
  style.textContent = [
    '.nw-intro{position:fixed;inset:0;z-index:2147483000;overflow:hidden;background:' + paper + ';color:' + ink + ';cursor:default;user-select:none;-webkit-user-select:none;-webkit-app-region:no-drag}',
    '.nw-intro-lockup{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:.42em;font:900 clamp(30px,5vw,46px)/1 "Arial Black","Segoe UI Black","Helvetica Neue","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;letter-spacing:.01em;white-space:pre}',
    '.nw-intro-slot{flex:none;width:' + (1.5 * 544 / 720).toFixed(4) + 'em;height:1.5em}',
    '.nw-intro-rest{visibility:hidden}',
    '.nw-intro-caret{display:inline-block;width:0;height:1em;vertical-align:-.12em;position:relative}',
    '.nw-intro-caret::after{content:"";position:absolute;left:.04em;top:-.06em;width:.08em;height:1.12em;border-radius:.04em;background:currentColor}',
    '.nw-intro-caret.blink::after{animation:nw-intro-blink 530ms steps(1) infinite}',
    '@keyframes nw-intro-blink{50%{opacity:0}}',
    '.nw-intro-door{position:absolute;left:50%;top:50%;height:min(38vh,280px);aspect-ratio:544/720;transform-origin:50% 50%;will-change:transform}',
    '.nw-intro-door svg{display:block;width:100%;height:100%;overflow:visible}',
  ].join('\n')

  var veil = document.createElement('div')
  veil.className = 'nw-intro'
  veil.setAttribute('aria-hidden', 'true')
  var lockup = document.createElement('div')
  lockup.className = 'nw-intro-lockup'
  var slot = document.createElement('span')
  slot.className = 'nw-intro-slot'
  var name = document.createElement('span')
  var typed = document.createElement('span')
  var caret = document.createElement('span')
  caret.className = 'nw-intro-caret'
  var rest = document.createElement('span')
  rest.className = 'nw-intro-rest'
  var word = 'New World'
  rest.textContent = word
  name.append(typed, caret, rest)
  lockup.append(slot, name)

  var door = document.createElement('div')
  door.className = 'nw-intro-door'
  var svg = make('svg', { viewBox: '240 180 544 720', 'aria-hidden': 'true' })
  // Once the frame starts to unfold, everything outside it is this paper and the page shows inside it.
  var outside = make('path', { fill: paper, 'fill-rule': 'evenodd', display: 'none' }, svg)
  var parts = make('g', { fill: 'none', stroke: ink, 'stroke-width': '56', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg)
  var inside = make('g', {}, parts)
  var backdrop = make('rect', { fill: paper, stroke: 'none' }, inside)
  make('path', { d: 'M556 668 H690', 'stroke-width': '40' }, inside)
  make('path', { d: 'M578 668 a45 45 0 0 1 90 0', 'stroke-width': '40' }, inside)
  var frameRect = make('rect', { rx: '20' }, parts)
  var panel = make('path', { fill: paper }, parts)
  var lines = make('path', {}, parts)
  // The light along the latch edge of the shut door, shown only while waiting for the app.
  var glow = make('path', { d: 'M724 300 V724', stroke: light, 'stroke-width': '14', opacity: '0' }, parts)
  door.appendChild(svg)
  veil.append(lockup, door)
  document.head.appendChild(style)
  document.body.appendChild(veil)

  // The frame, in icon units. It is the icon's until it unfolds.
  var frame = { x: 300, y: 236, width: 424, height: 552 }
  function placeFrame() {
    var keys = ['x', 'y', 'width', 'height']
    for (var i = 0; i < keys.length; i++) {
      frameRect.setAttribute(keys[i], frame[keys[i]].toFixed(2))
      backdrop.setAttribute(keys[i], frame[keys[i]].toFixed(2))
    }
  }

  // The door turns on its left hinge, the frame's left side. Seen from the icon's angle, the free edge moves
  // in by cos(angle) and drops by sin(angle): the icon itself is the door at 60 degrees (x=512, 64 lower).
  var DROP = 64 / Math.sin(Math.PI / 3)
  function point(u, v, cos, sin) { return (frame.x + 424 * cos * u).toFixed(2) + ' ' + (frame.y + v + DROP * sin * u).toFixed(2) }
  function swing(degrees) {
    var angle = degrees * Math.PI / 180
    var cos = Math.cos(angle), sin = Math.sin(angle)
    var tall = frame.height
    panel.setAttribute('d', 'M' + point(0, 0, cos, sin) + ' L' + point(1, 0, cos, sin) + ' L' + point(1, tall, cos, sin) + ' L' + point(0, tall, cos, sin) + ' Z')
    // The two lines of the page sit at the same place on the door, 164 and 254 below its top edge.
    var from = 66 / 212, to = 152 / 212
    lines.setAttribute('d', 'M' + point(from, 164, cos, sin) + ' L' + point(to, 164, cos, sin) + ' M' + point(from, 254, cos, sin) + ' L' + point(to, 254, cos, sin))
  }

  // Where the small door in the lockup sits, relative to the door's place in the middle.
  var start = { x: 0, y: 0, scale: 1 }
  function measure() {
    var from = slot.getBoundingClientRect()
    var to = door.getBoundingClientRect()
    var width = door.offsetWidth, height = door.offsetHeight
    if (!width || !height) return
    var centreX = to.left + to.width / 2, centreY = to.top + to.height / 2
    start = { x: from.left + from.width / 2 - centreX, y: from.top + from.height / 2 - centreY, scale: from.height / height }
  }
  door.style.transform = 'translate(-50%, -50%)'
  measure()

  // The screen's edges in icon units, with room for the stroke, once the door rests in the middle.
  var screen = null
  function measureScreen() {
    var box = door.getBoundingClientRect()
    if (!box.width) return
    var unit = 544 / box.width
    var margin = 60
    screen = {
      x: 240 - box.left * unit - margin,
      y: 180 - box.top * unit - margin,
      right: 240 + (innerWidth - box.left) * unit + margin,
      bottom: 180 + (innerHeight - box.top) * unit + margin,
    }
  }
  function remeasureScreen() { if (screen) measureScreen() }
  function roundRect(x, y, width, height, radius) {
    return 'M' + (x + radius) + ' ' + y + ' H' + (x + width - radius) + ' A' + radius + ' ' + radius + ' 0 0 1 ' + (x + width) + ' ' + (y + radius)
      + ' V' + (y + height - radius) + ' A' + radius + ' ' + radius + ' 0 0 1 ' + (x + width - radius) + ' ' + (y + height)
      + ' H' + (x + radius) + ' A' + radius + ' ' + radius + ' 0 0 1 ' + x + ' ' + (y + height - radius)
      + ' V' + (y + radius) + ' A' + radius + ' ' + radius + ' 0 0 1 ' + (x + radius) + ' ' + y + ' Z'
  }

  var ready = false
  var skipped = false
  var finished = false
  var homePlayed = false
  var clock = 0
  var waited = 0
  var began = performance.now()
  var last = began
  var raf = 0

  function render() {
    var time = clock
    // 1. Typing, with a solid caret that blinks once the name is complete.
    var count = skipped ? word.length : Math.min(word.length, Math.max(0, Math.floor((time - TYPE_START) / CHAR) + 1))
    if (time < TYPE_START) count = 0
    if (typed.textContent.length !== count) {
      typed.textContent = word.slice(0, count)
      rest.textContent = word.slice(count)
    }
    caret.classList.toggle('blink', count === word.length)
    // 2. The name fades and rises a little.
    var fade = skipped ? 1 : exit(progress(time, FADE_START, FADE))
    name.style.opacity = String(1 - fade)
    name.style.transform = 'translateY(' + (-4 * fade).toFixed(2) + 'px)'
    // 3. The door moves from beside the name to the middle and grows.
    var move = skipped ? 1 : standard(progress(time, MOVE_START, MOVE))
    var scale = start.scale + (1 - start.scale) * move
    // 4. It shuts with a small thud.
    var bounce = progress(time, CLOSE_START + CLOSE, BOUNCE)
    if (bounce > 0 && bounce < 1) scale *= 1 + .015 * Math.sin(Math.PI * spring(bounce))
    door.style.transform = 'translate(-50%, -50%) translate(' + (start.x * (1 - move)).toFixed(2) + 'px,' + (start.y * (1 - move)).toFixed(2) + 'px) scale(' + scale.toFixed(4) + ')'
    door.style.opacity = String(Math.min(1, time / 160))
    var shut = skipped ? 1 : slam(progress(time, CLOSE_START, CLOSE))
    // 5. It swings fully open, then the frame unfolds from the middle past the screen's edges and
    // the home page shows through it as the view behind the door fades.
    var open = standard(progress(time, WAIT, OPEN))
    var spread = progress(time, EXPAND_START, EXPAND)
    if (spread > 0) {
      if (!screen) measureScreen()
      var amount = unfold(spread)
      frame = {
        x: 300 + (screen.x - 300) * amount,
        y: 236 + (screen.y - 236) * amount,
        width: 424 + (screen.right - screen.x - 424) * amount,
        height: 552 + (screen.bottom - screen.y - 552) * amount,
      }
      veil.style.background = 'transparent'
      outside.removeAttribute('display')
      outside.setAttribute('d', 'M-100000 -100000 H100000 V100000 H-100000 Z ' + roundRect(frame.x, frame.y, frame.width, frame.height, 20))
    }
    placeFrame()
    inside.setAttribute('opacity', (1 - standard(progress(time, EXPAND_START, REVEAL))).toFixed(3))
    swing(open > 0 ? 90 * open : 60 * (1 - shut))
    // While the app is still loading the shut door breathes a little light through its edge.
    var breathe = time >= WAIT && !ready ? .5 - .5 * Math.cos(waited / 1200 * Math.PI * 2) : 0
    var glowLevel = Math.min(1, waited / 300) * (.5 + .5 * breathe) * (1 - open)
    glow.setAttribute('opacity', glowLevel.toFixed(3))
  }

  function homeEntrance() {
    if (homePlayed) return
    homePlayed = true
    var targets = document.querySelectorAll('.site-header, .app-sidebar, .app-column')
    var order = 0
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i]
      if (!target.getClientRects().length || getComputedStyle(target).display === 'none') continue
      target.animate([{ opacity: 0, transform: 'scale(1.04)' }, { opacity: 1, transform: 'scale(1)' }], {
        duration: HOME, delay: order++ * HOME_STEP, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards',
      })
    }
  }

  function finish(fade) {
    if (finished) return
    finished = true
    cancelAnimationFrame(raf)
    window.removeEventListener('pointerdown', skip, true)
    window.removeEventListener('keydown', skip, true)
    window.removeEventListener('resize', measure)
    window.removeEventListener('resize', remeasureScreen)
    var remove = function () { veil.remove(); style.remove() }
    if (!fade) { remove(); return }
    veil.animate([{ opacity: Number(veil.style.opacity || 1) }, { opacity: 0 }], { duration: fade, easing: 'ease-out', fill: 'forwards' })
    setTimeout(remove, fade + 20)
  }

  function tick(now) {
    var step = Math.min(100, now - last)
    last = now
    if (!ready && now - began > GIVE_UP) ready = true
    clock += step
    if (!ready && clock >= WAIT) {
      waited += step
      clock = WAIT
    }
    if (clock >= HOME_START) homeEntrance()
    render()
    if (clock >= END) { finish(); return }
    raf = requestAnimationFrame(tick)
  }

  // A click or any key skips: straight to the home page when it is ready, otherwise to the shut door.
  function skip(event) {
    if (event.type === 'keydown') {
      event.preventDefault()
      event.stopPropagation()
    }
    if (finished) return
    if (ready) { finish(160); return }
    if (clock < WAIT) {
      skipped = true
      clock = WAIT
      render()
    }
  }
  window.addEventListener('pointerdown', skip, true)
  window.addEventListener('keydown', skip, true)
  window.addEventListener('resize', measure)
  window.addEventListener('resize', remeasureScreen)

  window.newWorldIntro = { ready: function () { ready = true } }
  render()
  raf = requestAnimationFrame(tick)
})()
