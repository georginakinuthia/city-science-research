/**
 * Baseline for grid projection, geographic potential fields, and Dijkstra
 * distances on a fixed scenario. Keep the fixture independent of the map
 * datasets so a deployment's site layers can change without changing this test.
 */
import { bbox, bboxPolygon, buffer, featureCollection, point } from '@turf/turf'
import { describe, expect, it } from 'vitest'

import { GEOMETRY } from '../../config'
import { Simulation } from '../../sim/Simulation'
import { ScenarioContainer } from '../../sim/scenarioGen'
import { buildNodesFromCollection, computePatchesWidth, type ScenarioData } from '../geo'

const scenarioData: ScenarioData = {
  surfaces: featureCollection([
    bboxPolygon([-99.1888, 19.4020, -99.18802, 19.40254]),
    bboxPolygon([-99.1879, 19.40230, -99.18765, 19.40258]),
  ]),
  structures: featureCollection([]),
  shade: featureCollection([bboxPolygon([-99.18848, 19.40229, -99.18813, 19.40252])]),
  stalls: featureCollection([bboxPolygon([-99.18852, 19.40204, -99.18838, 19.40228])]),
  furniture: featureCollection([bboxPolygon([-99.18836, 19.40230, -99.18823, 19.40249])]),
}

const nodesGeoJSON = featureCollection([
  point([-99.18865, 19.40212], {}, { id: 'west-entry' }),
  point([-99.18814, 19.40234], {}, { id: 'east-exit' }),
  point([-99.18777, 19.40242], {}, { id: 'isolated-entry' }),
  point([-99.18798, 19.40250], {}, { id: 'off-surface' }),
])

// ─────────────────────────────────────────────────────────────
// Summary stat helpers (coordinate-invariant)
// ─────────────────────────────────────────────────────────────

interface FieldStats {
  length: number
  finiteCount: number
  positiveCount: number
  negativeCount: number
  zeroCount: number
  sumFinite: string
  minFinite: string | null
  maxFinite: string | null
  meanFinite: string | null
  varianceFinite: string | null
  infiniteCount: number
}

function summarize(arr: Float32Array): FieldStats {
  let finiteCount = 0
  let positiveCount = 0
  let negativeCount = 0
  let zeroCount = 0
  let infiniteCount = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity

  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]!
    if (!Number.isFinite(v)) { infiniteCount++; continue }
    finiteCount++
    sum += v
    if (v < min) min = v
    if (v > max) max = v
    if (v > 0) positiveCount++
    else if (v < 0) negativeCount++
    else zeroCount++
  }

  const mean = finiteCount > 0 ? sum / finiteCount : null

  // Second pass for variance
  let variance: number | null = null
  if (finiteCount > 0 && mean !== null) {
    let ssq = 0
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]!
      if (!Number.isFinite(v)) continue
      const d = v - mean
      ssq += d * d
    }
    variance = ssq / finiteCount
  }

  const fx = (n: number | null) =>
    n === null ? null : Number.isFinite(n) ? n.toFixed(6) : String(n)

  return {
    length: arr.length,
    finiteCount,
    positiveCount,
    negativeCount,
    zeroCount,
    infiniteCount,
    sumFinite: fx(sum)!,
    minFinite: finiteCount > 0 ? fx(min) : null,
    maxFinite: finiteCount > 0 ? fx(max) : null,
    meanFinite: fx(mean),
    varianceFinite: fx(variance),
  }
}

// ─────────────────────────────────────────────────────────────
// The test
// ─────────────────────────────────────────────────────────────

describe('simulation scenario baseline fixture', () => {
  const bufferedSurfaces = buffer(scenarioData.surfaces, GEOMETRY.bboxPaddingMeters, { units: 'meters' })
  if (!bufferedSurfaces) throw new Error('Baseline fixture has no buffered surfaces.')
  const bounds = bbox(bufferedSurfaces) as [number, number, number, number]
  const patchesWidth = computePatchesWidth(bounds, GEOMETRY.targetPatchMeters)
  const sim = new Simulation(bounds, patchesWidth)

  const nodes = buildNodesFromCollection(nodesGeoJSON).map((node) => {
    const [lon, lat] = node.coords!
    return { ...node, worldX: sim.lonToX(lon), worldY: sim.latToY(lat) }
  })

  sim.generateScenario(new ScenarioContainer(scenarioData, 'baseline-fixture'), nodes)

  it('world dimensions match expected values', () => {
    const snapshot = {
      width: sim.width,
      height: sim.height,
      cellCount: sim.cellCount,
      bbox: bounds.map((v: number) => v.toFixed(9)),
      patchesWidth,
    }
    expect(snapshot).toMatchSnapshot()
  })

  it('surface potential summary stats', () => {
    expect(summarize(sim.surfacePotential)).toMatchSnapshot()
  })

  it('stall potential summary stats', () => {
    expect(summarize(sim.stallPotential)).toMatchSnapshot()
  })

  it('furniture potential summary stats', () => {
    expect(summarize(sim.furniturePotential)).toMatchSnapshot()
  })

  it('shade potential summary stats', () => {
    expect(summarize(sim.shadePotential)).toMatchSnapshot()
  })

  it('node distance fields — per-node summary stats', () => {
    const fields = sim.nodeDistanceFields
    const perNode: Record<string, FieldStats> = {}
    // Sort by interned node id string (original order) — index into
    // nodeDistanceFields is the interned index, which was assigned in
    // scenario-load order.
    const idsWithIdx: Array<[string, number]> = sim.nodeIdTable.map((id, idx) => [id, idx])
    idsWithIdx.sort((a, b) => a[0].localeCompare(b[0]))
    for (const [id, idx] of idsWithIdx) {
      const field = fields[idx]
      if (!field) continue
      perNode[id] = summarize(field)
    }
    expect(perNode).toMatchSnapshot()
  })

  it('projected node world coordinates', () => {
    const projected: Record<string, { worldX: string; worldY: string }> = {}
    for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      projected[node.id] = {
        worldX: node.worldX.toFixed(6),
        worldY: node.worldY.toFixed(6),
      }
    }
    expect(projected).toMatchSnapshot()
  })

  it('distance field spot-checks — geographic round trips and reachable nodes', () => {
    const targetNode = 'west-entry'
    const field = sim.nodeDistanceFields[sim.nodeIdxFor(targetNode)]!
    const checks: Record<string, {
      x: number; y: number; idx: number; dist: string
    }> = {}
    for (const { id, coords } of nodes) {
      const [lon, lat] = coords!
      const fx = sim.lonToX(lon)
      const fy = sim.latToY(lat)
      expect(sim.xToLon(fx)).toBeCloseTo(lon, 9)
      expect(sim.yToLat(fy)).toBeCloseTo(lat, 9)
      const x = Math.round(fx)
      const y = Math.round(fy)
      const idx = sim.idx(x, y)
      checks[id] = { x, y, idx, dist: field[idx]!.toFixed(6) }
    }
    expect(field[checks[targetNode]!.idx]).toBe(0)
    expect(field[checks['east-exit']!.idx]).toBeGreaterThan(0)
    expect(field[checks['east-exit']!.idx]).toBeLessThan(Infinity)
    expect(field[checks['isolated-entry']!.idx]).toBe(Infinity)
    expect(field[checks['off-surface']!.idx]).toBe(Infinity)
    expect({ targetNode, samples: checks }).toMatchSnapshot()
  })
})
