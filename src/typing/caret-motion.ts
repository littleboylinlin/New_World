import './typing.css'
import { reducedMotion } from '../motion'

/**
 * Damping shared by every smooth caret. The remaining distance decays exponentially with a
 * time constant of 80ms, and never slower than the distance at the last move divided by 150ms,
 * so the caret visibly slides while typing yet always arrives within 150ms of the last key.
 */
export const caretDamping = { timeConstant: 80, settle: 150, lagCharacters: 1.5 } as const

/**
 * glide: follow with a lag of at most 1.5 characters (ordinary typing).
 * wrap: jump to the new line's start horizontally and slide down, like a carriage return.
 * commit: slide the whole way (an input method replaced its reading with the chosen word).
 * snap: arrive at once.
 */
export type CaretMove = 'glide' | 'wrap' | 'commit' | 'snap'
export interface CaretPoint { x: number; y: number }

const precision = .25

export function caretFollower(paint: (point: CaretPoint) => void) {
  let position: CaretPoint | undefined
  let target: CaretPoint | undefined
  let floor = 0
  let frame = 0
  let last = 0

  function settle() {
    cancelAnimationFrame(frame)
    frame = 0
    last = 0
  }

  function step(now: number) {
    frame = 0
    if (!position || !target) return
    const elapsed = Math.max(now - last, 0)
    last = now
    const dx = target.x - position.x, dy = target.y - position.y
    const distance = Math.hypot(dx, dy)
    const next = Math.max(0, Math.min(distance * Math.exp(-elapsed / caretDamping.timeConstant), distance - floor * elapsed))
    if (next < precision) position = { ...target }
    else position = { x: target.x - dx * next / distance, y: target.y - dy * next / distance }
    paint(position)
    if (next < precision) last = 0
    else frame = requestAnimationFrame(step)
  }

  return {
    get position() { return position },
    get target() { return target },
    get moving() { return frame !== 0 },
    /** characterWidth bounds how far a glide may trail behind its target; since marks when the edit occurred. */
    move(point: CaretPoint, kind: CaretMove, characterWidth = 0, since?: number) {
      target = { ...point }
      if (!position || kind === 'snap' || reducedMotion.matches) {
        settle()
        position = { ...point }
        paint(position)
        return
      }
      if (kind === 'wrap') position = { x: point.x, y: position.y }
      const lag = caretDamping.lagCharacters * characterWidth
      let distance = Math.hypot(point.x - position.x, point.y - position.y)
      if (kind === 'glide' && lag > 0 && distance > lag) {
        position = { x: point.x + (position.x - point.x) * lag / distance, y: point.y + (position.y - point.y) * lag / distance }
        distance = lag
      }
      if (distance < precision) {
        settle()
        position = { ...point }
        paint(position)
        return
      }
      const now = Number(document.timeline.currentTime ?? performance.now())
      const waited = since !== undefined ? Math.min(Math.max(performance.now() - since, 0), caretDamping.settle / 2) : 0
      floor = distance / Math.max(caretDamping.settle - waited, 40)
      paint(position)
      if (!frame) {
        // Count from this frame's start, like the timestamps requestAnimationFrame passes.
        last = now
        frame = requestAnimationFrame(step)
      }
    },
    /** Keep the caret where it is on screen but forget it, so the next move snaps. */
    reset() {
      settle()
      position = target = undefined
    },
    destroy() { settle() },
  }
}
