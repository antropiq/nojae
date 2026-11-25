// Wheel-over-tab-strip scrolling: a vertical notch scrolls the strip sideways,
// but only once its tabs overflow it. While they fit there is nothing to
// scroll, so the event is left alone and the pane under the pointer keeps its
// own vertical scrolling.
//
// Returns the pixels to add to the strip's `scrollLeft`, or null when the
// caller must not consume the event at all.
export function wheelScrollDelta(strip, event) {
  if (!strip || strip.scrollWidth <= strip.clientWidth) return null
  // A trackpad means sideways with `deltaX`, a mouse with the vertical notch:
  // take whichever axis moved more, so a diagonal gesture is read as its
  // dominant axis instead of the two being added.
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return null
  // `deltaMode` counts the deltas in 0 = pixels, 1 = lines, 2 = pages. Firefox
  // reports lines, and reading 3 lines as 3 pixels makes the wheel feel dead
  // there, so each unit becomes pixels before scrolling.
  const unit = [1, 16, strip.clientWidth][event.deltaMode] ?? 1
  return delta * unit
}

// `passive: false` where this is registered is what lets the preventDefault
// run; without the cancel, a notch over the tabs would also scroll the page
// behind them.
export function scrollStripWithWheel(strip, event) {
  const delta = wheelScrollDelta(strip, event)
  if (delta === null) return
  event.preventDefault()
  strip.scrollLeft += delta
}
