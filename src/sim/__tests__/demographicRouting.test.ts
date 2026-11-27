import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson'
import { afterEach, describe, expect, it } from 'vitest'

import { TACUBAYA_CROWD, WEIDMANN } from '../../config'
import {
  buildRoutingCosts,
  computeNodeDistanceField,
  DemographicProfile,
  type NodeState,
  requiresStepFree,
} from '../../stores/geo'
import {
  advanceAgent,
  createDefaultBehaviorParams,
  getAgentVisualRisk,
  initialiseAgent,
  recomputeAgentParams,
  setBehaviorParams,
} from '../agentBehavior'
import { ScenarioContainer } from '../scenarioGen'
import { ENGAGEMENT_WAITING, Simulation } from '../Simulation'

function collection(...features: Feature<Geometry>[]): FeatureCollection<Geometry> {
  return { type: 'FeatureCollection', features }
}

function line(coordinates: Position[], properties = {}): Feature<Geometry> {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties }
}

function node(id: string, worldX: number, worldY: number): NodeState {
  return { id, worldX, worldY, pph: 100, interval: 0, noEngagement: true }
}

function buildSimulation() {
  const sim = new Simulation([0, 0, 0.00022, 0.00022], 24)
  const lonLat = (x: number, y: number): Position => [sim.xToLon(x), sim.yToLat(y)]
  const surface: Feature<Geometry> = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        lonLat(-0.4, -0.4), lonLat(23.4, -0.4), lonLat(23.4, 24.4),
        lonLat(-0.4, 24.4), lonLat(-0.4, -0.4),
      ]],
    },
  }
  const setBarrier = (barrierEnd: number, nodes: NodeState[]) => {
    sim.generateScenario(new ScenarioContainer({
      surfaces: collection(surface),
      structures: collection(),
      shade: collection(),
      furniture: collection(),
      stalls: collection(),
      routing: {
        transport: collection(),
        walkways: collection(line([lonLat(11, 0), lonLat(11, barrierEnd)], {
          step_free: 0,
          width: 1,
        })),
      },
    }), nodes)
  }
  return { sim, setBarrier }
}

afterEach(() => {
  setBehaviorParams(createDefaultBehaviorParams())
})

describe('demographic routing', () => {
  it('seeds the full startup crowd on reachable anchors inside the study boundary', () => {
    const sim = new Simulation([0, 0, 0.0012, 0.0012], 120)
    const lonLat = (x: number, y: number): [number, number] => [sim.xToLon(x), sim.yToLat(y)]
    const rectangle = (left: number, top: number, right: number, bottom: number): Position[] => [
      lonLat(left, top), lonLat(right, top), lonLat(right, bottom),
      lonLat(left, bottom), lonLat(left, top),
    ]
    const surface: Feature<Polygon> = {
      type: 'Feature',
      properties: null,
      geometry: { type: 'Polygon', coordinates: [rectangle(1, 1, 118, 118)] },
    }
    const studyArea: Feature<Polygon> = {
      type: 'Feature',
      properties: null,
      geometry: { type: 'Polygon', coordinates: [rectangle(10, 10, 110, 110), rectangle(40, 40, 60, 60)] },
    }
    const walkways = Array.from({ length: 520 }, (_, i) => lonLat(20 + i % 80, 18 + Math.floor(i / 80)))
    const destinations = [lonLat(90, 80)]
    const busStops = [lonLat(80, 90)]
    sim.generateScenario(new ScenarioContainer({
      surfaces: collection(surface),
      structures: collection(),
      shade: collection(),
      furniture: collection(),
      stalls: collection(),
      routing: {
        transport: collection(),
        walkways: collection(),
        studyBoundary: { type: 'FeatureCollection', features: [studyArea] },
        crowd: {
          walkways: [...walkways, lonLat(4, 4), lonLat(50, 50)],
          destinations,
          busStops,
        },
      },
    }), [node('entry-a', 24, 28), node('entry-b', 92, 92)])

    expect(sim.pedAliveCount).toBe(TACUBAYA_CROWD.initialAgents)
    const anchors = new Set([...walkways, ...destinations, ...busStops].map(([lon, lat]) =>
      `${Math.round(sim.lonToX(lon))},${Math.round(sim.latToY(lat))}`,
    ))
    const positions = Array.from({ length: sim.pedCount }, (_, i) => [sim.pedX[i]!, sim.pedY[i]!] as const)
    expect(positions.every(([x, y]) => anchors.has(`${Math.round(x)},${Math.round(y)}`))).toBe(true)
    expect(sim.routingCosts?.walkable[sim.cellAt(4, 4)]).toBe(0)
    expect(sim.routingCosts?.walkable[sim.cellAt(50, 50)]).toBe(0)
    sim.step()
    expect(positions.some(([x, y], i) => x !== sim.pedX[i] || y !== sim.pedY[i])).toBe(true)
  })

  it('prefers a longer lit, transit-connected and wider corridor over a higher-conflict route', () => {
    const grid = { width: 30, height: 30, lonToX: (x: number) => x, latToY: (y: number) => y }
    const at = (x: number, y: number) => y * grid.width + x
    const walkable = new Uint8Array(900)
    for (let x = 3; x <= 26; x++) {
      walkable[at(x, 8)] = 1
      walkable[at(x, 20)] = 1
    }
    for (let y = 8; y <= 20; y++) {
      walkable[at(3, y)] = 1
      walkable[at(26, y)] = 1
    }
    const costs = buildRoutingCosts({
      transport: collection(line([[3, 20], [26, 20]])),
      walkways: collection(
        line([[3, 8], [26, 8]], { lit: 0, width: 1, crossing_conflict: 'high', stall_congestion: 'heavy' }),
        line([[3, 20], [26, 20]], { lit: 'yes', width_m: 4 }),
        line([[13, 8], [17, 8]], { step_free: '0' }),
        line([[15, 20], [15, 20]], { grade_pct: '-9%' }),
      ),
    }, grid, walkable, undefined)

    for (const weights of [costs.female, costs.child]) {
      expect(weights[at(10, 20)]).toBeLessThan(weights[at(10, 8)]!)
      const field = computeNodeDistanceField([26, 12], grid, walkable, { costs: weights })
      expect(field[at(3, 13)]).toBeLessThan(field[at(3, 11)]!)
    }
    expect(costs.stepFree[at(15, 8)]).toBe(0)
    expect(costs.stepFree[at(15, 20)]).toBe(0)
    const accessible = computeNodeDistanceField([26, 12], grid, costs.stepFree, { stepFree: true })
    expect(accessible[at(3, 12)]).toBe(Infinity)
  })

  it('assigns all five profiles and keeps reduced-mobility agents on a step-free detour', () => {
    setBehaviorParams({
      ...createDefaultBehaviorParams(),
      debugOrcaEnabled: false,
      debugMomentumEnabled: false,
      debugDensityEnabled: false,
      debugFollowingStrength: 0,
      arrivalRadius: 1,
    })
    const { sim, setBarrier } = buildSimulation()
    const start = node('start', 7, 4)
    const target = node('target', 15, 4)
    setBarrier(13, [start, target])

    const seen = new Set<number>()
    let olderAgent = -1
    for (let j = 0; j < 300; j++) {
      const i = sim.spawnAgent()
      initialiseAgent(sim, i, start, target, 0, 0)
      const profile = sim.pedProfile[i]!
      seen.add(profile)
      if (requiresStepFree(profile)) {
        expect(sim.pedSpeed[i]).toBeGreaterThanOrEqual(0.6)
        expect(sim.pedSpeed[i]).toBeLessThanOrEqual(0.85)
        recomputeAgentParams(sim, i)
        expect(sim.pedSpeed[i]).toBeGreaterThanOrEqual(0.6)
        expect(sim.pedSpeed[i]).toBeLessThanOrEqual(0.85)
        expect(sim.pedAlive[i]).toBe(1)
      }
      if (profile === DemographicProfile.isOlderAdult) olderAgent = i
    }
    expect(seen.size).toBe(5)
    expect(olderAgent).toBeGreaterThanOrEqual(0)

    const out = sim.advanceResult
    let detoured = false
    for (let tick = 0; tick < 600 && !out.hasArrived; tick++) {
      advanceAgent(sim, olderAgent, out)
      const cell = sim.pedCellIdx[olderAgent]!
      expect(sim.routingCosts?.stepFree[cell]).toBe(1)
      detoured ||= sim.pedY[olderAgent]! > 13
    }
    expect(detoured).toBe(true)
    expect(out.hasArrived).toBe(true)
  })

  it('keeps a standard agent active when a wall separates it from a nearby destination', () => {
    const { sim, setBarrier } = buildSimulation()
    const start = node('start', 10, 4)
    const target = node('target', 12, 4)
    setBarrier(13, [start, target])
    const wall = sim.cellAt(11, 4)
    sim.routingCosts!.walkable[wall] = 0
    sim.surfacePotential[wall] = -1
    const i = sim.spawnAgent()
    initialiseAgent(sim, i, start, target, 0, 0)
    sim.pedProfile[i] = DemographicProfile.standard

    advanceAgent(sim, i, sim.advanceResult)
    expect(sim.advanceResult.hasArrived).toBe(false)
    expect(sim.pedAlive[i]).toBe(1)
    expect(sim.pedCellIdx[i]).not.toBe(wall)
  })

  it('uses higher free-flow speed only on treated cells within the acceleration limit', () => {
    const { sim, setBarrier } = buildSimulation()
    const start = node('start', 4, 10)
    const target = node('target', 20, 10)
    setBarrier(0, [start, target])
    const i = sim.spawnAgent()
    initialiseAgent(sim, i, start, target, 0, 0)
    sim.pedProfile[i] = DemographicProfile.standard
    sim.pedSpeed[i] = sim.pedCurrentSpeed[i] = 1

    advanceAgent(sim, i, sim.advanceResult)
    expect(sim.pedCurrentSpeed[i]).toBeCloseTo(1)

    sim.setAgentPosition(i, start.worldX!, start.worldY!)
    const cell = sim.pedCellIdx[i]!
    const interventionSpeed = new Float32Array(sim.cellCount).fill(1)
    interventionSpeed[cell] = 1.24
    sim.routingCosts!.interventionSpeed = interventionSpeed
    advanceAgent(sim, i, sim.advanceResult)

    expect(sim.pedCurrentSpeed[i]).toBeCloseTo(1.24)
    expect(sim.pedCellIdx[i]).not.toBeLessThan(0)
    expect(sim.advanceResult.distanceTraveled).toBeCloseTo(1.24 * createDefaultBehaviorParams().baseDeltaTime)
  })

  it('strengthens steering toward mapped waiting space for agents already dwelling', () => {
    const displacement = (dwellPull: number) => {
      const { sim, setBarrier } = buildSimulation()
      const start = { ...node('start', 7, 10), noEngagement: false }
      const target = node('target', 19, 10)
      setBarrier(0, [start, target])
      const i = sim.spawnAgent()
      initialiseAgent(sim, i, start, target, 0, 0)
      sim.pedProfile[i] = DemographicProfile.standard
      sim.pedEngagementMode[i] = ENGAGEMENT_WAITING
      sim.pedEngagementDuration[i] = 60
      const cell = sim.pedCellIdx[i]!
      sim.furniturePotential[cell] = 0.4
      sim.furniturePotential[sim.cellAt(7, 9)] = 0.95
      const pull = new Float32Array(sim.cellCount)
      pull[cell] = dwellPull
      sim.routingCosts!.interventionDwellPull = pull
      advanceAgent(sim, i, sim.advanceResult)
      expect(sim.pedEngagementMode[i]).toBe(ENGAGEMENT_WAITING)
      return start.worldY! - sim.pedY[i]!
    }

    expect(displacement(0.4)).toBeGreaterThan(displacement(0))
  })

  it('colors only for high local density or crime proximity', () => {
    const { sim, setBarrier } = buildSimulation()
    const start = node('start', 7, 4)
    const target = node('target', 15, 4)
    setBarrier(13, [start, target])
    const i = sim.spawnAgent()
    initialiseAgent(sim, i, start, target, 0, 0)
    const cell = sim.pedCellIdx[i]!
    const crimeProximity = new Uint8Array(sim.cellCount)
    sim.routingCosts!.visualRisk = crimeProximity

    expect(getAgentVisualRisk(sim, i)).toBe(0)
    const neighborhoodArea = (WEIDMANN.densityRadius * 2 + 1) ** 2 * sim.metersPerCell ** 2
    sim.density[cell] = Math.ceil(1.6 * neighborhoodArea)
    expect(getAgentVisualRisk(sim, i)).toBe(1)

    const crowdCapacity = new Float32Array(sim.cellCount).fill(1)
    crowdCapacity[cell] = 1.35
    sim.routingCosts!.crowdCapacity = crowdCapacity
    expect(getAgentVisualRisk(sim, i)).toBe(0)
    sim.density[cell] *= 2
    expect(getAgentVisualRisk(sim, i)).toBe(1)

    crimeProximity[cell] = 2
    expect(getAgentVisualRisk(sim, i)).toBe(2)
    sim.density[cell] = 0
    crimeProximity[cell] = 0
    expect(getAgentVisualRisk(sim, i)).toBe(0)
  })

  it('rejects unavailable accessible trips and prevents arrivals across a nearby barrier', () => {
    const { sim, setBarrier } = buildSimulation()
    const start = node('start', 10, 4)
    const target = node('target', 12, 4)
    setBarrier(24, [start, target])
    let rejected = 0
    for (let j = 0; j < 80; j++) {
      const i = sim.spawnAgent()
      initialiseAgent(sim, i, start, target, 0, 0)
      if (requiresStepFree(sim.pedProfile[i]!)) {
        expect(sim.pedAlive[i]).toBe(0)
        rejected++
      }
    }
    expect(rejected).toBeGreaterThan(0)

    setBarrier(13, [start, target])
    setBehaviorParams({ ...createDefaultBehaviorParams(), arrivalRadius: 2.5 })
    let tested = false
    for (let j = 0; j < 80 && !tested; j++) {
      const i = sim.spawnAgent()
      initialiseAgent(sim, i, start, target, 0, 0)
      if (requiresStepFree(sim.pedProfile[i]!)) {
        expect(sim.pedAlive[i]).toBe(1)
        advanceAgent(sim, i, sim.advanceResult)
        expect(sim.advanceResult.hasArrived).toBe(false)
        tested = true
      }
    }
    expect(tested).toBe(true)
  })
})
