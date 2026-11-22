// @vitest-environment node

import { afterEach, expect, it, vi } from 'vitest'

import { TIMING } from '../../config'
import { createDefaultBehaviorParams } from '../agentBehavior'
import { SimWorkerClient } from '../workerClient'
import type { InitMessage, WorkerResponse } from '../workerProtocol'

afterEach(() => vi.unstubAllGlobals())

it('rejects INIT with the original worker error message', async () => {
  const workerScope = {
    onmessage: null as ((event: { data: InitMessage }) => void) | null,
    postMessage: (_data: WorkerResponse) => {},
  }
  vi.stubGlobal('self', workerScope)
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: WorkerResponse }) => void

    constructor() {
      workerScope.postMessage = (data) => this.onmessage?.({ data })
    }

    postMessage(data: InitMessage) {
      workerScope.onmessage?.({ data })
    }

    terminate() {}
  })
  await import('../worker')

  const empty = { type: 'FeatureCollection', features: [] }
  const client = new SimWorkerClient()
  await expect(client.init({
    mode: 'single',
    bbox: [0, 0, 0, 0],
    targetWidth: 3,
    scenarioA: { name: 'A', surfaces: empty, structures: empty, stalls: empty, shade: empty, furniture: empty },
    nodes: [],
    params: createDefaultBehaviorParams(),
    timing: TIMING,
    palette: { transparent: 0, surface: 0, stallStops: [0, 0], furnitureStops: [0, 0], shadeStops: [0, 0] },
  })).rejects.toThrow('Cannot initialize the simulation with an invalid grid.')
  client.dispose()
})
