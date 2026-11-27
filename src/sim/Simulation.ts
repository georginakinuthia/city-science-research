/**
 * Simulation — the entire sim state in one flat, SoA-backed class.
 *
 * Replaces `MapModel` (which extended `agentscript/src/Model`). There is no
 * separate `Grid`, `Crowd`, `Pedestrian`, or `Patch` class — cell data and
 * agent data are parallel typed arrays at the same level. A single class
 * exists only because the app instantiates two of them (scenarios A + B).
 *
 * Coordinate convention:
 *   - y=0 = north, increasing southward
 *   - idx(x, y) = y * width + x (row-major, naturally matches maplibre's
 *     canvas-source orientation — no flips anywhere)
 *
 * Heading convention:
 *   - Stored in compass degrees (0 = north, 90 = east, clockwise)
 *   - Inline conversion `(90 - deg) * DEG_TO_RAD` at trig boundaries
 *
 * See `/Users/dev/.claude/plans/wise-splashing-puffin.md` for the design
 * rationale and the per-tick cost budget.
 */

import { booleanPointInPolygon } from '@turf/turf'

import { GEOMETRY, MAX_AGENTS, ORCA, TACUBAYA_CROWD } from '../config'
import { SpatialHashGrid } from '../models/orca'
import {
  computeEdgePenalties,
  computeNodeDistanceField,
  type CrowdAnchors,
  DemographicProfile,
  type NodeState,
  type RoutingCosts,
  type RoutingData,
} from '../stores/geo'
import type { ScenarioContainer } from './scenarioGen'

// Pure per-agent functions. Module-scoped params are installed via
// `setBehaviorParams` in the Pinia adapter (main thread) or by the worker.
import {
  advanceAgent as pureAdvanceAgent,
  getBaseDeltaTime,
  getMinAgentSpacing,
  initialiseAgent as pureInitialiseAgent,
} from './agentBehavior'
import type { SerializedSpawnNode, SerializedSpawnSpec } from './workerProtocol'

// ─────────────────────────────────────────────────────────────────────
// Constants and types
// ─────────────────────────────────────────────────────────────────────

export const DEG_TO_RAD = Math.PI / 180
export const RAD_TO_DEG = 180 / Math.PI

/** Engagement state as a numeric encoding (replaces string union). */
export const ENGAGEMENT_OFF = 0
export const ENGAGEMENT_SHOPPING = 1
export const ENGAGEMENT_WAITING = 2

/**
 * Queued spawn request — populated by the simulation store, consumed in `step()`.
 *
 * Alias for `SerializedSpawnSpec` from `workerProtocol`. The alias exists so
 * main-thread code can keep importing `SpawnSpec` from `Simulation` without
 * caring about the worker boundary, while the worker can import the same
 * shape directly from `workerProtocol`.
 *
 * Main-thread callers typically pass full `NodeState` objects as
 * `startNode`/`destNode`; because `NodeState` has all the `SerializedSpawnNode`
 * fields (plus more), structural typing allows that without a cast.
 */
export type SpawnSpec = SerializedSpawnSpec
export type SpawnNode = SerializedSpawnNode

type ProjectedNode = NodeState & { worldX: number; worldY: number }

interface InitialCrowd {
  entries: Map<string, ProjectedNode>
  targets: ProjectedNode[]
  positions: Array<{ x: number; y: number; cell: number }>
}

/** Out-parameter written by `advanceAgent` — one reusable instance per sim. */
export interface AdvanceResult {
  hasArrived: boolean
  shopMinutes: number
  waitMinutes: number
  distanceTraveled: number
}

/** Palette used to bake the cell color buffer. */
export interface CellColorPalette {
  /** Called per cell where `stallPotential > 0`. Returns a packed u32. */
  stallGradient: (value: number, min: number, max: number) => number
  /** Called per cell where `furniturePotential > 0`. */
  furnitureGradient: (value: number, min: number, max: number) => number
  /** Called per cell where `shadePotential > 0`. */
  shadeGradient: (value: number, min: number, max: number) => number
  /** u32 for walkable cells (surfacePotential > 0) with no other overlay. */
  surface: number
  /** u32 for non-walkable cells. Typically 0 (fully transparent). */
  transparent: number
}

// ─────────────────────────────────────────────────────────────────────
// Haversine helper — replicates agentscript's `gis.lonLat2meters` exactly,
// so the grid dimensions (and therefore every cached distance field) match
// the legacy code bit-for-bit.
// ─────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6378137 // equatorial radius, matches agentscript

function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const phi1 = lat1 * DEG_TO_RAD
  const phi2 = lat2 * DEG_TO_RAD
  const dPhi = (lat2 - lat1) * DEG_TO_RAD
  const dLam = (lon2 - lon1) * DEG_TO_RAD
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ─────────────────────────────────────────────────────────────────────
// Simulation — one flat data container
// ─────────────────────────────────────────────────────────────────────

export class Simulation {
  // --- Grid parameters (immutable after construction) ---
  readonly width: number            // cells E–W
  readonly height: number           // cells N–S
  readonly cellCount: number        // = width * height
  readonly metersPerCell: number
  readonly bbox: readonly [number, number, number, number]  // [minLon, minLat, maxLon, maxLat]

  /** Linear bbox → grid scale factors, computed once. */
  private readonly xScale: number   // cells per degree longitude
  private readonly yScale: number   // cells per degree latitude

  // --- Cell fields (length = cellCount) ---
  readonly surfacePotential: Float32Array      // scenario-static
  readonly stallPotential: Float32Array        // scenario-static
  readonly furniturePotential: Float32Array    // scenario-static
  readonly shadePotential: Float32Array        // scenario-static
  private readonly occupiedDensityCells: Int32Array
  private occupiedDensityCount = 0
  readonly density: Float32Array               // rebuilt each tick
  readonly cellHeadingDx: Float32Array         // rebuilt each tick (per-cell accumulator)
  readonly cellHeadingDy: Float32Array         // rebuilt each tick
  readonly trails: Float32Array                // accumulator (per-tick +1 where an agent walks)

  /**
   * Flat neighbor table — 9 slots per cell, laid out as:
   *   [count, n0, n1, n2, n3, n4, n5, n6, n7]
   *
   * For cell idx, its slice begins at `idx * 9`. `count` ∈ [3..8]
   * (corners: 3, edges: 5, interior: 8). Unused slots are undefined.
   *
   * This is the **all-neighbors** table — every Moore neighbor is listed
   * regardless of walkability. Hot-path loops that filter non-walkable
   * cells out should read the `walkableNeighborTable` below instead.
   */
  readonly neighborTable: Int32Array

  /**
   * Walkable-only neighbor table — same layout as `neighborTable` but
   * only lists neighbors whose `surfacePotential >= 0`. Populated in
   * `generateScenario()` once `surfacePotential` is known.
   *
   * Hot-path consumers (MNL, gradient seek, following) iterate this
   * instead of the full table to avoid a per-neighbor walkability branch
   * on every agent tick.
   */
  readonly walkableNeighborTable: Int32Array

  /**
   * Per-spawn-node Dijkstra distance fields. Indexed by the integer
   * returned from `internNodeId(nodeIdString)`. Avoids a Map-lookup on
   * the MNL inner loop hot path.
   */
  readonly nodeDistanceFields: Float32Array[] = []
  routingCosts?: RoutingCosts
  private initialCrowd?: InitialCrowd
  private readonly femaleDistanceFields: Float32Array[] = []
  private readonly childDistanceFields: Float32Array[] = []
  private readonly stepFreeDistanceFields: Float32Array[] = []
  private readonly edgePenalties = new WeakMap<Uint8Array, Float32Array>()

  /**
   * Pre-baked cell color buffer — populated by `bakeCellColors()` after
   * `generateScenario()`. Per-frame cell render becomes a single
   * `pixelView.set(sim.cellColorBuffer)` memcpy.
   */
  readonly cellColorBuffer: Uint32Array

  // --- Agent fields (SoA, parallel typed arrays) ---
  private pedCapacity: number = 0
  pedCount: number = 0            // slots in use (may include soft-dead before compaction)
  pedAliveCount: number = 0       // actually-alive agents

  pedId!: Int32Array
  pedAlive!: Uint8Array            // 0 = dead, 1 = alive
  pedX!: Float32Array
  pedY!: Float32Array
  pedCellIdx!: Int32Array          // -1 when off-grid

  pedHeading!: Float32Array        // compass degrees
  pedHeadingDx!: Float32Array      // cached unit vector (recomputed in setAgentHeading)
  pedHeadingDy!: Float32Array      // y grows south → typically negative for northward headings

  pedStartNodeIdx!: Int32Array     // index into nodeIdTable; -1 if unset
  pedTargetNodeIdx!: Int32Array
  pedTargetX!: Float32Array
  pedTargetY!: Float32Array

  pedSpeed!: Float32Array
  pedCurrentSpeed!: Float32Array
  pedProfile!: Uint8Array

  pedShopProb!: Float32Array
  pedWaitProb!: Float32Array
  pedEngagementMode!: Uint8Array   // 0=off, 1=shopping, 2=waiting
  pedEngagementDuration!: Float32Array
  pedEngagementElapsed!: Float32Array
  pedNoEngagement!: Uint8Array     // 0 = false, 1 = true

  pedIntimateViolations!: Uint16Array
  pedPersonalViolations!: Uint16Array
  pedSocialViolations!: Uint16Array

  pedMomentumPreference!: Float32Array
  pedRouteStraightness!: Float32Array
  pedRouteBiasDx!: Float32Array
  pedRouteBiasDy!: Float32Array
  pedRouteBiasWeight!: Float32Array

  pedOrcaDeflection!: Float32Array
  pedPerceivedDensity!: Float32Array
  pedMnlHeading!: Float32Array     // NaN = unset

  // String table for dynamic node IDs
  readonly nodeIdTable: string[] = []
  private nodeIdLookup = new Map<string, number>()

  private nextPedId: number = 0
  private hasDead: boolean = false

  // --- Per-scenario stats (ex-MapModel fields) ---
  arrivalsThisTick: number = 0
  totalArrivals: number = 0
  totalMinutesShopped: number = 0
  totalMinutesWaited: number = 0
  totalSteps: number = 0
  totalNormalSteps: number = 0
  totalNormalDistanceTraveled: number = 0
  totalNormalTime: number = 0
  totalPublicZoneSteps: number = 0
  totalIntimateZoneSteps: number = 0
  totalPersonalZoneSteps: number = 0
  totalSocialZoneSteps: number = 0

  // --- ORCA spatial hash (rebuilt each tick) ---
  readonly spatialHash: SpatialHashGrid

  /**
   * External spawn queue — the simulation store populates this before each
   * `step()` via `sim.pendingSpawns = modelsStore.spawnFromNodes()`. Drained
   * by `spawnPending()` inside `step()`.
   */
  pendingSpawns: SpawnSpec[] = []

  /** Reusable advance-result — allocated once, overwritten per agent per tick. */
  readonly advanceResult: AdvanceResult = {
    hasArrived: false,
    shopMinutes: 0,
    waitMinutes: 0,
    distanceTraveled: 0,
  }

  constructor(
    bbox: [number, number, number, number],
    targetWidth: number,
  ) {
    const [minLon, minLat, maxLon, maxLat] = bbox

    // Metric aspect via Haversine (matches agentscript's gis.bboxMetricAspect
    // exactly — critical for reproducing legacy grid dimensions).
    const widthMeters = haversineMeters(minLon, maxLat, maxLon, maxLat)   // top edge
    const heightMeters = haversineMeters(minLon, maxLat, minLon, minLat)  // left edge
    const aspect = widthMeters / heightMeters

    const width = targetWidth
    // numY in agentscript: `maxY = Math.round(patchesWidth / aspect)` with
    // `minY = 0`, so numY = maxY - minY + 1 = Math.round(targetWidth / aspect) + 1.
    const height = Math.round(targetWidth / aspect) + 1

    this.width = width
    this.height = height
    this.cellCount = width * height
    this.metersPerCell = widthMeters / width
    this.bbox = bbox
    this.xScale = width / (maxLon - minLon)
    this.yScale = height / (maxLat - minLat)

    // --- Cell fields ---
    const n = this.cellCount
    this.surfacePotential   = new Float32Array(n)
    this.stallPotential     = new Float32Array(n)
    this.furniturePotential = new Float32Array(n)
    this.shadePotential     = new Float32Array(n)
    this.occupiedDensityCells = new Int32Array(n)
    this.density            = new Float32Array(n)
    this.cellHeadingDx      = new Float32Array(n)
    this.cellHeadingDy      = new Float32Array(n)
    this.trails             = new Float32Array(n)
    this.cellColorBuffer    = new Uint32Array(n)

    // --- Neighbor tables ---
    this.neighborTable = new Int32Array(n * 9)
    this.walkableNeighborTable = new Int32Array(n * 9)
    this.buildNeighborTable()
    // walkableNeighborTable is populated in generateScenario() once
    // surfacePotential is known. Until then, hot-path consumers that
    // read it will see zero neighbors everywhere — but they're only
    // supposed to run after generateScenario(), so that's a non-issue.

    // --- Agents: start with a small capacity, grow geometrically ---
    this.growPedCapacity(256)

    // --- ORCA spatial hash ---
    this.spatialHash = new SpatialHashGrid(ORCA.spatialHashCellSize)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Coordinate transforms
  //
  // Convention: cell (i, j) has its CENTER at integer coords (i, j) and
  // its edges at (i ± 0.5, j ± 0.5). The west bbox edge maps to x=-0.5
  // (half a cell west of cell 0's center), the east edge to x=width-0.5.
  // Same for north/south.
  //
  // This half-cell offset matches the convention inherited from the
  // pedestrian-sim literature (NetLogo/MASON/SWARM) and preserves the
  // rounded-cell output of the legacy code at the same geographic points,
  // so Dijkstra distance fields and cached spatial data remain stable
  // across the refactor.
  // ═══════════════════════════════════════════════════════════════════

  /** lon → fractional cell x. At minLon → -0.5, at maxLon → width - 0.5. */
  lonToX(lon: number): number {
    return (lon - this.bbox[0]) * this.xScale - 0.5
  }

  /** lat → fractional cell y (y grows south). At maxLat → -0.5, at minLat → height - 0.5. */
  latToY(lat: number): number {
    return (this.bbox[3] - lat) * this.yScale - 0.5
  }

  /** cell x → lon. */
  xToLon(x: number): number {
    return this.bbox[0] + (x + 0.5) / this.xScale
  }

  /** cell y → lat. */
  yToLat(y: number): number {
    return this.bbox[3] - (y + 0.5) / this.yScale
  }

  /** Row-major index. y=0 = north, no flip. */
  idx(x: number, y: number): number {
    return y * this.width + x
  }

  /**
   * Round float coordinates to an integer cell index, bounds-checked.
   * Returns -1 if off-grid. Uses `Math.round` (handles negative floats
   * correctly — `(x + 0.5) | 0` would bug out for x ∈ (-1, 0)).
   */
  cellAt(fx: number, fy: number): number {
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return -1
    const ix = Math.round(fx)
    const iy = Math.round(fy)
    if (ix < 0 || ix >= this.width || iy < 0 || iy >= this.height) return -1
    return iy * this.width + ix
  }

  /**
   * Four-corner GeoJSON ring for maplibre's canvas source: NW, NE, SE, SW.
   * Matches the orientation of the row-0-at-north pixel buffer.
   */
  cellCornersGeoJSON(): [number, number][] {
    const [minLon, minLat, maxLon, maxLat] = this.bbox
    return [
      [minLon, maxLat],  // NW
      [maxLon, maxLat],  // NE
      [maxLon, minLat],  // SE
      [minLon, minLat],  // SW
    ]
  }

  // ═══════════════════════════════════════════════════════════════════
  // Neighbor table (precomputed once)
  // ═══════════════════════════════════════════════════════════════════

  private buildNeighborTable(): void {
    const { width, height, cellCount, neighborTable } = this
    // 8 Moore offsets with y growing south. Order is arbitrary but stable.
    const DX = [-1, 0, 1, -1, 1, -1, 0, 1]
    const DY = [-1, -1, -1, 0, 0, 1, 1, 1]
    for (let idx = 0; idx < cellCount; idx++) {
      const x = idx % width
      const y = (idx / width) | 0
      const base = idx * 9
      let count = 0
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d]!
        const ny = y + DY[d]!
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        count++
        neighborTable[base + count] = ny * width + nx
      }
      neighborTable[base] = count
    }
  }

  /**
   * Populate `walkableNeighborTable` by filtering the full neighbor table.
   * Called from `generateScenario()` once `surfacePotential` is loaded —
   * running it before would produce a table with zero walkable neighbors
   * everywhere because `surfacePotential` starts zeroed and the check is
   * `surfacePotential[idx] >= 0` (0 counts as walkable).
   *
   * After this runs, hot-path code can iterate only walkable neighbors
   * without a per-iteration `surfacePotential[nIdx] < 0` branch.
   */
  private buildWalkableNeighborTable(): void {
    const { cellCount, neighborTable, walkableNeighborTable, surfacePotential } = this
    for (let idx = 0; idx < cellCount; idx++) {
      const base = idx * 9
      const fullCount = neighborTable[base]!
      let walkCount = 0
      for (let k = 1; k <= fullCount; k++) {
        const nIdx = neighborTable[base + k]!
        if ((surfacePotential[nIdx] ?? 0) < 0) continue
        walkCount++
        walkableNeighborTable[base + walkCount] = nIdx
      }
      walkableNeighborTable[base] = walkCount
    }
  }

  /** Number of neighbors of cell `cellIdx` (3 for corners, 5 for edges, 8 for interior). */
  neighborCount(cellIdx: number): number {
    return this.neighborTable[cellIdx * 9]!
  }

  /** k-th neighbor of cell `cellIdx` (0 ≤ k < `neighborCount(cellIdx)`). */
  neighborAt(cellIdx: number, k: number): number {
    return this.neighborTable[cellIdx * 9 + 1 + k]!
  }

  // ═══════════════════════════════════════════════════════════════════
  // Node-id string table
  // ═══════════════════════════════════════════════════════════════════

  /** Get-or-assign an integer index for a node id. Used to pre-lookup distance fields. */
  internNodeId(id: string): number {
    const existing = this.nodeIdLookup.get(id)
    if (existing !== undefined) return existing
    const idx = this.nodeIdTable.length
    this.nodeIdTable.push(id)
    this.nodeIdLookup.set(id, idx)
    return idx
  }

  /** Returns the integer index for a node id, or -1 if unknown. */
  nodeIdxFor(id: string | null | undefined): number {
    if (id == null) return -1
    const existing = this.nodeIdLookup.get(id)
    return existing === undefined ? -1 : existing
  }

  // ═══════════════════════════════════════════════════════════════════
  // Agent capacity and lifecycle
  // ═══════════════════════════════════════════════════════════════════

  private growPedCapacity(required: number): void {
    if (required <= this.pedCapacity) return
    const newCap = Math.max(required, this.pedCapacity * 2, 256)

    const grow32 = (old: Float32Array | undefined): Float32Array => {
      const next = new Float32Array(newCap)
      if (old) next.set(old)
      return next
    }
    const growI32 = (old: Int32Array | undefined): Int32Array => {
      const next = new Int32Array(newCap)
      if (old) next.set(old)
      return next
    }
    const growU8 = (old: Uint8Array | undefined): Uint8Array => {
      const next = new Uint8Array(newCap)
      if (old) next.set(old)
      return next
    }
    const growU16 = (old: Uint16Array | undefined): Uint16Array => {
      const next = new Uint16Array(newCap)
      if (old) next.set(old)
      return next
    }

    this.pedId                 = growI32(this.pedId)
    this.pedAlive              = growU8(this.pedAlive)
    this.pedX                  = grow32(this.pedX)
    this.pedY                  = grow32(this.pedY)
    this.pedCellIdx            = growI32(this.pedCellIdx)
    this.pedHeading            = grow32(this.pedHeading)
    this.pedHeadingDx          = grow32(this.pedHeadingDx)
    this.pedHeadingDy          = grow32(this.pedHeadingDy)
    this.pedStartNodeIdx       = growI32(this.pedStartNodeIdx)
    this.pedTargetNodeIdx      = growI32(this.pedTargetNodeIdx)
    this.pedTargetX            = grow32(this.pedTargetX)
    this.pedTargetY            = grow32(this.pedTargetY)
    this.pedSpeed              = grow32(this.pedSpeed)
    this.pedCurrentSpeed       = grow32(this.pedCurrentSpeed)
    this.pedProfile            = growU8(this.pedProfile)
    this.pedShopProb           = grow32(this.pedShopProb)
    this.pedWaitProb           = grow32(this.pedWaitProb)
    this.pedEngagementMode     = growU8(this.pedEngagementMode)
    this.pedEngagementDuration = grow32(this.pedEngagementDuration)
    this.pedEngagementElapsed  = grow32(this.pedEngagementElapsed)
    this.pedNoEngagement       = growU8(this.pedNoEngagement)
    this.pedIntimateViolations = growU16(this.pedIntimateViolations)
    this.pedPersonalViolations = growU16(this.pedPersonalViolations)
    this.pedSocialViolations   = growU16(this.pedSocialViolations)
    this.pedMomentumPreference = grow32(this.pedMomentumPreference)
    this.pedRouteStraightness  = grow32(this.pedRouteStraightness)
    this.pedRouteBiasDx        = grow32(this.pedRouteBiasDx)
    this.pedRouteBiasDy        = grow32(this.pedRouteBiasDy)
    this.pedRouteBiasWeight    = grow32(this.pedRouteBiasWeight)
    this.pedOrcaDeflection     = grow32(this.pedOrcaDeflection)
    this.pedPerceivedDensity   = grow32(this.pedPerceivedDensity)
    this.pedMnlHeading         = grow32(this.pedMnlHeading)

    this.pedCapacity = newCap
  }

  /** Allocate a new agent slot. Caller populates the remaining fields. */
  spawnAgent(): number {
    if (this.pedCount >= this.pedCapacity) {
      this.growPedCapacity(this.pedCount + 1)
    }
    const i = this.pedCount++
    this.pedId[i] = this.nextPedId++
    this.pedAlive[i] = 1
    this.pedProfile[i] = DemographicProfile.standard
    // Reset per-agent fields that don't get overwritten by caller's init
    this.pedMnlHeading[i] = Number.NaN
    this.pedOrcaDeflection[i] = 0
    this.pedPerceivedDensity[i] = 0
    this.pedIntimateViolations[i] = 0
    this.pedPersonalViolations[i] = 0
    this.pedSocialViolations[i] = 0
    this.pedAliveCount++
    return i
  }

  /** Mark an agent as dead. Compaction happens at end-of-tick in `step()`. */
  killAgent(i: number): void {
    if (this.pedAlive[i] === 0) return
    this.pedAlive[i] = 0
    this.pedAliveCount--
    this.hasDead = true
  }

  /** Compact dead slots out of the agent arrays. O(pedCount × fields). */
  private compactDead(): void {
    if (!this.hasDead) return
    let w = 0
    const count = this.pedCount
    const alive = this.pedAlive
    for (let r = 0; r < count; r++) {
      if (alive[r] === 0) continue
      if (w !== r) this.copyAgentSlot(r, w)
      w++
    }
    this.pedCount = w
    this.hasDead = false
  }

  private copyAgentSlot(src: number, dst: number): void {
    this.pedId[dst]                 = this.pedId[src]!
    this.pedAlive[dst]              = this.pedAlive[src]!
    this.pedX[dst]                  = this.pedX[src]!
    this.pedY[dst]                  = this.pedY[src]!
    this.pedCellIdx[dst]            = this.pedCellIdx[src]!
    this.pedHeading[dst]            = this.pedHeading[src]!
    this.pedHeadingDx[dst]          = this.pedHeadingDx[src]!
    this.pedHeadingDy[dst]          = this.pedHeadingDy[src]!
    this.pedStartNodeIdx[dst]       = this.pedStartNodeIdx[src]!
    this.pedTargetNodeIdx[dst]      = this.pedTargetNodeIdx[src]!
    this.pedTargetX[dst]            = this.pedTargetX[src]!
    this.pedTargetY[dst]            = this.pedTargetY[src]!
    this.pedSpeed[dst]              = this.pedSpeed[src]!
    this.pedCurrentSpeed[dst]       = this.pedCurrentSpeed[src]!
    this.pedProfile[dst]            = this.pedProfile[src]!
    this.pedShopProb[dst]           = this.pedShopProb[src]!
    this.pedWaitProb[dst]           = this.pedWaitProb[src]!
    this.pedEngagementMode[dst]     = this.pedEngagementMode[src]!
    this.pedEngagementDuration[dst] = this.pedEngagementDuration[src]!
    this.pedEngagementElapsed[dst]  = this.pedEngagementElapsed[src]!
    this.pedNoEngagement[dst]       = this.pedNoEngagement[src]!
    this.pedIntimateViolations[dst] = this.pedIntimateViolations[src]!
    this.pedPersonalViolations[dst] = this.pedPersonalViolations[src]!
    this.pedSocialViolations[dst]   = this.pedSocialViolations[src]!
    this.pedMomentumPreference[dst] = this.pedMomentumPreference[src]!
    this.pedRouteStraightness[dst]  = this.pedRouteStraightness[src]!
    this.pedRouteBiasDx[dst]        = this.pedRouteBiasDx[src]!
    this.pedRouteBiasDy[dst]        = this.pedRouteBiasDy[src]!
    this.pedRouteBiasWeight[dst]    = this.pedRouteBiasWeight[src]!
    this.pedOrcaDeflection[dst]     = this.pedOrcaDeflection[src]!
    this.pedPerceivedDensity[dst]   = this.pedPerceivedDensity[src]!
    this.pedMnlHeading[dst]         = this.pedMnlHeading[src]!
  }

  /** Clear all agents. Underlying typed arrays stay allocated for reuse. */
  clearAgents(): void {
    this.pedCount = 0
    this.pedAliveCount = 0
    this.hasDead = false
  }

  // ═══════════════════════════════════════════════════════════════════
  // Agent position and heading helpers — used by behavior.ts
  // ═══════════════════════════════════════════════════════════════════

  /** Set an agent's position and update the cached cell index. */
  setAgentPosition(i: number, x: number, y: number): void {
    this.pedX[i] = x
    this.pedY[i] = y
    this.pedCellIdx[i] = this.cellAt(x, y)
  }

  /**
   * Advance an agent forward along its current heading by `distance` cells.
   * Updates both position and cached cell index in one call.
   */
  advanceAgentForward(i: number, distance: number): void {
    const theta = (90 - this.pedHeading[i]!) * DEG_TO_RAD
    const dx = distance * Math.cos(theta)
    const dy = -distance * Math.sin(theta)   // y grows south
    const nx = this.pedX[i]! + dx
    const ny = this.pedY[i]! + dy
    this.pedX[i] = nx
    this.pedY[i] = ny
    this.pedCellIdx[i] = this.cellAt(nx, ny)
  }

  /** Set heading in compass degrees and refresh the cached unit vector. */
  setAgentHeading(i: number, headingDeg: number): void {
    this.pedHeading[i] = headingDeg
    const theta = (90 - headingDeg) * DEG_TO_RAD
    this.pedHeadingDx[i] = Math.cos(theta)
    this.pedHeadingDy[i] = -Math.sin(theta)   // y grows south
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scenario loading
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Populate static potential fields and per-node Dijkstra distance fields
   * from a scenario. This is scenario-static — called once per scenario
   * load, not per tick.
   *
   * Note: `cellColorBuffer` is NOT populated here. The view layer owns the
   * palette, so MapView calls `sim.bakeCellColors(palette)` immediately
   * after `generateScenario()`.
   */
  generateScenario(scenario: ScenarioContainer, sharedNodes: NodeState[]): void {
    const routing = scenario.routing
    scenario.generatePotentials(this)
    scenario.generateNodeDistanceFields(this, routing?.crowd ? [] : sharedNodes, Boolean(routing?.crowd))
    this.routingCosts = scenario.routingCosts
    this.nodeDistanceFields.length = 0
    this.femaleDistanceFields.length = 0
    this.childDistanceFields.length = 0
    this.stepFreeDistanceFields.length = 0

    if (scenario.surfacesPotentials)   this.surfacePotential.set(scenario.surfacesPotentials)
    if (scenario.stallsPotentials)     this.stallPotential.set(scenario.stallsPotentials)
    if (scenario.furniturePotentials)  this.furniturePotential.set(scenario.furniturePotentials)
    if (scenario.shadePotentials)      this.shadePotential.set(scenario.shadePotentials)

    if (scenario.nodeDistanceFields) {
      for (const node of sharedNodes) {
        const field = scenario.nodeDistanceFields.get(node.id)
        if (field) {
          const idx = this.internNodeId(node.id)
          this.nodeDistanceFields[idx] = field
        }
      }
    }

    // Build the walkable-only neighbor table now that surfacePotential is
    // populated. Hot-path consumers (MNL, gradient seek, following) iterate
    // this instead of checking walkability per-neighbor inside the loop.
    if (routing?.crowd && this.routingCosts) {
      for (let cell = 0; cell < this.cellCount; cell++) {
        if (!this.routingCosts.walkable[cell]) this.surfacePotential[cell] = -1
        else if (this.surfacePotential[cell]! < 0) this.surfacePotential[cell] = 0
      }
    }
    this.buildWalkableNeighborTable()
    this.initialCrowd = routing?.crowd && this.routingCosts
      ? this.prepareInitialCrowd(routing.crowd, sharedNodes, this.routingCosts, routing.studyBoundary)
      : undefined
    if (this.pedAliveCount === 0) this.seedInitialCrowd()
  }

  private nearestWalkableCell(x: number, y: number, mask: Uint8Array): number {
    const here = this.cellAt(x, y)
    if (mask[here]) return here
    const radius = TACUBAYA_CROWD.entrySnapMeters / this.metersPerCell
    let closest = -1
    let best = radius ** 2
    for (let row = Math.max(0, Math.ceil(y - radius)); row <= Math.min(this.height - 1, y + radius); row++) {
      for (let col = Math.max(0, Math.ceil(x - radius)); col <= Math.min(this.width - 1, x + radius); col++) {
        const cell = this.idx(col, row)
        if (!mask[cell]) continue
        const distance = (col - x) ** 2 + (row - y) ** 2
        if (distance < best) {
          closest = cell
          best = distance
        }
      }
    }
    return closest
  }

  private prepareInitialCrowd(
    anchors: CrowdAnchors,
    nodes: NodeState[],
    routing: RoutingCosts,
    studyBoundary: RoutingData['studyBoundary'],
  ): InitialCrowd {
    const entries = new Map<string, ProjectedNode>()
    for (const node of nodes) {
      if (node.worldX == null || node.worldY == null) continue
      const accessible = this.nearestWalkableCell(node.worldX, node.worldY, routing.stepFree)
      const cell = accessible >= 0 ? accessible : this.nearestWalkableCell(node.worldX, node.worldY, routing.walkable)
      if (cell < 0) continue
      const worldX = cell % this.width
      const worldY = Math.floor(cell / this.width)
      entries.set(node.id, { ...node, worldX, worldY })
      // The renderer receives the node ID table before any later demand arrives.
      this.internNodeId(node.id)
    }

    const nodeList = [...entries.values()]
    const targetCount = Math.min(TACUBAYA_CROWD.initialTargetLimit, nodeList.length)
    const targets = Array.from({ length: targetCount }, (_, i) =>
      nodeList[Math.floor(i * nodeList.length / targetCount)]!,
    )
    const fields = targets.map((node) => this.crowdDistanceField(node, routing))
    const positions: InitialCrowd['positions'] = []
    for (const [lon, lat] of [...anchors.walkways, ...anchors.destinations, ...(anchors.busStops ?? [])]) {
      const x = Math.fround(this.lonToX(lon))
      const y = Math.fround(this.latToY(lat))
      const cell = this.cellAt(x, y)
      if (!routing.walkable[cell]) continue
      if (studyBoundary && !studyBoundary.features.some((area) =>
        booleanPointInPolygon([this.xToLon(x), this.yToLat(y)], area))) continue
      if (targets.some((node, i) =>
        Number.isFinite(fields[i]?.[cell]) &&
        Math.hypot(node.worldX - x, node.worldY - y) > GEOMETRY.arrivalRadius + 1,
      )) {
        positions.push({ x, y, cell })
      }
    }
    return { entries, targets, positions }
  }

  private crowdDistanceField(node: ProjectedNode, routing: RoutingCosts): Float32Array {
    const index = this.internNodeId(node.id)
    return this.nodeDistanceFields[index] ??= computeNodeDistanceField(
      [node.worldX, node.worldY], this, routing.walkable,
      { edgePenalties: this.edgePenaltiesFor(routing.walkable) },
    )
  }

  private edgePenaltiesFor(walkable: Uint8Array): Float32Array {
    let penalties = this.edgePenalties.get(walkable)
    if (!penalties) {
      penalties = computeEdgePenalties(walkable, this)
      this.edgePenalties.set(walkable, penalties)
    }
    return penalties
  }

  private seedInitialCrowd(): void {
    const crowd = this.initialCrowd
    if (!crowd?.targets.length || !crowd.positions.length) return
    const { targets, positions } = crowd
    this.growPedCapacity(TACUBAYA_CROWD.capacity)

    let randomState = 0x54414355
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return randomState / 0x1_0000_0000
    }
    const unused = positions.slice()
    const minTrip = Math.max(GEOMETRY.arrivalRadius + 1, Math.min(
      TACUBAYA_CROWD.initialTripMeters / this.metersPerCell,
      Math.hypot(this.width, this.height) / 4,
    ))
    for (let attempt = 0; attempt < TACUBAYA_CROWD.initialAgents * 5 &&
         this.pedAliveCount < TACUBAYA_CROWD.initialAgents; attempt++) {
      const pool = unused.length ? unused : positions
      const slot = Math.floor(random() * pool.length)
      const { x, y, cell } = pool[slot]!
      if (pool === unused) {
        pool[slot] = pool[pool.length - 1]!
        pool.pop()
      }

      const offset = Math.floor(random() * targets.length)
      let target: ProjectedNode | undefined
      for (let n = 0; n < targets.length; n++) {
        const node = targets[(n + offset) % targets.length]!
        const distance = Math.hypot(node.worldX - x, node.worldY - y)
        if (distance <= GEOMETRY.arrivalRadius + 1) continue
        if (!Number.isFinite(this.nodeDistanceFields[this.nodeIdxFor(node.id)]?.[cell])) continue
        target ??= node
        if (distance >= minTrip) {
          target = node
          break
        }
      }
      if (!target) continue

      let entry = target
      let nearest = Infinity
      for (const node of crowd.entries.values()) {
        if (node === target) continue
        const distance = (node.worldX - x) ** 2 + (node.worldY - y) ** 2
        if (distance < nearest) {
          nearest = distance
          entry = node
        }
      }
      if (this.pedCount >= TACUBAYA_CROWD.capacity) this.compactDead()
      const i = this.spawnAgent()
      pureInitialiseAgent(this, i, entry, target, NaN, NaN, [x, y])
    }
    this.compactDead()
  }

  /** Build one distance field per destination and route preference on first use. */
  agentDistanceField(i: number): Float32Array | undefined {
    const node = this.pedTargetNodeIdx[i]!
    const profile = this.pedProfile[i]!
    const routing = this.routingCosts
    if (!routing || profile === DemographicProfile.standard) return this.nodeDistanceFields[node]

    const fields = profile === DemographicProfile.isFemale ? this.femaleDistanceFields
      : profile === DemographicProfile.hasChild ? this.childDistanceFields : this.stepFreeDistanceFields
    const cached = fields[node]
    if (cached) return cached

    const stepFree = fields === this.stepFreeDistanceFields
    const costs = stepFree ? undefined : fields === this.femaleDistanceFields ? routing.female : routing.child
    const walkable = stepFree ? routing.stepFree : routing.walkable
    const field = computeNodeDistanceField(
      [this.pedTargetX[i]!, this.pedTargetY[i]!],
      this,
      walkable,
      { costs, stepFree, edgePenalties: this.edgePenaltiesFor(walkable) },
    )
    fields[node] = field
    return field
  }

  /**
   * Populate the cellColorBuffer using a view-supplied palette. Called once
   * per scenario — per-frame render then becomes a single memcpy.
   *
   * Matches the branching logic of the legacy `patchesColor` callback in
   * MapView.vue (stall > furniture > shade > surface > transparent).
   */
  bakeCellColors(palette: CellColorPalette): void {
    const n = this.cellCount
    const surf = this.surfacePotential
    const stall = this.stallPotential
    const furniture = this.furniturePotential
    const shade = this.shadePotential
    const buf = this.cellColorBuffer
    const { stallGradient, furnitureGradient, shadeGradient, surface, transparent } = palette

    for (let i = 0; i < n; i++) {
      const s = stall[i]!
      if (s > 0) { buf[i] = stallGradient(s, 0, 1); continue }
      const f = furniture[i]!
      if (f > 0) { buf[i] = furnitureGradient(f, 0, 1); continue }
      const sh = shade[i]!
      if (sh > 0) { buf[i] = shadeGradient(sh, -1, 1); continue }
      if (surf[i]! > 0) { buf[i] = surface; continue }
      buf[i] = transparent
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Main tick
  // ═══════════════════════════════════════════════════════════════════

  step(): void {
    this.arrivalsThisTick = 0
    this.rebuildDensity()
    this.rebuildSpatialHash()
    this.spawnPending()
    this.advanceAgents()
    this.compactDead()
  }

  /** Reset per-tick/per-run state. Does NOT reset scenario-static data. */
  reset(): void {
    this.clearAgents()
    this.arrivalsThisTick = 0
    this.totalArrivals = 0
    this.totalMinutesShopped = 0
    this.totalMinutesWaited = 0
    this.totalSteps = 0
    this.totalNormalSteps = 0
    this.totalNormalDistanceTraveled = 0
    this.totalNormalTime = 0
    this.totalPublicZoneSteps = 0
    this.totalIntimateZoneSteps = 0
    this.totalPersonalZoneSteps = 0
    this.totalSocialZoneSteps = 0
    this.occupiedDensityCount = 0
    this.density.fill(0)
    this.cellHeadingDx.fill(0)
    this.cellHeadingDy.fill(0)
    this.trails.fill(0)
    this.spatialHash.clear()
    this.pendingSpawns = []
    this.seedInitialCrowd()
    // NB: cellColorBuffer is scenario-static — not reset here.
  }

  // ═══════════════════════════════════════════════════════════════════
  // Hot-path stages — locals-at-top-of-loop for JIT friendliness
  // ═══════════════════════════════════════════════════════════════════

  private rebuildDensity(): void {
    const density = this.density
    const hdx = this.cellHeadingDx
    const hdy = this.cellHeadingDy
    const occupied = this.occupiedDensityCells
    for (let k = 0; k < this.occupiedDensityCount; k++) {
      const idx = occupied[k]!
      density[idx] = hdx[idx] = hdy[idx] = 0
    }
    let occupiedCount = 0
    const alive = this.pedAlive
    const cellIdx = this.pedCellIdx
    const pHdx = this.pedHeadingDx
    const pHdy = this.pedHeadingDy
    const n = this.pedCount
    for (let i = 0; i < n; i++) {
      if (alive[i] === 0) continue
      const idx = cellIdx[i]!
      if (idx < 0) continue
      if (density[idx] === 0) occupied[occupiedCount++] = idx
      density[idx] = density[idx]! + 1
      hdx[idx] = hdx[idx]! + pHdx[i]!
      hdy[idx] = hdy[idx]! + pHdy[i]!
    }
    this.occupiedDensityCount = occupiedCount
  }

  private rebuildSpatialHash(): void {
    const hash = this.spatialHash
    hash.clear()
    const radius = getMinAgentSpacing() * ORCA.radiusMultiplier
    const alive = this.pedAlive
    const x = this.pedX
    const y = this.pedY
    const headingDx = this.pedHeadingDx
    const headingDy = this.pedHeadingDy
    const speed = this.pedSpeed
    const currentSpeed = this.pedCurrentSpeed
    const routed = Boolean(this.routingCosts)
    const pedId = this.pedId
    const n = this.pedCount
    for (let i = 0; i < n; i++) {
      if (alive[i] === 0) continue
      const s = routed ? currentSpeed[i]! : currentSpeed[i]! || speed[i]! || 0
      const vx = headingDx[i]! * s
      const vy = headingDy[i]! * s
      hash.insert(pedId[i]!, x[i]!, y[i]!, vx, vy, radius, speed[i]!)
    }
  }

  /**
   * Consume the pending spawn queue.
   *
   * **READ-ONLY contract**: this method treats `pendingSpawns` as a
   * read-only sequence. It does not push, splice, sort, re-order, or
   * `length = 0` the array. This is load-bearing — it's what lets the
   * worker's dual-mode tick loop share ONE spawn array reference across
   * both sims without aliasing. If you add mutation here (e.g. an
   * internal reset), you must also update the worker to give each sim
   * its own `.slice()` per step.
   *
   * **Caller contract**: assign a fresh array to `pendingSpawns` before
   * each `step()` call. `Simulation` will not auto-clear. The worker
   * does this inside its per-step loop.
   */
  private spawnPending(): void {
    const spawns = this.pendingSpawns
    if (spawns.length === 0) return
    const capacity = this.initialCrowd ? TACUBAYA_CROWD.capacity : MAX_AGENTS
    for (let k = 0; k < spawns.length; k++) {
      if (this.pedAliveCount >= capacity) break
      const spec = spawns[k]!
      if (!spec.destNode) continue
      const crowd = this.initialCrowd
      const entry = crowd?.entries.get(spec.startNode.id)
      const destination = crowd?.entries.get(spec.destNode.id)
      if (crowd && (!entry || !destination)) continue
      const routing = this.routingCosts
      if (entry && destination && routing) {
        const origin = this.cellAt(entry.worldX, entry.worldY)
        const distance = this.crowdDistanceField(destination, routing)[origin]
        if (!Number.isFinite(distance) || distance === 0) continue
      }
      const startNode = entry ?? spec.startNode
      const destNode = destination ?? spec.destNode
      if (this.pedCount >= capacity) this.compactDead()
      const i = this.spawnAgent()
      pureInitialiseAgent(this, i, startNode, destNode, spec.shopProb, spec.waitProb)

      if (!crowd || this.pedAliveCount >= TACUBAYA_CROWD.replenishmentThreshold) continue
      // Increase peak-wave arrivals while occupancy is below target. The
      // same worker demand still governs which entries are active.
      const boost = (TACUBAYA_CROWD.replenishmentThreshold - this.pedAliveCount) /
        TACUBAYA_CROWD.replenishmentBand
      if (Math.random() < boost) {
        if (this.pedCount >= capacity) this.compactDead()
        const extra = this.spawnAgent()
        const position = [
          startNode.worldX! + (Math.random() - 0.5) * 0.8,
          startNode.worldY! + (Math.random() - 0.5) * 0.8,
        ] as const
        pureInitialiseAgent(this, extra, startNode, destNode, spec.shopProb, spec.waitProb, position)
      }
    }
  }

  private advanceAgents(): void {
    const result = this.advanceResult
    const dt = getBaseDeltaTime()
    const alive = this.pedAlive
    const engagementMode = this.pedEngagementMode
    const intimate = this.pedIntimateViolations
    const personal = this.pedPersonalViolations
    const social = this.pedSocialViolations
    const n = this.pedCount
    for (let i = 0; i < n; i++) {
      if (alive[i] === 0) continue
      pureAdvanceAgent(this, i, result)
      if (result.hasArrived) {
        this.arrivalsThisTick++
        this.totalArrivals++
      }
      this.totalSteps++
      this.totalMinutesShopped += result.shopMinutes
      this.totalMinutesWaited += result.waitMinutes

      const mode = engagementMode[i]!
      if (mode !== ENGAGEMENT_SHOPPING && mode !== ENGAGEMENT_WAITING) {
        this.totalNormalSteps++
        this.totalNormalDistanceTraveled += result.distanceTraveled
        this.totalNormalTime += dt

        if (intimate[i]! > 0)      this.totalIntimateZoneSteps++
        else if (personal[i]! > 0) this.totalPersonalZoneSteps++
        else if (social[i]! > 0)   this.totalSocialZoneSteps++
        else                       this.totalPublicZoneSteps++
      }
    }
  }
}
