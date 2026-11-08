// Run with: node shared/chart-ticks.test.mjs
import assert from 'node:assert/strict'
import { fitScaleTicks, labelCenter } from './chart-ticks.js'

const NORMAL = [2, 4, 6, 8, 10, 12]
const TALL = [2, 5, 10, 15, 20]
const PAD_T = 8
const PAD_B = 36
const LABEL_H = 35
const MIN_GAP = 31

// Chart heights from page/index.s.layout.js.
function fit(ticks, max, chartH) {
  const innerH = chartH - PAD_T - PAD_B
  const axisTop = chartH - PAD_B + 2
  return fitScaleTicks(ticks, 2, max, PAD_T, innerH, LABEL_H, axisTop, MIN_GAP)
}

let n = 0
function test(name, fn) {
  fn()
  n++
  console.log('ok -', name)
}

test('Bip Max (275 px) keeps all six labels', () => {
  assert.deepEqual(fit(NORMAL, 12, 275), [12, 10, 8, 6, 4, 2])
})

test('round 466 chart (~185 px) thins to 12, 8, 4', () => {
  assert.deepEqual(fit(NORMAL, 12, 185), [12, 8, 4])
})

test('tall range on a round chart keeps every 2nd label', () => {
  assert.deepEqual(fit(TALL, 20, 185), [20, 10, 2])
})

// The clamped "2" sits only 23 px under "5" here, so they used to overlap.
test('tall range on Bip Max no longer overlaps 5 and 2', () => {
  assert.deepEqual(fit(TALL, 20, 275), [20, 10, 2])
})

test('old 158 px round chart no longer overlaps', () => {
  const kept = fit(NORMAL, 12, 158)
  assert.ok(kept.length >= 2, 'at least two labels')
  assert.ok(kept.length < NORMAL.length, 'labels were thinned')
})

test('no two kept labels closer than minGap, any chart height', () => {
  for (const [ticks, max] of [[NORMAL, 12], [TALL, 20]]) {
    for (let h = 80; h <= 320; h++) {
      const innerH = h - PAD_T - PAD_B
      const axisTop = h - PAD_B + 2
      const kept = fitScaleTicks(ticks, 2, max, PAD_T, innerH, LABEL_H, axisTop, MIN_GAP)
      assert.equal(kept[0], max, `top label kept at h=${h}`)
      for (let i = 1; i < kept.length; i++) {
        const a = labelCenter(kept[i - 1], 2, max, PAD_T, innerH, LABEL_H, axisTop)
        const b = labelCenter(kept[i], 2, max, PAD_T, innerH, LABEL_H, axisTop)
        assert.ok(b - a >= MIN_GAP, `gap ${b - a} at h=${h} between ${kept[i - 1]} and ${kept[i]}`)
      }
    }
  }
})

console.log(`\n${n} chart-ticks tests passed`)
