/**
 * Unit tests for the worker's snapshot buffer pool helper.
 * Lives in `src/sim/workerPool.ts` so it can be exercised without
 * instantiating the worker's `self.onmessage` scaffolding.
 */

import { describe, expect, it } from 'vitest'

import { releaseToPool } from '../workerPool'
import type { SnapshotBuffers } from '../workerProtocol'

function makeBuffers(capacity = 16): SnapshotBuffers {
  return {
    pedX: new Float32Array(capacity),
    pedY: new Float32Array(capacity),
    pedHeading: new Float32Array(capacity),
    pedEngagementMode: new Uint8Array(capacity),
    pedVisualRisk: new Uint8Array(capacity),
    pedStartNodeIdx: new Int32Array(capacity),
    pedIntimateViolations: new Uint16Array(capacity),
    pedPersonalViolations: new Uint16Array(capacity),
    pedSocialViolations: new Uint16Array(capacity),
  }
}

describe('releaseToPool', () => {
  it('accepts a buffer when the pool has room', () => {
    const pool: SnapshotBuffers[] = []
    const bufs = makeBuffers()
    const accepted = releaseToPool(pool, bufs, 4)
    expect(accepted).toBe(true)
    expect(pool).toHaveLength(1)
    expect(pool[0]).toBe(bufs)
  })

  it('rejects a buffer when the pool is at capacity', () => {
    const pool = [makeBuffers(), makeBuffers(), makeBuffers(), makeBuffers()]
    const fresh = makeBuffers()
    const accepted = releaseToPool(pool, fresh, 4)
    expect(accepted).toBe(false)
    expect(pool).toHaveLength(4)
    expect(pool).not.toContain(fresh)
  })

  it('caps correctly across a stream of releases', () => {
    const pool: SnapshotBuffers[] = []
    const accepted: boolean[] = []
    for (let i = 0; i < 8; i++) {
      accepted.push(releaseToPool(pool, makeBuffers(), 3))
    }
    expect(pool).toHaveLength(3)
    expect(accepted.filter((a) => a).length).toBe(3)
    expect(accepted.filter((a) => !a).length).toBe(5)
  })
})
