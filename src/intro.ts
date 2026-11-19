// Bridge to public/intro.js, the desktop cold-start intro that plays before this bundle loads.

declare global {
  interface Window {
    /** Present only while the cold-start intro is playing. */
    newWorldIntro?: { ready: () => void }
  }
}

/** Lets the intro open its door: the first page is on screen behind it. */
export function introReady() {
  window.newWorldIntro?.ready()
}
