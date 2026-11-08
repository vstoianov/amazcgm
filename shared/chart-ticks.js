// Y-axis label selection for the glucose chart. Pure: no Zepp OS imports,
// so it runs in the unit tests too.

/** Y of `mmol` inside the plot, measured from the chart top. */
function tickY(mmol, min, max, padT, innerH) {
  const v = Math.max(min, Math.min(max, mmol))
  return padT + ((max - v) / (max - min)) * innerH
}

/**
 * Centre of a label box of height labelH for `mmol`, after the same clamping
 * the page applies: never above the chart top, never below the hour axis.
 * All values are relative to the chart top.
 */
export function labelCenter(mmol, min, max, padT, innerH, labelH, axisTop) {
  const cy = tickY(mmol, min, max, padT, innerH)
  let y = Math.round(cy - labelH / 2)
  if (y < 0) y = 0
  else if (y + labelH > axisTop) y = axisTop - labelH
  return y + labelH / 2
}

/**
 * Subset of `ticks` whose labels do not overlap. Tries every tick, then
 * every 2nd, every 3rd, ... always starting from the highest value, and
 * returns the first set whose label centres are all at least `minGap`
 * apart. The stride keeps the visible labels evenly spaced. Returns values
 * high to low.
 *
 * axisTop: top of the hour-label row, relative to the chart top.
 */
export function fitScaleTicks(ticks, min, max, padT, innerH, labelH, axisTop, minGap) {
  const sorted = (ticks || []).slice().sort((a, b) => b - a)
  if (sorted.length <= 1) return sorted
  const centers = sorted.map((v) => labelCenter(v, min, max, padT, innerH, labelH, axisTop))
  for (let stride = 1; stride < sorted.length; stride++) {
    const out = [sorted[0]]
    let last = centers[0]
    let ok = true
    for (let i = stride; i < sorted.length; i += stride) {
      if (centers[i] - last < minGap) {
        ok = false
        break
      }
      out.push(sorted[i])
      last = centers[i]
    }
    if (ok) return out
  }
  return [sorted[0]]
}
