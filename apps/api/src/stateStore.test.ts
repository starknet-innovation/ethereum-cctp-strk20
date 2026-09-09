import { describe, expect, it } from 'vitest'
import { MemoryStateStore } from './stateStore.js'

describe('MemoryStateStore claims', () => {
  it('lets exactly one concurrent claimant win an absent key', async () => {
    const store = new MemoryStateStore()
    const winners = await Promise.all(
      ['a', 'b', 'c', 'd'].map((flow) => store.claim('qrt:entry-claim:0xburn', flow, 60)),
    )
    expect(new Set(winners).size).toBe(1)
    expect(await store.get('qrt:entry-claim:0xburn')).toBe(winners[0])
  })

  it('returns the existing holder instead of overwriting it', async () => {
    const store = new MemoryStateStore()
    expect(await store.claim('k', 'first', 60)).toBe('first')
    expect(await store.claim('k', 'second', 60)).toBe('first')
  })

  it('swaps only for the caller that still sees the expected holder', async () => {
    const store = new MemoryStateStore()
    await store.set('k', 'failed-holder', 60)
    const outcomes = await Promise.all(
      ['r1', 'r2', 'r3'].map((flow) => store.compareAndSwap('k', 'failed-holder', flow, 60)),
    )
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(await store.compareAndSwap('k', 'failed-holder', 'late', 60)).toBe(false)
    expect(await store.compareAndSwap('missing', 'anything', 'x', 60)).toBe(false)
  })

  it('treats an expired claim as absent', async () => {
    const store = new MemoryStateStore()
    await store.set('k', 'stale', 0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await store.claim('k', 'fresh', 60)).toBe('fresh')
  })
})
