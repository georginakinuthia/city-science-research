/**
 * Main ↔ worker message protocol.
 *
 * All types are plain-data (transferable) structures. Main thread sends
 * commands via `postMessage`; worker sends snapshots back the same way.
 *
 * The worker never imports Vue or Pinia. Main-thread stores translate
 * reactive changes into these messages and feed incoming snapshots back
 * into reactive refs for the UI.
 */

import type { RoutingData } from '../stores/geo'

import type { BehaviorParams } from './agentBehavior'
import type { SimSnapshot } from './SimSnapshot'

/**
 * Plain-data spawn descriptor used internally by both the worker and
 * main-thread code paths. Reflects the subset of `NodeState` fields that
 * the per-agent `initialiseAgent` pipeline reads.
 *
 * Kept in this module (shared by main thread and worker) so both realms
 * agree on the shape.
 */
export interface SerializedSpawnSpec {
  startNode: SerializedSpawnNode
  destNode: SerializedSpawnNode | null
  shopProb: number
  waitProb: number
}

export interface SerializedSpawnNode {
  id: string
  label?: string
  worldX?: number
  worldY?: number
  pph: number
  interval: number
  noEngagement?: boolean
}

// ─────────────────────────────────────────────────────────────
// Main → worker commands
// ─────────────────────────────────────────────────────────────

/**
 * INIT — ship the scenario data and everything else needed for the worker
 * to construct two Simulation instances and run them. Sent once per app
 * load. The worker replies with `INIT_DONE` when the sims are built and
 * scenario gen is complete.
 */
export interface InitMessage {
  type: 'INIT'
  mode: 'dual' | 'single'
  /** Shared bbox for both sims (main app) or for the single sim (sandbox). */
  bbox: [number, number, number, number]
  targetWidth: number
  /**
   * Scenario definitions. Dual mode uses `scenarioA` + `scenarioB`; single
   * mode (sandbox) uses `scenarioA` only.
   */
  scenarioA: SerializedScenario
  scenarioB?: SerializedScenario
  /** Spawn nodes with lon/lat coords. Worker projects them to cell space. */
  nodes: SerializedNode[]
  /** Initial behavior params snapshot. */
  params: BehaviorParams
  /**
   * Timing constants the worker needs. Kept in this bundle rather than
   * hardcoded in the worker so the config module stays authoritative —
   * the worker bundle never imports `src/config.ts` to avoid dragging
   * main-thread-only dependencies into its chunk.
   *
   * Note: `baseDeltaTime` is intentionally NOT in this bundle. It lives
   * on `BehaviorParams` (shipped via `params` above and updated via
   * `UPDATE_PARAMS` messages) because the per-agent pipeline in
   * `agentBehavior.ts` reads it alongside the other behavior params.
   * Having two sources of truth would invite drift.
   */
  timing: {
    fps: number
    fastModeMultiplier: number
    simulationDuration: number
  }
  /**
   * Cell color palette as pre-packed u32 values. Gradient closures can't
   * cross the worker boundary (functions aren't structured-clone-able),
   * so we send the colour stops and the worker builds its own gradients.
   */
  palette: CellPalette
}

export interface CellPalette {
  /** u32 for transparent (typically 0). */
  transparent: number
  /** u32 for walkable surface background. */
  surface: number
  /** Start + end stops of the stall potential gradient (u32 each). */
  stallStops: [number, number]
  /** Start + end stops of the furniture potential gradient. */
  furnitureStops: [number, number]
  /** Start + end stops of the shade potential gradient. */
  shadeStops: [number, number]
}

export interface SerializedScenario {
  /** Scenario id/name for logging. */
  name: string
  /** Raw GeoJSON feature collections. Transferable — structuredClone on send. */
  surfaces: unknown
  structures: unknown
  shade: unknown
  stalls: unknown
  furniture: unknown
  routing?: RoutingData
}

export interface SerializedNode {
  id: string
  label?: string
  coords?: [number, number]
  pph: number
  interval: number
  noEngagement?: boolean
}

/** START — begin the worker-side tick loop. */
export interface StartMessage {
  type: 'START'
}

/** STOP — pause the tick loop (idempotent). */
export interface StopMessage {
  type: 'STOP'
}

/** RESET — clear agents + stats + trails + elapsed time, keep scenarios. */
export interface ResetMessage {
  type: 'RESET'
}

export interface SetFastModeMessage {
  type: 'SET_FAST_MODE'
  fastMode: boolean
}

/** Update the full behavior params snapshot. */
export interface UpdateParamsMessage {
  type: 'UPDATE_PARAMS'
  params: BehaviorParams
}

/**
 * Update a single node's per-hour spawn rate. Emitted from the main
 * thread when a user drags a spawn-rate slider. The worker then uses
 * the new rate for its own per-tick spawn calculation.
 *
 * Spawn calculation now lives entirely inside the worker's tick loop
 * ([worker.ts](./worker.ts)) — the main thread never pushes spawns
 * directly. See the comment in `tick()` for the rationale.
 */
export interface UpdateNodePphMessage {
  type: 'UPDATE_NODE_PPH'
  nodeId: string
  pph: number
}

/**
 * RELEASE_SNAPSHOT — main thread returns a used snapshot's buffers to the
 * worker so they can be reused for the next tick. Transferable — the
 * ArrayBuffers are detached from the main thread on send.
 */
export interface ReleaseSnapshotMessage {
  type: 'RELEASE_SNAPSHOT'
  /** Scenario index (0 or 1). */
  simIdx: number
  /** The recycled buffers — same shape as the fields in `SimSnapshot`. */
  buffers: SnapshotBuffers
}

/** SET_FPS — change the tick rate. */
export interface SetFpsMessage {
  type: 'SET_FPS'
  fps: number
}

/** Bump indefinite-mode flag (whether to auto-stop at simulation duration). */
export interface SetIndefiniteModeMessage {
  type: 'SET_INDEFINITE_MODE'
  indefinite: boolean
}

export type WorkerCommand =
  | InitMessage
  | StartMessage
  | StopMessage
  | ResetMessage
  | SetFastModeMessage
  | SetFpsMessage
  | SetIndefiniteModeMessage
  | UpdateParamsMessage
  | UpdateNodePphMessage
  | ReleaseSnapshotMessage

// ─────────────────────────────────────────────────────────────
// Worker → main responses
// ─────────────────────────────────────────────────────────────

/**
 * INIT_DONE — worker has constructed its Simulations and completed
 * scenario gen. Ships back the scenario-static state that the renderer
 * needs: grid dimensions, the baked cell color buffer, the node id table
 * (for highlight lookups), and the serialized node coordinates.
 */
export interface InitDoneMessage {
  type: 'INIT_DONE'
  mode: 'dual' | 'single'
  /** Scenario-static state per sim. */
  sims: SimStaticState[]
  /**
   * Projected node positions (the worker's `lonToX` / `latToY` applied to
   * each node's coords). Main thread uses these for the UI's node markers
   * and highlight dropdown.
   */
  projectedNodes: Array<{
    id: string
    label?: string
    pph: number
    interval: number
    worldX?: number
    worldY?: number
    noEngagement?: boolean
  }>
}

export interface SimStaticState {
  width: number
  height: number
  bbox: [number, number, number, number]
  /** Pre-baked cell colors — the exact buffer to feed MapRenderer's `sim.cellColorBuffer` shim. Transferable. */
  cellColorBuffer: Uint32Array
  /** String table for agent.startNodeId highlight lookups. */
  nodeIdTable: string[]
  /** Paused state to draw as soon as the scenario is initialized. */
  initialSnapshot: SimSnapshot
}

export interface InitErrorMessage {
  type: 'INIT_ERROR'
  message: string
  stack?: string
}

/**
 * SNAPSHOT — render-critical state after a tick batch. Sent on a cadence
 * matching the main thread's render rate (one per rAF frame, not one per
 * sim tick). Uses transferable ArrayBuffers for zero-copy handoff.
 */
export interface SnapshotMessage {
  type: 'SNAPSHOT'
  simIdx: number   // 0 for A / single, 1 for B
  snapshot: SimSnapshot
}

export interface StatsUpdateMessage {
  type: 'STATS'
  simIdx: number
  totalArrivals: number
  arrivalsThisTick: number
  totalMinutesShopped: number
  totalMinutesWaited: number
  totalSteps: number
  totalNormalSteps: number
  totalNormalDistanceTraveled: number
  totalNormalTime: number
  totalPublicZoneSteps: number
  totalIntimateZoneSteps: number
  totalPersonalZoneSteps: number
  totalSocialZoneSteps: number
  /** Number of live agents in the sim at the time of the snapshot. */
  currentAgents: number
  currentShopping: number
  currentWaiting: number
  /** Worker-side elapsed sim seconds (cumulative since last reset). */
  elapsedSimSeconds: number
  /** Worker-side sim step count (cumulative since last reset). */
  globalTick: number
}

export type WorkerResponse =
  | InitDoneMessage
  | InitErrorMessage
  | SnapshotMessage
  | StatsUpdateMessage

// ─────────────────────────────────────────────────────────────
// Snapshot buffer bundle (transferable)
// ─────────────────────────────────────────────────────────────

/**
 * Transferable bundle of typed-array buffers for one sim's render state.
 * Used both for snapshots flowing worker → main and for release messages
 * flowing main → worker.
 */
export interface SnapshotBuffers {
  pedX: Float32Array
  pedY: Float32Array
  pedHeading: Float32Array
  pedEngagementMode: Uint8Array
  pedVisualRisk: Uint8Array
  pedStartNodeIdx: Int32Array
  pedIntimateViolations: Uint16Array
  pedPersonalViolations: Uint16Array
  pedSocialViolations: Uint16Array
}

/** Collect the transferable ArrayBuffer handles from a bundle. */
export function collectTransferables(b: SnapshotBuffers): Transferable[] {
  return [
    b.pedX.buffer,
    b.pedY.buffer,
    b.pedHeading.buffer,
    b.pedEngagementMode.buffer,
    b.pedVisualRisk.buffer,
    b.pedStartNodeIdx.buffer,
    b.pedIntimateViolations.buffer,
    b.pedPersonalViolations.buffer,
    b.pedSocialViolations.buffer,
  ]
}
