/**
 * Worker-safe scenario generation utilities.
 *
 * Extracted from `src/stores/scenarios.ts` so the worker can import the
 * potential-surface computation and `ScenarioContainer` class without
 * dragging Vue/Pinia into the worker bundle. The Pinia store itself
 * (`useScenariosStore`) still lives in `src/stores/scenarios.ts` and
 * imports from here for the shared class definition.
 */

import { distanceTransform, EUCLEDIAN } from '@thi.ng/distance-transform'
import { intBuffer } from '@thi.ng/pixel'
import type { FeatureCollection, Geometry } from 'geojson'

import {
  buildPedestrianGrid,
  buildRoutingCosts,
  computeNodeDistanceField,
  computeShortestPath,
  DECAY_FACTORS,
  featureMask,
  type GridLike,
  type NodeState,
  type RoutingCosts,
  type RoutingData,
  type ScenarioData,
  walkwayMask,
} from '../stores/geo'

/**
 * Compute a signed potential field for the given feature collection.
 * Inside cells get `+distance/decay` clamped to 1. Outside cells on the
 * walkable surface get `-distance/(decay*4)` clamped to -1 (repulsive).
 * Cells off the walkable surface get -1 (unwalkable sentinel).
 */
export function potentialsSurface(
  feats: FeatureCollection<Geometry> | null | undefined,
  grid: GridLike,
  decay: number,
  walkableSurfaceFeat: FeatureCollection<Geometry> | null | undefined,
): Float32Array {
  if (!Array.isArray(feats?.features) || !feats.features.length) return new Float32Array(grid.width * grid.height)

  const featMask = featureMask(feats, grid)
  const walkMask = feats === walkableSurfaceFeat ? featMask : featureMask(walkableSurfaceFeat, grid)
  return potentialsFromMasks(featMask, walkMask, grid, decay, false)
}

function potentialsFromMasks(
  featMask: Uint8Array,
  walkMask: Uint8Array,
  grid: GridLike,
  decay: number,
  includeObstacleSources = true,
): Float32Array {
  const { width: numX, height: numY } = grid
  const numP = featMask.length
  if (includeObstacleSources && !featMask.includes(1)) {
    return new Float32Array(numP).fill(walkMask === featMask ? -1 : 0)
  }

  // Inside distance-to-boundary (Euclidean on a 0/1 mask).
  const maskInside = new Uint8Array(numP)
  for (let i = 0; i < numP; i++) maskInside[i] = featMask[i] ? 0 : 1

  const bufInside = intBuffer(numX, numY)
  for (let y = 0; y < numY; y++) {
    const rowOffset = y * numX
    for (let x = 0; x < numX; x++) {
      bufInside.setAt(x, y, maskInside[rowOffset + x] ?? 0)
    }
  }
  const distOnInside: Float32Array = distanceTransform(bufInside, EUCLEDIAN, 0)

  // Outside geodesic distance constrained to walkable mask — gradients
  // stop at non-walkable edges instead of leaking around obstacles.
  let distOnOutside: Float32Array | undefined
  if (walkMask !== featMask) {
    const domain = includeObstacleSources
      ? walkMask.map((walkable, index) => walkable || featMask[index]!)
      : walkMask
    distOnOutside = computeShortestPath(featMask, domain, grid)
  }

  const potentials = new Float32Array(numP)
  for (let i = 0; i < numP; i++) {
    if (featMask[i]) {
      const d = distOnInside[i] ?? 0
      potentials[i] = Math.min(1, d / decay)
    } else {
      if (!walkMask[i]) {
        potentials[i] = -1
      } else {
        const d = distOnOutside?.[i] ?? 0
        potentials[i] = -Math.min(1, d / (decay * 4))
      }
    }
  }

  return potentials
}

/**
 * Container for a single scenario's feature collections and their
 * derived potential surfaces + node distance fields.
 *
 * Pure data class: no Vue, no Pinia, no reactive refs. Instantiated on
 * both the main thread (for loading/UI) and inside the sim worker (for
 * baking potentials into `Simulation` fields).
 */
export class ScenarioContainer implements ScenarioData {
  surfaces!: FeatureCollection<Geometry>
  structures!: FeatureCollection<Geometry>
  shade!: FeatureCollection<Geometry>
  stalls!: FeatureCollection<Geometry>
  furniture!: FeatureCollection<Geometry>
  routing?: RoutingData
  routingCosts?: RoutingCosts
  staticObstaclePotentials?: Float32Array
  private grid?: GridLike
  private pedestrianGrid?: ReturnType<typeof buildPedestrianGrid>

  surfacesPotentials?: Float32Array
  stallsPotentials?: Float32Array
  furniturePotentials?: Float32Array
  shadePotentials?: Float32Array
  nodeDistanceFields?: Map<string, Float32Array>

  constructor(
    data: ScenarioData,
    public name?: string,
  ) {
    Object.assign(this, data)
  }

  private getPedestrianGrid(grid: GridLike) {
    if (grid !== this.grid) {
      this.grid = grid
      this.pedestrianGrid = this.routing && buildPedestrianGrid(this.routing, this.structures, this.stalls, grid)
    }
    return this.pedestrianGrid
  }

  generatePotentials(grid: GridLike): void {
    const pedestrian = this.getPedestrianGrid(grid)
    if (pedestrian) {
      const walkable = pedestrian.walkable
      this.surfacesPotentials = potentialsFromMasks(walkable, walkable, grid, DECAY_FACTORS.SURFACE)
      this.staticObstaclePotentials = potentialsFromMasks(pedestrian.obstacles, walkable, grid, DECAY_FACTORS.FURNITURE)
      this.stallsPotentials = potentialsFromMasks(pedestrian.stalls, walkable, grid, DECAY_FACTORS.STALLS)
      if (this.routing?.interventionZones?.features.length && this.furniture.features.length) {
        const reachableFurniture = featureMask(this.furniture, grid)
        for (let i = 0; i < reachableFurniture.length; i++) {
          if (!walkable[i]) reachableFurniture[i] = 0
        }
        this.furniturePotentials = potentialsFromMasks(reachableFurniture, walkable, grid, DECAY_FACTORS.FURNITURE)
      } else {
        this.furniturePotentials = new Float32Array(walkable.length)
      }
      this.shadePotentials = potentialsFromMasks(featureMask(this.shade, grid), walkable, grid, DECAY_FACTORS.SHADE)
      return
    }

    this.staticObstaclePotentials = undefined
    this.surfacesPotentials = potentialsSurface(
      this.surfaces,
      grid,
      DECAY_FACTORS.SURFACE,
      this.surfaces,
    )
    this.stallsPotentials = potentialsSurface(
      this.stalls,
      grid,
      DECAY_FACTORS.STALLS,
      this.surfaces,
    )
    this.furniturePotentials = potentialsSurface(
      this.furniture,
      grid,
      DECAY_FACTORS.FURNITURE,
      this.surfaces,
    )
    this.shadePotentials = potentialsSurface(
      this.shade,
      grid,
      DECAY_FACTORS.SHADE,
      this.surfaces,
    )
  }

  private legacyWalkabilityMask(grid: GridLike, includeWalkways: boolean): Uint8Array {
    // Walkable = on-surface AND off-stall AND off-furniture.
    const surfacesMask = featureMask(this.surfaces, grid)
    const stallsMask = featureMask(this.stalls, grid)
    const furnitureMask = featureMask(this.furniture, grid)
    const walkwayConnections = includeWalkways && this.routing && walkwayMask(this.routing.walkways, grid)
    const structuresMask = walkwayConnections ? featureMask(this.structures, grid) : undefined
    const studyBoundary = this.routing?.studyBoundary
    const studyMask = studyBoundary && featureMask(studyBoundary, grid)

    const numP = surfacesMask.length
    const walkabilityMask = new Uint8Array(numP)
    for (let i = 0; i < numP; i++) {
      const onRoute = surfacesMask[i] || (walkwayConnections && walkwayConnections[i] && !structuresMask?.[i])
      walkabilityMask[i] = onRoute && (!studyMask || studyMask[i]) && !stallsMask[i] && !furnitureMask[i] ? 1 : 0
    }

    return walkabilityMask
  }

  generateNodeDistanceFields(grid: GridLike, nodes: NodeState[], includeWalkways = false): void {
    const pedestrian = this.getPedestrianGrid(grid)
    const walkabilityMask = pedestrian?.walkable ?? this.legacyWalkabilityMask(grid, includeWalkways)
    this.routingCosts = this.routing
      ? buildRoutingCosts(this.routing, grid, walkabilityMask, this.stallsPotentials)
      : undefined
    if (this.routingCosts && pedestrian) {
      this.routingCosts.pedestrian = pedestrian
      this.routingCosts.staticObstaclePotentials = this.staticObstaclePotentials
    }

    this.nodeDistanceFields = new Map()
    for (const node of nodes) {
      if (node.worldX == null || node.worldY == null) continue
      const distances = computeNodeDistanceField(
        [node.worldX, node.worldY],
        grid,
        walkabilityMask,
      )
      this.nodeDistanceFields.set(node.id, distances)
    }
  }
}
