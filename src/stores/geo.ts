// Pure geographic/algorithmic functions extracted from scenarios.ts
// Separated so they can be tested without triggering Pinia/Vue imports.

import { pointOnFeature } from '@turf/turf'
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon, Position } from 'geojson'

import { GEOMETRY, WGS84 } from '../config'

/** Places display markers on features without changing the simulation geometry. */
export function toMarkerPoints(collection: FeatureCollection<Geometry>): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: collection.features.flatMap((feature) => {
      if (!feature?.geometry) return []
      const { geometry, properties } = feature

      let positions: Position[]
      try {
        positions = geometry.type === 'MultiPoint' ? geometry.coordinates
          : [geometry.type === 'Point' ? geometry.coordinates : pointOnFeature(feature).geometry.coordinates]
      } catch {
        return []
      }
      if (!Array.isArray(positions)) return []
      return positions.filter((position) =>
        Number.isFinite(position?.[0]) && Number.isFinite(position?.[1]),
      ).map((coordinates) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates },
        properties,
      }))
    }),
  }
}

/**
 * Minimal grid interface satisfied by `Simulation` and by the test stub
 * in `scenarios.test.ts`. Coordinate convention is y=0 = north, row-major
 * index `y * width + x`.
 */
export interface GridLike {
  readonly width: number
  readonly height: number
  readonly metersPerCell?: number
  lonToX(lon: number): number
  latToY(lat: number): number
}

/** Shared helper — row-major index, y=0 = north, no flip. */
export function patchIndexOf(grid: GridLike, x: number, y: number): number {
  return y * grid.width + x
}

// Node state exposed to the UI for editing
export interface NodeState {
  id: string
  label?: string
  coords?: [number, number]
  pph: number // persons per hour
  interval: number // minutes between arrivals / departures
  lon?: number // computed world longitude
  lat?: number // computed world latitude
  worldX?: number // computed world X coordinate
  worldY?: number // computed world Y coordinate
  noEngagement?: boolean // when true, agents from this node never shop or wait
}

// Define interfaces for our scenario data
export interface ScenarioData {
  surfaces: FeatureCollection<Geometry>
  structures: FeatureCollection<Geometry>
  shade: FeatureCollection<Geometry>
  stalls: FeatureCollection<Geometry>
  furniture: FeatureCollection<Geometry>
  routing?: RoutingData
  // cached potentials surfaces (added at runtime)
  surfacesPotentials?: Float32Array
  stallsPotentials?: Float32Array
  furniturePotentials?: Float32Array
  shadePotentials?: Float32Array
  // per-node shortest path distance fields (includes curvature penalty)
  nodeDistanceFields?: Map<string, Float32Array>
}

export interface CrowdAnchors {
  walkways: [number, number][]
  destinations: [number, number][]
  busStops?: [number, number][]
}

export interface RoutingData {
  transport: FeatureCollection<Geometry>
  walkways: FeatureCollection<Geometry>
  studyBoundary?: FeatureCollection<Polygon | MultiPolygon>
  crowd?: CrowdAnchors
}

export enum DemographicProfile {
  standard,
  isFemale,
  hasChild,
  isOlderAdult,
  hasDisability,
}

export function requiresStepFree(profile: DemographicProfile): boolean {
  return profile === DemographicProfile.isOlderAdult || profile === DemographicProfile.hasDisability
}

export interface RoutingCosts {
  walkable: Uint8Array
  stepFree: Uint8Array
  female: Float32Array
  child: Float32Array
}

// Constants for potential field decay rates (in meters)
export const DECAY_FACTORS = {
  SURFACE: 8, // How far surface preference extends
  STALLS: 2, // Attraction range for stalls
  FURNITURE: 3, // Attraction range for furniture
  SHADE: 3, // Attraction range for shade (metres); lookahead in MNL handles long-range sensing
} as const

// Rasterize an entire FeatureCollection (polygons & multipolygons) to a single inside mask (Uint8Array)
// Simplified scanline algorithm — returns Uint8Array length width*height with 1 for inside.
export function featureMask(col: any, grid: GridLike): Uint8Array {
  const features = Array.isArray(col?.features) ? col.features : []
  const inside = new Uint8Array(grid.width * grid.height)
  rasterizePolygons(features, grid, (index) => { inside[index] = 1 })
  return inside
}

function rasterizePolygons(
  features: Feature<Geometry>[],
  grid: GridLike,
  mark: (index: number) => void,
): void {
  const width = grid.width
  const height = grid.height

  for (const feat of features) {
    if (!feat?.geometry) continue
    const geom = feat.geometry

    let polygons: any[] = []
    if (geom.type === 'Polygon') polygons = [geom.coordinates]
    else if (geom.type === 'MultiPolygon') polygons = geom.coordinates
    else continue

    for (const poly of polygons) {
      if (!Array.isArray(poly) || poly.length === 0) continue
      // Project each ring's lon/lat vertices to grid coords (y grows south)
      const rings = poly.map((ring: any) =>
        ring.map((c: any) => [grid.lonToX(c[0]), grid.latToY(c[1])]),
      )

      // Calculate bounds for this polygon
      let pxMin = Infinity,
        pxMax = -Infinity,
        pyMin = Infinity,
        pyMax = -Infinity
      if (!rings[0] || rings[0].length === 0) continue
      for (const ring of rings[0]) {
        // Only check outer ring for bounds
        pxMin = Math.min(pxMin, ring[0])
        pxMax = Math.max(pxMax, ring[0])
        pyMin = Math.min(pyMin, ring[1])
        pyMax = Math.max(pyMax, ring[1])
      }

      const x0 = Math.max(0, Math.floor(pxMin))
      const x1 = Math.min(width - 1, Math.ceil(pxMax))
      const y0 = Math.max(0, Math.floor(pyMin))
      const y1 = Math.min(height - 1, Math.ceil(pyMax))

      // Scanline fill using all rings (exterior + holes) with even-odd rule
      for (let y = y0; y <= y1; y++) {
        const intersections: number[] = []
        for (const ring of rings) {
          for (let i = 0, len = ring.length; i < len; i++) {
            const a = ring[i]
            const b = ring[(i + 1) % len]
            if ((a[1] <= y && b[1] > y) || (a[1] > y && b[1] <= y)) {
              const xIntersect = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
              intersections.push(xIntersect)
            }
          }
        }

        if (intersections.length === 0) continue
        intersections.sort((a, b) => a - b)

        for (let k = 0; k < intersections.length; k += 2) {
          const nextK = k + 1
          if (nextK >= intersections.length) break
          const ik = intersections[k]
          const ink = intersections[nextK]
          if (ik === undefined || ink === undefined) continue
          const xa = Math.max(x0, Math.ceil(ik))
          const xb = Math.min(x1, Math.floor(ink))
          for (let x = xa; x <= xb; x++) {
            mark(y * width + x)
          }
        }
      }
    }
  }

}

// Route data may be mapped as points, centerlines or areas. A radius in cell
// units gives centerlines a usable footprint and lets nearby sidewalks see transit.
function rasterizeRoute(
  geometry: Geometry,
  grid: GridLike,
  radius: number,
  mark: (index: number) => void,
): void {
  const radiusSquared = radius * radius
  const markSegment = (a: Position, b: Position) => {
    const ax = grid.lonToX(a[0]!), ay = grid.latToY(a[1]!)
    const bx = grid.lonToX(b[0]!), by = grid.latToY(b[1]!)
    const dx = bx - ax, dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx) - radius))
    const x1 = Math.min(grid.width - 1, Math.floor(Math.max(ax, bx) + radius))
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by) - radius))
    const y1 = Math.min(grid.height - 1, Math.floor(Math.max(ay, by) + radius))
    if (x1 < x0 || y1 < y0) return
    for (let y = y0; y <= y1; y++) {
      const yOffset = y - ay
      let left = x0
      let right = x1
      if (dx !== 0 && dy !== 0) {
        // Only the part of the segment within this row's vertical radius can contribute.
        const start = Math.max(0, Math.min(1, (yOffset - radius) / dy))
        const end = Math.max(0, Math.min(1, (yOffset + radius) / dy))
        const rowStartX = ax + start * dx
        const rowEndX = ax + end * dx
        // Round outward to keep edge candidates despite interpolation rounding.
        left = Math.max(x0, Math.floor(Math.min(rowStartX, rowEndX) - radius))
        right = Math.min(x1, Math.ceil(Math.max(rowStartX, rowEndX) + radius))
      }
      for (let x = left; x <= right; x++) {
        const fraction = lengthSquared === 0 ? 0 :
          Math.max(0, Math.min(1, ((x - ax) * dx + yOffset * dy) / lengthSquared))
        if ((x - ax - fraction * dx) ** 2 + (yOffset - fraction * dy) ** 2 <= radiusSquared) {
          mark(y * grid.width + x)
        }
      }
    }
  }
  const markLine = (line: Position[]) => {
    for (let i = 1; i < line.length; i++) markSegment(line[i - 1]!, line[i]!)
  }
  switch (geometry.type) {
    case 'Point':
      markSegment(geometry.coordinates, geometry.coordinates)
      break
    case 'MultiPoint':
      for (const point of geometry.coordinates) markSegment(point, point)
      break
    case 'LineString':
      markLine(geometry.coordinates)
      break
    case 'MultiLineString':
      geometry.coordinates.forEach(markLine)
      break
    case 'Polygon':
    case 'MultiPolygon': {
      rasterizePolygons([{ type: 'Feature', geometry, properties: null }], grid, mark)
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
      for (const rings of polygons) rings.forEach(markLine)
      break
    }
    case 'GeometryCollection':
      for (const part of geometry.geometries) rasterizeRoute(part, grid, radius, mark)
      break
  }
}

export function walkwayMask(data: RoutingData['walkways'], grid: GridLike): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height)
  const radius = Math.max(Math.SQRT1_2, 1.25 / (grid.metersPerCell ?? 1))
  for (const { geometry } of data.features) {
    if (geometry) rasterizeRoute(geometry, grid, radius, (index) => { mask[index] = 1 })
  }
  return mask
}

function flag(value: unknown): boolean | undefined {
  switch (String(value).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
      return true
    case '0':
    case 'false':
    case 'no':
      return false
  }
}

function measurement(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return
  const text = String(value).trim().replace(/\s*(?:m|%)$/i, '')
  const number = Number(text)
  if (text && Number.isFinite(number)) return number
}

export function buildRoutingCosts(
  data: RoutingData,
  grid: GridLike,
  walkable: Uint8Array,
  stallPotential: Float32Array | undefined,
): RoutingCosts {
  const count = walkable.length
  const stepFree = walkable.slice()
  const lighting = new Int8Array(count) // -1 unlit, 0 unknown, 1 lit
  const activity = new Uint8Array(count)
  const walkwayWidth = new Float32Array(count)
  const conflicts = new Uint8Array(count)
  const stallCongestion = new Float32Array(count)
  const scale = grid.metersPerCell ?? 1

  for (const [collection, transit] of [[data.transport, true], [data.walkways, false]] as const) {
    for (const { geometry, properties } of collection.features) {
      if (!geometry) continue
      const p = properties ?? {}
      const width = measurement(p.width_m ?? p.width)
      const lit = flag(p.lit ?? p.well_lit ?? p.lighting)
      const crossing = String(p.crossing ?? '').trim().toLowerCase()
      const conflict = flag(p.high_conflict) === true ||
        ['high', 'severe'].includes(String(p.crossing_conflict).toLowerCase()) ||
        ['uncontrolled', 'unmarked'].includes(crossing)
      const congestion = ['heavy', 'high'].includes(String(p.stall_congestion).toLowerCase()) ? 1 :
        Math.max(0, Math.min(1, measurement(p.stall_congestion) ?? 0))
      const grade = measurement(p.grade_pct ?? p.slope_pct ?? p.incline_pct ?? p.incline ?? p.grade)
      const steps = String(p.highway).toLowerCase() === 'steps' || flag(p.steps ?? p.stairs) === true ||
        (measurement(p.step_count ?? p.steps ?? p.stairs) ?? 0) > 0
      const stepFreeTag = flag(p.step_free)
      const hasBarrier = Boolean(p.barrier) && flag(p.barrier) !== false
      // Grade attributes are expressed as percent. Unknown grades stay neutral.
      const tooSteep = flag(p.steep) === true || String(p.incline).toLowerCase() === 'steep' ||
        (grade !== undefined && Math.abs(grade) > 8)
      const blocked = stepFreeTag === false || steps || tooSteep ||
        (hasBarrier && stepFreeTag !== true && flag(p.ramp) !== true)
      const radius = Math.max(Math.SQRT1_2, Math.min(width ?? 2.5, 12) / (2 * scale))

      const active = flag(p.active)
      if (active === true || (transit && active !== false)) {
        rasterizeRoute(geometry, grid, Math.max(radius, 10 / scale), (i) => { activity[i] = 1 })
      }
      if (!transit || lit !== undefined || conflict || blocked || congestion > 0) {
        rasterizeRoute(geometry, grid, radius, (i) => {
          if (!transit) walkwayWidth[i] = Math.max(walkwayWidth[i]!, width ?? 2.5)
          if (lit === false) lighting[i] = -1
          else if (lit === true && lighting[i] === 0) lighting[i] = 1
          if (conflict) conflicts[i] = 1
          if (blocked) stepFree[i] = 0
          if (congestion > 0) stallCongestion[i] = Math.max(stallCongestion[i]!, congestion)
        })
      }
    }
  }

  const female = new Float32Array(count)
  const child = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const lightCost = lighting[i] === -1 ? 3 : lighting[i] === 1 ? 0 : 0.75
    female[i] = 0.65 + lightCost + (activity[i] ? 0 : 0.85)
    const widthBenefit = Math.min(0.65, walkwayWidth[i]! / 5)
    const nearbyStalls = Math.max(0, 1 + (stallPotential?.[i] ?? -1))
    const congestion = Math.max(nearbyStalls, stallCongestion[i]!)
    child[i] = 1.35 - widthBenefit + 2 * congestion + (conflicts[i] ? 4 : 0)
  }
  return { walkable, stepFree, female, child }
}

// Priority queue for Dijkstra's algorithm
export class MinHeap {
  private heap: Array<{ idx: number; dist: number }> = []

  push(idx: number, dist: number) {
    this.heap.push({ idx, dist })
    this.bubbleUp(this.heap.length - 1)
  }

  pop(): { idx: number; dist: number } | undefined {
    if (this.heap.length === 0) return undefined
    const result = this.heap[0]
    const last = this.heap.pop()
    if (this.heap.length > 0 && last) {
      this.heap[0] = last
      this.bubbleDown(0)
    }
    return result
  }

  isEmpty(): boolean {
    return this.heap.length === 0
  }

  private bubbleUp(idx: number) {
    const entry = this.heap[idx]!
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2)
      const parent = this.heap[parentIdx]!
      if (entry.dist >= parent.dist) break
      this.heap[idx] = parent
      idx = parentIdx
    }
    this.heap[idx] = entry
  }

  private bubbleDown(idx: number) {
    const entry = this.heap[idx]!
    let leftIdx = 2 * idx + 1
    while (leftIdx < this.heap.length) {
      const rightIdx = leftIdx + 1
      const minIdx = rightIdx < this.heap.length && this.heap[rightIdx]!.dist < this.heap[leftIdx]!.dist
        ? rightIdx : leftIdx
      const child = this.heap[minIdx]!
      if (child.dist >= entry.dist) break
      this.heap[idx] = child
      idx = minIdx
      leftIdx = 2 * idx + 1
    }
    this.heap[idx] = entry
  }
}

/** Obstacle penalties depend on the walkability mask, so routes can share them. */
export function computeEdgePenalties(walkMask: Uint8Array, grid: GridLike): Float32Array {
  const { width, height } = grid
  const numP = width * height

  // Pre-compute graduated edge penalties: cost increases near obstacles,
  // decaying quadratically from edgePenaltyFactor to 1.0 at penaltyRadius.
  // This creates smooth distance-field contours that curve around obstacles
  // rather than hugging walls — agents aim for gap openings from several metres away.
  const EDGE_PENALTY_FACTOR = GEOMETRY.edgePenaltyFactor
  const PENALTY_RADIUS = GEOMETRY.edgePenaltyRadius ?? 1

  // Step 1: BFS from all non-walkable cells to compute distance to obstacles.
  const obstDist = new Float32Array(numP)
  for (let i = 0; i < numP; i++) obstDist[i] = Infinity
  const bfsQueue: number[] = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!walkMask[idx]) {
        obstDist[idx] = 0
        bfsQueue.push(idx)
      }
    }
  }

  let bfsHead = 0
  while (bfsHead < bfsQueue.length) {
    const idx = bfsQueue[bfsHead++]!
    const d = obstDist[idx]!
    if (d >= PENALTY_RADIUS) continue
    const ix = idx % width
    const iy = (idx / width) | 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = ix + dx
        const ny = iy + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const nIdx = ny * width + nx
        const stepCost = (dx !== 0 && dy !== 0) ? Math.SQRT2 : 1
        // Compare at the stored precision so an unchanged diagonal distance
        // never adds the same cell to the queue again.
        const newDist = Math.fround(d + stepCost)
        if (newDist < obstDist[nIdx]!) {
          obstDist[nIdx] = newDist
          bfsQueue.push(nIdx)
        }
      }
    }
  }

  // Step 2: Convert obstacle distance to graduated penalty
  const edgePenalty = new Float32Array(numP)
  for (let i = 0; i < numP; i++) {
    const d = obstDist[i]!
    if (d >= PENALTY_RADIUS) {
      edgePenalty[i] = 1.0
    } else {
      // Quadratic decay: steep near wall, gentle further out
      const t = 1 - d / PENALTY_RADIUS
      edgePenalty[i] = 1.0 + (EDGE_PENALTY_FACTOR - 1.0) * t * t
    }
  }
  return edgePenalty
}

// Multi-source geodesic distance confined to a walkable mask.
// sourceMask: Uint8Array with 1 for source pixels (feature pixels), 0 otherwise
// walkMask: Uint8Array with 1 for walkable cells, 0 for non-walkable
interface RouteSearchOptions {
  costs?: Float32Array
  stepFree?: boolean
  edgePenalties?: Float32Array
}

export function computeShortestPath(
  sourceMask: Uint8Array,
  walkMask: Uint8Array,
  grid: GridLike,
  options?: RouteSearchOptions,
): Float32Array {
  const { width, height } = grid
  const numP = width * height

  const distances = new Float32Array(numP)
  for (let i = 0; i < numP; i++) distances[i] = Infinity

  const patchIndex = (x: number, y: number) => y * width + x
  const edgePenalty = options?.edgePenalties ?? computeEdgePenalties(walkMask, grid)
  const queue = new MinHeap()
  const visited = new Uint8Array(numP)

  // Seed with source pixels that are walkable
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (sourceMask[idx] && walkMask[idx]) {
        distances[idx] = 0
        queue.push(idx, 0)
      }
    }
  }

  // 16-connected neighbors: 8 standard + 8 knight's moves.
  // Knight's moves (±2,±1)/(±1,±2) give angular resolution of ~26.6°
  // instead of 45°, reducing grid-aligned path artifacts.
  // Format: [dx, dy, cost, midDx, midDy] — midDx/midDy is the intermediate
  // cell that must be walkable for knight's moves (0,0 = no check needed).
  const SQRT5 = Math.sqrt(5)
  const neighbors: [number, number, number, number, number][] = [
    // Cardinal (0°, 90°, 180°, 270°)
    [-1, 0, 1, 0, 0],
    [1, 0, 1, 0, 0],
    [0, -1, 1, 0, 0],
    [0, 1, 1, 0, 0],
    // Diagonal (45°, 135°, 225°, 315°)
    [-1, -1, Math.SQRT2, 0, 0],
    [-1, 1, Math.SQRT2, 0, 0],
    [1, -1, Math.SQRT2, 0, 0],
    [1, 1, Math.SQRT2, 0, 0],
    // Knight's moves (~26.6°, ~63.4°, etc.) — intermediate cell must be walkable
    [-2, -1, SQRT5, -1, 0],
    [-2, 1, SQRT5, -1, 0],
    [2, -1, SQRT5, 1, 0],
    [2, 1, SQRT5, 1, 0],
    [-1, -2, SQRT5, 0, -1],
    [-1, 2, SQRT5, 0, 1],
    [1, -2, SQRT5, 0, -1],
    [1, 2, SQRT5, 0, 1],
  ]

  // Profile fields use the same local neighbors as agent heading selection.
  const neighborCount = options?.costs || options?.stepFree ? 8 : neighbors.length
  const weights = options?.costs
  while (!queue.isEmpty()) {
    const current = queue.pop()
    if (!current) break
    const { idx, dist } = current
    if (visited[idx]) continue
    visited[idx] = 1

    const x = idx % width
    const y = (idx / width) | 0

    for (let dirIdx = 0; dirIdx < neighborCount; dirIdx++) {
      const [dx, dy, cost, midDx, midDy] = neighbors[dirIdx]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const nIdx = ny * width + nx
      if (!walkMask[nIdx]) continue
      if (visited[nIdx]) continue
      if (options?.stepFree && dx !== 0 && dy !== 0 &&
          (!walkMask[patchIndex(nx, y)] || !walkMask[patchIndex(x, ny)])) continue

      // Knight's moves require the intermediate cell to be walkable
      if (midDx !== 0 || midDy !== 0) {
        const mx = x + midDx
        const my = y + midDy
        if (mx < 0 || mx >= width || my < 0 || my >= height) continue
        const mIdx = my * width + mx
        if (!walkMask[mIdx]) continue
      }

      // Apply edge penalty to discourage boundary-hugging
      const multiplier = weights ? (weights[idx]! + weights[nIdx]!) / 2 : 1
      const penalizedCost = cost * edgePenalty[nIdx]! * multiplier
      const newDist = dist + penalizedCost

      // Only update if we found a shorter path
      if (newDist < distances[nIdx]!) {
        distances[nIdx] = newDist
        queue.push(nIdx, newDist)
      }
    }
  }

  return distances
}

// Compute shortest path distance field from a node with edge penalties
// Returns Float32Array with distances (Infinity for unreachable cells)
export function computeNodeDistanceField(
  nodeWorldPos: [number, number],
  grid: GridLike,
  walkabilityMask: Uint8Array, // 1 = walkable, 0 = obstacle
  options?: RouteSearchOptions,
): Float32Array {
  const width = grid.width
  const height = grid.height
  const numP = width * height

  const [nodeX, nodeY] = nodeWorldPos
  const startX = Math.round(nodeX)
  const startY = Math.round(nodeY)

  // Bounds and walkability checks
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) {
    const empty = new Float32Array(numP)
    for (let i = 0; i < numP; i++) {
      empty[i] = Infinity
    }
    return empty
  }

  const startIdx = startY * width + startX
  if (!walkabilityMask[startIdx]) {
    const empty = new Float32Array(numP)
    for (let i = 0; i < numP; i++) {
      empty[i] = Infinity
    }
    return empty
  }

  const sourceMask = new Uint8Array(numP)
  sourceMask[startIdx] = 1

  return computeShortestPath(sourceMask, walkabilityMask, grid, options)
}

// ── Shared geodetic utilities ──────────────────────────────────

/**
 * Convert a longitude span (in degrees) at a given latitude to metres
 * using the WGS84 ellipsoid series expansion.
 */
export function lonSpanToMeters(lonSpanDeg: number, centerLatDeg: number): number {
  const phi = (centerLatDeg * Math.PI) / 180
  const metersPerDegLat = WGS84.a0 - WGS84.a2 * Math.cos(2 * phi) + WGS84.a4 * Math.cos(4 * phi)
  const metersPerDegLon = metersPerDegLat * Math.cos(phi)
  return Math.abs(lonSpanDeg) * metersPerDegLon
}

/**
 * Compute the number of patches across the world grid width for a given bbox.
 * Shared by both the Freetown dual-model and sandbox single-model initialisation.
 */
export function computePatchesWidth(
  bbox: number[] | [number, number, number, number],
  targetPatchMeters: number = GEOMETRY.targetPatchMeters,
): number {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const lonMeters = lonSpanToMeters(maxLon - minLon, (minLat + maxLat) / 2)
  return Math.max(GEOMETRY.minPatchesWidth, Math.round(lonMeters / targetPatchMeters))
}

/**
 * Choose a random destination node weighted by pph, excluding the origin.
 */
export function chooseDestination(nodes: NodeState[], originId: string): NodeState | null {
  const choices = nodes.filter((n) => n.id !== originId && n.pph > 0)
  if (choices.length === 0) return null
  const total = choices.reduce((s, c) => s + c.pph, 0)
  if (total <= 0) return null
  const r = Math.random() * total
  let acc = 0
  for (const c of choices) {
    acc += c.pph
    if (r <= acc) return c
  }
  return choices[choices.length - 1] ?? null
}

/**
 * Spawn new agents from nodes based on pph rates and deltaTime.
 * Returns an array of spawn descriptors shared by both model and sandbox stores.
 */
export function spawnFromNodes(
  nodes: NodeState[],
  deltaTime: number,
  rateMultiplier: number = 1.0,
): Array<{ startNode: NodeState; destNode: NodeState | null; shopProb: number; waitProb: number }> {
  if (!nodes || nodes.length === 0) return []

  const newTurtles: Array<{
    startNode: NodeState
    destNode: NodeState | null
    shopProb: number
    waitProb: number
  }> = []

  for (let i = 0; i < nodes.length; i++) {
    const startNode = nodes[i]!
    if (startNode.pph <= 0) continue
    if (startNode.worldX == null || startNode.worldY == null) continue

    const spawnProb = (startNode.pph * rateMultiplier / 3600) * deltaTime
    if (Math.random() < spawnProb) {
      const destNode = chooseDestination(nodes, startNode.id)
      newTurtles.push({
        startNode,
        destNode,
        shopProb: startNode.noEngagement ? 1 : Math.random(),
        waitProb: startNode.noEngagement ? 1 : Math.random(),
      })
    }
  }

  return newTurtles
}

export function buildNodesFromCollection(fc: FeatureCollection<Geometry>): NodeState[] {
  if (!fc || !Array.isArray(fc.features)) return []

  return fc.features.map((f, idx) => {
    // try to pull an id from feature.id, properties.id, or fallback to index
    const fid = (f.id ?? f.properties?.id ?? `node-${idx}`) as string
    // label from properties.name or id
    const label = (f.properties && f.properties.name) ?? fid

    // attempt to extract coords for Point geometries
    let coords: [number, number] | undefined
    if (
      f.geometry &&
      f.geometry.type === 'Point' &&
      Array.isArray((f.geometry as any).coordinates)
    ) {
      const c = (f.geometry as any).coordinates
      coords = [c[0], c[1]]
    }

    // pph default from properties.pph or 10
    const pph = Number(f.properties?.pph ?? 10)

    // interval default from properties.interval or 0 (continuous spawning)
    const interval = Number(f.properties?.interval ?? 0)

    // Optional engagement override from properties
    const noEngagement = f.properties?.noEngagement === true

    return {
      id: String(fid),
      label: String(label),
      coords,
      pph,
      interval,
      noEngagement,
    } as NodeState
  })
}
