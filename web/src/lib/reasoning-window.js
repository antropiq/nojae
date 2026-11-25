// The Live View of the reasoning panel: the panel keeps only what its box can
// hold, and what scrolled off above the top leaves the DOM. This is that one
// decision, as a pure function, so the rule can be read and tested without a
// browser, a stream or a layout — what the panel adds around it is only the
// box's height in rows and the painting of the result.
//
// The unit of the budget is a DISPLAY ROW, and units arrive already cut by
// lib/reasoning-lines.js: this never re-cuts, it only slices a row list that is
// already final. Cutting here would make the window a second description of the
// same text, able to drift from the rows the panel paints.
//
// The window is spent from the newest unit backwards, because a flow scrolls
// out of its oldest rows: the newest thinking is always whole, and only the
// oldest unit the window still shows has its head left out.
//
// A flow always shows its tail, because the thinking being read is the part in
// the reader's eyes and an empty panel is worse than a shortened one. A badge is
// whole or left out: it is one call, and half a call is not a thing to show.
//
// A capacity the list cannot exceed (`Infinity`, which is how the panel spells
// "the mode is off") answers with the list itself, unpainted.
//
// The capacity comes from the box's height and one row's height, both read off
// the panel's own elements. The divisor is the row's height alone, because the
// rows of one flow are stacked with no gap — the list's gap sits between
// BLOCKS, so it belongs to the units and their cost, never to a row. Dividing
// by `row + gap` made every row pay for a gap it never gets and left the bottom
// of the box blank.
//
// The answer does not charge for a badge's extra height and the gaps block
// boundaries add. That is deliberate, and it is the only direction that can be
// wrong safely: `useAutoScroll` pins the box's scroll to its bottom, so what
// does not fit is clipped at the TOP — the end the mode discards anyway — while
// a capacity that is too small shows as a strip of blank panel under the last
// line of the flow being read.
export function boxCapacity({ inside, rowHeight }) {
  if (!(inside > 0) || !(rowHeight > 0)) return 0
  return Math.floor(inside / rowHeight)
}

export function selectWindow(units, capacity) {
  if (!(capacity > 0)) return { units, dropped: 0 }

  let left = capacity
  if (left >= units.reduce((sum, unit) => sum + unit.cost, 0)) {
    return { units, dropped: 0 }
  }
  const kept = []
  for (let i = units.length - 1; i >= 0; i -= 1) {
    if (left <= 0) break
    const unit = units[i]
    // A badge is whole or left out: there is no half a call to show. A flow
    // always shows its tail — the thinking that just arrived is the part being
    // read — which also keeps a flow taller than the box from emptying the panel.
    if (unit.rows === null) {
      if (unit.cost > left) continue
      kept.unshift(unit)
      left -= unit.cost
      continue
    }
    // The break below makes the cut happen at most once, so the units older than
    // the cut flow are out as a whole and the window stays one contiguous run.
    const rows = unit.rows.length > left ? unit.rows.slice(unit.rows.length - left) : unit.rows
    kept.unshift(rows.length === unit.rows.length ? unit : { ...unit, rows })
    left -= unit.cost
    // A flow was cut, so the budget is spent: older flows are off the top.
    if (rows.length < unit.rows.length) break
  }

  // Only reasoning rows count as pruned: a badge left out is a call the panel no
  // longer shows, not a line of thinking the user lost, and the "pruned" notice
  // is about the thinking.
  const rows = (list) =>
    list.reduce((sum, unit) => sum + (unit.rows === null ? 0 : unit.rows.length), 0)
  return { units: kept, dropped: rows(units) - rows(kept) }
}

