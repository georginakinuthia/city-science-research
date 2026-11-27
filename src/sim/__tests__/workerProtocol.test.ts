/**
 * Unit tests for the worker message protocol surface.
 *
 * We test the pure utilities (`collectTransferables`) and verify that
 * messages compose into a structured-clone-friendly shape. The worker
 * itself is exercised end-to-end in integration tests (not here).
 */

import { describe, expect, it } from 'vitest'

import {
  collectTransferables,
  type InitMessage,
  type SnapshotBuffers,
  type UpdateNodePphMessage,
} from '../workerProtocol'

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

describe('collectTransferables', () => {
  it('returns one ArrayBuffer per typed-array field, in a stable order', () => {
    const bufs = makeBuffers(8)
    const transferables = collectTransferables(bufs)
    expect(transferables).toHaveLength(9)
    expect(transferables[0]).toBe(bufs.pedX.buffer)
    expect(transferables[1]).toBe(bufs.pedY.buffer)
    expect(transferables[4]).toBe(bufs.pedVisualRisk.buffer)
    expect(transferables[8]).toBe(bufs.pedSocialViolations.buffer)
    // Every element is an ArrayBuffer (the transferable form of a typed array)
    for (const t of transferables) {
      expect(t).toBeInstanceOf(ArrayBuffer)
    }
  })

  it('ArrayBuffer references share identity with the underlying storage', () => {
    // postMessage with a transfer list DETACHES the ArrayBuffer on send.
    // We can verify the references are the same objects without actually
    // posting (which would detach them).
    const bufs = makeBuffers(4)
    const ts = collectTransferables(bufs)
    expect(bufs.pedX.buffer.byteLength).toBe(16)  // 4 * 4 bytes
    expect(ts[0]).toBe(bufs.pedX.buffer)
  })
})

describe('InitMessage shape', () => {
  it('is structured-clone-safe with plain-object scenarios and timing', () => {
    const msg: InitMessage = {
      type: 'INIT',
      mode: 'dual',
      bbox: [0, 0, 1, 1],
      targetWidth: 50,
      scenarioA: {
        name: 'A',
        surfaces: { type: 'FeatureCollection', features: [] },
        structures: { type: 'FeatureCollection', features: [] },
        stalls: { type: 'FeatureCollection', features: [] },
        furniture: { type: 'FeatureCollection', features: [] },
        shade: { type: 'FeatureCollection', features: [] },
      },
      scenarioB: {
        name: 'B',
        surfaces: { type: 'FeatureCollection', features: [] },
        structures: { type: 'FeatureCollection', features: [] },
        stalls: { type: 'FeatureCollection', features: [] },
        furniture: { type: 'FeatureCollection', features: [] },
        shade: { type: 'FeatureCollection', features: [] },
      },
      nodes: [],
      params: {
        behaviorDiversity: 0.5,
        personalSpace: 0.7,
        speedBase: 1.2,
        shoppingProbability: 0.3,
        spareTimeProbability: 0.3,
        isSunny: false,
        arrivalRadius: 1.5,
        nearTargetRadius: 10,
        baseDeltaTime: 0.25,
        debugOrcaEnabled: true,
        debugDensityEnabled: true,
        debugMomentumEnabled: true,
        debugDensityBeta: 1,
        debugMomentumBase: 0.5,
        debugFollowingStrength: 0.6,
      },
      timing: {
        fps: 30,
        baseDeltaTime: 0.25,
        fastModeMultiplier: 4,
        simulationDuration: 3600,
      },
      palette: {
        transparent: 0,
        surface: 0xff000000,
        stallStops: [0, 0xffff0000],
        furnitureStops: [0, 0xff00ff00],
        shadeStops: [0, 0xff0000ff],
      },
    }

    // structuredClone succeeds only if the whole graph is transferable —
    // this is what postMessage runs internally, so if clone works, the
    // message is safe to send.
    const cloned = structuredClone(msg)
    expect(cloned.type).toBe('INIT')
    expect(cloned.timing.fastModeMultiplier).toBe(4)
    expect(cloned.scenarioA.name).toBe('A')
    expect(cloned.palette.surface).toBe(0xff000000)
  })
})

describe('UpdateNodePphMessage shape', () => {
  it('carries a nodeId and new pph value across the worker boundary', () => {
    const msg: UpdateNodePphMessage = {
      type: 'UPDATE_NODE_PPH',
      nodeId: 'node-A',
      pph: 250,
    }
    const cloned = structuredClone(msg)
    expect(cloned.type).toBe('UPDATE_NODE_PPH')
    expect(cloned.nodeId).toBe('node-A')
    expect(cloned.pph).toBe(250)
  })
})
