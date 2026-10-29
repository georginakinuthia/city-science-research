import type { FeatureCollection, Geometry } from 'geojson'
import { describe, expect, it } from 'vitest'

import {
  buildNodesFromCollection,
  computeNodeDistanceField,
  computeShortestPath,
  featureMask,
  MinHeap,
} from '../geo'

// Helper: create a mock GridLike with identity coordinate transform.
// Matches the Simulation's new convention: y=0 = north, y grows south.
// Because this mock uses `latToY: (lat) => lat` (identity), polygon
// coordinates in the test geojson still map directly to cell coordinates.
function createMockGrid(width: number, height: number) {
  return {
    width,
    height,
    lonToX: (lon: number): number => lon,
    latToY: (lat: number): number => lat,
  }
}

// Backwards-compat alias — the test was originally written against an
// agentscript-like world object. The helper is now grid-shaped but
// existing test code still reads world.minX/maxY, which we synthesise
// from the width/height on-the-fly.
function createMockWorld(width: number, height: number) {
  return {
    ...createMockGrid(width, height),
    minX: 0,
    maxX: width - 1,
    minY: 0,
    maxY: height - 1,
    numX: width,
    numY: height,
  }
}

// Helper: row-major index matching the new Simulation convention (y=0 = north).
function patchIndex(x: number, y: number, world: ReturnType<typeof createMockWorld>): number {
  return y * world.numX + x
}

// ─── MinHeap ───────────────────────────────────────────────

describe('MinHeap', () => {
  it('pops elements in ascending distance order', () => {
    const heap = new MinHeap()
    heap.push(0, 5)
    heap.push(1, 1)
    heap.push(2, 3)

    expect(heap.pop()).toEqual({ idx: 1, dist: 1 })
    expect(heap.pop()).toEqual({ idx: 2, dist: 3 })
    expect(heap.pop()).toEqual({ idx: 0, dist: 5 })
  })

  it('returns undefined when empty', () => {
    const heap = new MinHeap()
    expect(heap.pop()).toBeUndefined()
  })

  it('reports isEmpty correctly', () => {
    const heap = new MinHeap()
    expect(heap.isEmpty()).toBe(true)
    heap.push(0, 1)
    expect(heap.isEmpty()).toBe(false)
    heap.pop()
    expect(heap.isEmpty()).toBe(true)
  })

  it('handles single element', () => {
    const heap = new MinHeap()
    heap.push(42, 7)
    expect(heap.pop()).toEqual({ idx: 42, dist: 7 })
    expect(heap.isEmpty()).toBe(true)
  })

  it('handles duplicate distances', () => {
    const heap = new MinHeap()
    heap.push(0, 3)
    heap.push(1, 3)
    heap.push(2, 1)

    const first = heap.pop()!
    expect(first.dist).toBe(1)

    const second = heap.pop()!
    const third = heap.pop()!
    expect(second.dist).toBe(3)
    expect(third.dist).toBe(3)
  })

  it('maintains order with many elements', () => {
    const heap = new MinHeap()
    const values = [10, 4, 7, 1, 9, 2, 8, 3, 6, 5]
    values.forEach((v, i) => heap.push(i, v))

    const sorted: number[] = []
    while (!heap.isEmpty()) {
      sorted.push(heap.pop()!.dist)
    }

    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

// ─── buildNodesFromCollection ──────────────────────────────

describe('buildNodesFromCollection', () => {
  it('builds nodes from valid Point features', () => {
    const fc: FeatureCollection<Geometry> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'node-A',
          geometry: { type: 'Point', coordinates: [-13.23, 8.47] },
          properties: { name: 'Market Entry', pph: 20, interval: 5 },
        },
      ],
    }

    const nodes = buildNodesFromCollection(fc)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({
      id: 'node-A',
      label: 'Market Entry',
      pph: 20,
      interval: 5,
      coords: [-13.23, 8.47],
    })
  })

  it('uses index as fallback id', () => {
    const fc: FeatureCollection<Geometry> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: {},
        },
      ],
    }

    const nodes = buildNodesFromCollection(fc)
    expect(nodes[0]!.id).toBe('node-0')
  })

  it('defaults pph to 10 and interval to 0', () => {
    const fc: FeatureCollection<Geometry> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: {},
        },
      ],
    }

    const nodes = buildNodesFromCollection(fc)
    expect(nodes[0]!.pph).toBe(10)
    expect(nodes[0]!.interval).toBe(0)
  })

  it('returns empty array for empty FeatureCollection', () => {
    const fc: FeatureCollection<Geometry> = {
      type: 'FeatureCollection',
      features: [],
    }
    expect(buildNodesFromCollection(fc)).toEqual([])
  })

  it('handles non-Point geometries (no coords)', () => {
    const fc: FeatureCollection<Geometry> = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          properties: { pph: 5 },
        },
      ],
    }

    const nodes = buildNodesFromCollection(fc)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.coords).toBeUndefined()
    expect(nodes[0]!.pph).toBe(5)
  })
})

// ─── featureMask ───────────────────────────────────────────

describe('featureMask', () => {
  it('returns all zeros for empty FeatureCollection', () => {
    const world = createMockWorld(5, 5)
    const fc = { type: 'FeatureCollection', features: [] }

    const mask = featureMask(fc, world)
    expect(mask.length).toBe(25)
    expect(mask.every((v: number) => v === 0)).toBe(true)
  })

  it('returns all zeros for null input', () => {
    const world = createMockWorld(5, 5)
    const mask = featureMask(null, world)
    expect(mask.length).toBe(25)
    expect(mask.every((v: number) => v === 0)).toBe(true)
  })

  it('marks interior cells for a rectangle polygon', () => {
    // 10x10 grid, polygon covers roughly (2,2) to (7,7)
    const world = createMockWorld(10, 10)
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [2, 2],
                [7, 2],
                [7, 7],
                [2, 7],
                [2, 2],
              ],
            ],
          },
          properties: {},
        },
      ],
    }

    const mask = featureMask(fc, world)

    // Center of the polygon should be marked
    expect(mask[patchIndex(4, 4, world)]).toBe(1)
    expect(mask[patchIndex(5, 5, world)]).toBe(1)

    // Outside the polygon should be empty
    expect(mask[patchIndex(0, 0, world)]).toBe(0)
    expect(mask[patchIndex(9, 9, world)]).toBe(0)
  })

  it('handles MultiPolygon geometry', () => {
    const world = createMockWorld(10, 10)
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              // First polygon: small square at (1,1)-(3,3)
              [
                [
                  [1, 1],
                  [3, 1],
                  [3, 3],
                  [1, 3],
                  [1, 1],
                ],
              ],
              // Second polygon: small square at (6,6)-(8,8)
              [
                [
                  [6, 6],
                  [8, 6],
                  [8, 8],
                  [6, 8],
                  [6, 6],
                ],
              ],
            ],
          },
          properties: {},
        },
      ],
    }

    const mask = featureMask(fc, world)

    // Inside first polygon
    expect(mask[patchIndex(2, 2, world)]).toBe(1)
    // Inside second polygon
    expect(mask[patchIndex(7, 7, world)]).toBe(1)
    // Between polygons
    expect(mask[patchIndex(5, 5, world)]).toBe(0)
  })
})

// ─── computeShortestPath ───────────────────────────────────

describe('computeShortestPath', () => {
  it('sets source pixels to distance 0', () => {
    const world = createMockWorld(5, 5)
    const numP = 25
    const sourceMask = new Uint8Array(numP)
    const walkMask = new Uint8Array(numP).fill(1) // all walkable

    // Source at center (2,2)
    const sourceIdx = patchIndex(2, 2, world)
    sourceMask[sourceIdx] = 1

    const distances = computeShortestPath(sourceMask, walkMask, world)
    expect(distances[sourceIdx]).toBe(0)
  })

  it('computes correct distances to adjacent cells', () => {
    const world = createMockWorld(5, 5)
    const numP = 25
    const sourceMask = new Uint8Array(numP)
    const walkMask = new Uint8Array(numP).fill(1)

    const sourceIdx = patchIndex(2, 2, world)
    sourceMask[sourceIdx] = 1

    const distances = computeShortestPath(sourceMask, walkMask, world)

    // Cardinal neighbors should have distance close to 1 (may include edge penalty)
    const rightIdx = patchIndex(3, 2, world)
    const upIdx = patchIndex(2, 3, world)
    expect(distances[rightIdx]).toBeGreaterThan(0)
    expect(distances[rightIdx]).toBeLessThanOrEqual(2) // at most 1 * edge penalty

    expect(distances[upIdx]).toBeGreaterThan(0)
    expect(distances[upIdx]).toBeLessThanOrEqual(2)

    // Diagonal neighbor should be roughly sqrt(2) (possibly with edge penalty)
    const diagIdx = patchIndex(3, 3, world)
    expect(distances[diagIdx]).toBeGreaterThan(0)
    expect(distances[diagIdx]).toBeLessThanOrEqual(3)
  })

  it('non-walkable cells block paths', () => {
    // 5x5 grid with a wall across the middle column
    const world = createMockWorld(5, 5)
    const numP = 25
    const sourceMask = new Uint8Array(numP)
    const walkMask = new Uint8Array(numP).fill(1)

    // Wall: block column x=2 entirely
    for (let y = 0; y <= 4; y++) {
      walkMask[patchIndex(2, y, world)] = 0
    }

    // Source on left side
    sourceMask[patchIndex(0, 2, world)] = 1

    const distances = computeShortestPath(sourceMask, walkMask, world)

    // Right side should be unreachable (Infinity)
    expect(distances[patchIndex(4, 2, world)]).toBe(Infinity)
  })

  it('disconnected walkable region stays at Infinity', () => {
    const world = createMockWorld(5, 5)
    const numP = 25
    const sourceMask = new Uint8Array(numP)
    const walkMask = new Uint8Array(numP)

    // Two disconnected walkable islands
    // Island 1: (0,0) with source
    walkMask[patchIndex(0, 0, world)] = 1
    sourceMask[patchIndex(0, 0, world)] = 1

    // Island 2: (4,4) - no source, not connected
    walkMask[patchIndex(4, 4, world)] = 1

    const distances = computeShortestPath(sourceMask, walkMask, world)

    expect(distances[patchIndex(0, 0, world)]).toBe(0)
    expect(distances[patchIndex(4, 4, world)]).toBe(Infinity)
  })

  it('handles fully non-walkable grid', () => {
    const world = createMockWorld(3, 3)
    const numP = 9
    const sourceMask = new Uint8Array(numP)
    const walkMask = new Uint8Array(numP) // all zeros

    const distances = computeShortestPath(sourceMask, walkMask, world)
    expect(distances.every((d: number) => d === Infinity)).toBe(true)
  })
})

// ─── computeNodeDistanceField ──────────────────────────────

describe('computeNodeDistanceField', () => {
  it('returns 0 at the node position', () => {
    const world = createMockWorld(5, 5)
    const walkMask = new Uint8Array(25).fill(1)

    const distances = computeNodeDistanceField([2, 2], world, walkMask)
    expect(distances[patchIndex(2, 2, world)]).toBe(0)
  })

  it('returns Infinity for out-of-bounds node', () => {
    const world = createMockWorld(5, 5)
    const walkMask = new Uint8Array(25).fill(1)

    const distances = computeNodeDistanceField([10, 10], world, walkMask)
    expect(distances.every((d: number) => d === Infinity)).toBe(true)
  })

  it('returns Infinity when node is on non-walkable cell', () => {
    const world = createMockWorld(5, 5)
    const walkMask = new Uint8Array(25) // all non-walkable

    const distances = computeNodeDistanceField([2, 2], world, walkMask)
    expect(distances.every((d: number) => d === Infinity)).toBe(true)
  })
})
