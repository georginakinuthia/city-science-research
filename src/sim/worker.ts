/**
 * Sim Web Worker entry point.
 *
 * Owns one or two `Simulation` instances (dual mode for the main corridor
 * view, single mode for the sandbox). Runs the tick loop on its own
 * `setInterval` schedule, independent of the main-thread render cadence.
 *
 * Communication is strictly through `postMessage` with transferable
 * typed-array buffers for zero-copy snapshot handoff. This module imports
 * **nothing** from Vue, Pinia, or any DOM API — keeps the worker bundle
 * small and ensures the tick loop has no incidental main-thread deps.
 */

import type { FeatureCollection, Geometry } from 'geojson'

import { TACUBAYA_CROWD } from '../config'
import { getAgentVisualRisk } from './agentBehavior'
import { type NodeState, spawnFromNodes } from '../stores/geo'
import { setBehaviorParams } from './agentBehavior'
import { ScenarioContainer } from './scenarioGen'
import { makeGradientU32 } from './colors'
import type { SimSnapshot } from './SimSnapshot'
import {
  ENGAGEMENT_SHOPPING,
  ENGAGEMENT_WAITING,
  Simulation,
} from './Simulation'
import { createLoop, type LoopHandle } from './tick'
import { releaseToPool } from './workerPool'
import {
  collectTransferables,
  type InitDoneMessage,
  type InitMessage,
  type SerializedScenario,
  type SimStaticState,
  type SnapshotBuffers,
  type SnapshotMessage,
  type StatsUpdateMessage,
  type WorkerCommand,
  type WorkerResponse,
} from './workerProtocol'

// ─────────────────────────────────────────────────────────────
// Worker state
// ─────────────────────────────────────────────────────────────

interface SimState {
  sim: Simulation
  /** Pool of unused SnapshotBuffers. Recycled via RELEASE_SNAPSHOT. */
  bufferPool: SnapshotBuffers[]
}

/**
 * Max snapshot buffers kept in the pool per sim. In steady state the
 * pipeline only needs 2 (one in flight on the main thread, one being
 * built on the worker), but startup latency can briefly grow the pool.
 * Anything beyond 4 is pure waste — drop the excess so the GC can
 * reclaim the `ArrayBuffer` backing storage.
 */
const MAX_POOL_SIZE = 4

let sims: SimState[] = []
let mode: 'dual' | 'single' = 'dual'
let loop: LoopHandle | null = null
let isRunning = false
let isFastMode = false
let fps = 30
let fastModeMultiplier = 4
let baseDeltaTime = 0.25
let simulationDuration = 3600 // seconds
let elapsedSimSeconds = 0
let globalTick = 0
let isIndefiniteMode = true

/**
 * Node list used by the worker's per-step spawn calculation.
 *
 * Populated in `handleInit` with the projected coordinates, then kept in
 * sync with the main-thread UI via `UPDATE_NODE_PPH` messages when the
 * user drags a spawn-rate slider. Everything spawn-related happens inside
 * the worker's own tick loop — the main thread does NOT push spawns.
 *
 * Rationale: the main thread's rAF fires at the display refresh rate
 * (~60 Hz), while the worker ticks at `fps` (30 Hz) and advances the sim
 * by `baseDeltaTime × stepsPerTick` per tick. Computing spawns on the
 * main thread and pushing them via `postMessage` decouples rate
 * calculation from actual sim time advance, producing 2× over-spawning
 * in regular mode and ½× under-spawning in fast mode depending on clock
 * phase alignment. The only correct place to compute spawns is the same
 * loop that calls `sim.step()`, which is here.
 */
let workerNodes: NodeState[] = []

/**
 * `id → NodeState` index — built alongside `workerNodes` in `handleInit`
 * so `UPDATE_NODE_PPH` messages can do an O(1) lookup instead of a
 * linear scan. Small optimisation but sliders can fire at 60 Hz and the
 * scan is repeated per message.
 */
let workerNodesIndex: Map<string, NodeState> = new Map()

// ─────────────────────────────────────────────────────────────
// Message handling
// ─────────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const msg = e.data
  switch (msg.type) {
    case 'INIT': {
      try {
        handleInit(msg)
      } catch (error) {
        stopLoop()
        sims = []
        postReply({
          type: 'INIT_ERROR',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      }
      break
    }
    case 'START':
      startLoop()
      break
    case 'STOP':
      stopLoop()
      break
    case 'RESET':
      handleReset()
      break
    case 'SET_FAST_MODE':
      isFastMode = msg.fastMode
      break
    case 'SET_FPS':
      fps = msg.fps
      // Restart loop to apply new fps
      if (isRunning) {
        stopLoop()
        startLoop()
      }
      break
    case 'SET_INDEFINITE_MODE':
      isIndefiniteMode = msg.indefinite
      break
    case 'UPDATE_PARAMS':
      setBehaviorParams(msg.params)
      baseDeltaTime = msg.params.baseDeltaTime
      break
    case 'UPDATE_NODE_PPH': {
      const node = workerNodesIndex.get(msg.nodeId)
      if (node) node.pph = msg.pph
      break
    }
    case 'RELEASE_SNAPSHOT': {
      const state = sims[msg.simIdx]
      if (state) releaseToPool(state.bufferPool, msg.buffers, MAX_POOL_SIZE)
      break
    }
  }
}

// ─────────────────────────────────────────────────────────────
// INIT — build sims + run scenario gen
// ─────────────────────────────────────────────────────────────

function handleInit(msg: InitMessage): void {
  const [west, south, east, north] = msg.bbox
  if (!msg.bbox.every(Number.isFinite) || east <= west || north <= south ||
      !Number.isInteger(msg.targetWidth) || msg.targetWidth < 1) {
    throw new Error('Cannot initialize the simulation with an invalid grid.')
  }
  if (msg.mode === 'dual' && !msg.scenarioB) {
    throw new Error('Scenario B is required for dual simulation mode.')
  }
  mode = msg.mode

  // Install the initial params snapshot so scenario gen + first tick
  // uses the correct values from the start.
  setBehaviorParams(msg.params)
  baseDeltaTime = msg.params.baseDeltaTime

  // Absorb the timing config from the main thread. These live in
  // src/config.ts on the main side; the worker would otherwise need to
  // import that module, pulling Vue/Pinia into its bundle.
  fps = msg.timing.fps
  fastModeMultiplier = msg.timing.fastModeMultiplier
  simulationDuration = msg.timing.simulationDuration

  // Construct simulation instances
  const simCount = mode === 'dual' ? 2 : 1
  sims = new Array(simCount).fill(null).map(() => ({
    sim: new Simulation(msg.bbox, msg.targetWidth),
    bufferPool: [],
  }))

  // Cross-sim projection invariant: we project nodes once using sims[0]
  // and reuse the result for every sim. This is valid ONLY if every sim
  // has the same bbox and targetWidth, which gives identical width/height
  // and therefore identical `lonToX`/`latToY` scale factors.
  //
  // The main-thread `models.ts::initModel` derives a combined bbox from
  // both scenarios before constructing the Simulations, so this holds
  // today. The assert below traps any future change that breaks it —
  // better a loud crash at init than a silent per-sim coordinate drift.
  if (sims.length > 1) {
    const first = sims[0]!.sim
    for (let i = 1; i < sims.length; i++) {
      const other = sims[i]!.sim
      if (first.width !== other.width || first.height !== other.height) {
        throw new Error(
          `[sim worker] grid dimensions differ across sims (` +
          `${first.width}×${first.height} vs ${other.width}×${other.height}). ` +
          `Node projection would drift — main thread must pass a shared bbox.`,
        )
      }
    }
  }

  // Project nodes into cell space using the first sim (both sims share bbox)
  const firstSim = sims[0]!.sim
  const projectedNodes: NodeState[] = msg.nodes.map((n) => {
    const projected: NodeState = {
      id: n.id,
      label: n.label,
      coords: n.coords,
      pph: n.pph,
      interval: n.interval,
      noEngagement: n.noEngagement,
    }
    if (n.coords) {
      projected.worldX = firstSim.lonToX(n.coords[0])
      projected.worldY = firstSim.latToY(n.coords[1])
    }
    return projected
  })

  // Keep this list in module state — the tick loop reads it every
  // sim step to compute the next spawn batch, and UPDATE_NODE_PPH
  // messages mutate the pph field in place.
  workerNodes = projectedNodes
  // Paired `id → node` index for O(1) UPDATE_NODE_PPH lookups.
  workerNodesIndex = new Map()
  for (const node of projectedNodes) {
    workerNodesIndex.set(node.id, node)
  }

  // Run scenario gen on each sim
  const scenarioDefs: SerializedScenario[] = [msg.scenarioA]
  if (mode === 'dual' && msg.scenarioB) scenarioDefs.push(msg.scenarioB)

  const staticStates: SimStaticState[] = []
  for (let i = 0; i < sims.length; i++) {
    const state = sims[i]!
    const def = scenarioDefs[i]!
    const scenario = new ScenarioContainer(
      {
        surfaces: def.surfaces as FeatureCollection<Geometry>,
        structures: def.structures as FeatureCollection<Geometry>,
        stalls: def.stalls as FeatureCollection<Geometry>,
        furniture: def.furniture as FeatureCollection<Geometry>,
        shade: def.shade as FeatureCollection<Geometry>,
        routing: def.routing,
      },
      def.name,
    )
    state.sim.generateScenario(scenario, projectedNodes)

    // Bake scenario-static cell colors using the palette sent in INIT.
    // Closures can't cross the worker boundary, so the main thread sends
    // u32 stops and we build gradients here.
    const stallGradient = makeGradientU32(msg.palette.stallStops[0], msg.palette.stallStops[1])
    const furnitureGradient = makeGradientU32(msg.palette.furnitureStops[0], msg.palette.furnitureStops[1])
    const shadeGradient = makeGradientU32(msg.palette.shadeStops[0], msg.palette.shadeStops[1])
    state.sim.bakeCellColors({
      stallGradient,
      furnitureGradient,
      shadeGradient,
      surface: msg.palette.surface,
      transparent: msg.palette.transparent,
    })

    // The dual map snapshots fit in these buffers from startup to saturation.
    const cap = mode === 'dual' ? TACUBAYA_CROWD.capacity : 256
    for (let k = 0; k < 2; k++) {
      state.bufferPool.push(allocSnapshotBuffers(cap))
    }

    // Keep the worker's color buffer and transfer a copy to the renderer.
    const staticState: SimStaticState = {
      width: state.sim.width,
      height: state.sim.height,
      bbox: [state.sim.bbox[0], state.sim.bbox[1], state.sim.bbox[2], state.sim.bbox[3]],
      cellColorBuffer: new Uint32Array(state.sim.cellColorBuffer), // copy
      nodeIdTable: [...state.sim.nodeIdTable],
      initialSnapshot: buildSnapshot(state),
    }
    staticStates.push(staticState)
  }

  const reply: InitDoneMessage = {
    type: 'INIT_DONE',
    mode,
    sims: staticStates,
    projectedNodes: projectedNodes.map((n) => ({
      id: n.id,
      label: n.label,
      pph: n.pph,
      interval: n.interval,
      worldX: n.worldX,
      worldY: n.worldY,
      noEngagement: n.noEngagement,
    })),
  }
  postReply(reply, staticStates.flatMap((state) => [
    state.cellColorBuffer.buffer,
    ...collectTransferables(state.initialSnapshot),
  ]))
  if (mode === 'dual') {
    for (const [index, state] of sims.entries()) publishStats(state, index)
  }
}

// ─────────────────────────────────────────────────────────────
// Tick loop
// ─────────────────────────────────────────────────────────────

function startLoop(): void {
  if (loop !== null) return
  isRunning = true
  // Wrap `tick()` so a thrown error stops the loop instead of letting
  // `setInterval` fire it again on the next cycle. Without this guard a
  // buggy step would spam the console with the same error every tick.
  loop = createLoop(() => {
    try {
      tick()
    } catch (err) {
      console.error('[sim worker] tick threw, stopping loop:', err)
      stopLoop()
      // Re-throw so the main thread's `worker.onerror` handler fires —
      // otherwise the UI would silently freeze with no diagnostic.
      throw err
    }
  }, { fps })
  loop.start()
}

function stopLoop(): void {
  if (loop !== null) {
    loop.stop()
    loop = null
  }
  isRunning = false
}

function handleReset(): void {
  stopLoop()
  elapsedSimSeconds = 0
  globalTick = 0
  for (const state of sims) {
    state.sim.reset()
  }
  if (mode === 'dual') {
    for (const [index, state] of sims.entries()) {
      publishSnapshot(state, index)
      publishStats(state, index)
    }
  }
}

function tick(): void {
  const stepsPerFrame = isFastMode ? fastModeMultiplier : 1

  for (let s = 0; s < stepsPerFrame; s++) {
    // Compute a fresh spawn batch for THIS sim step. The formula
    //   P(spawn) = (pph / 3600) × baseDeltaTime
    // in `spawnFromNodes` expresses the probability of a spawn over a
    // single `baseDeltaTime`-length window of sim time, so it must be
    // invoked once per sim step to produce the correct long-run rate.
    //
    // Both sims share ONE reference to the spawn array. This is safe
    // because `Simulation.spawnPending` is documented as read-only on
    // its `pendingSpawns` input — it iterates but never mutates.
    // Sharing saves one shallow-copy per sim per step (doubles in fast
    // mode). See the contract comment on `Simulation.spawnPending`.
    const spawnsForThisStep = spawnFromNodes(workerNodes, baseDeltaTime)
    for (const state of sims) {
      state.sim.pendingSpawns = spawnsForThisStep
    }

    for (const state of sims) {
      state.sim.step()
    }

    globalTick += 1
    elapsedSimSeconds += baseDeltaTime

    if (!isIndefiniteMode && elapsedSimSeconds >= simulationDuration) {
      stopLoop()
      break
    }
  }

  for (const [index, state] of sims.entries()) {
    publishSnapshot(state, index)
    publishStats(state, index)
  }
}

function publishStats(state: SimState, simIdx: number): void {
  const { sim } = state
  const statsMsg: StatsUpdateMessage = {
    type: 'STATS',
    simIdx,
    totalArrivals: sim.totalArrivals,
    arrivalsThisTick: sim.arrivalsThisTick,
    totalMinutesShopped: sim.totalMinutesShopped,
    totalMinutesWaited: sim.totalMinutesWaited,
    totalSteps: sim.totalSteps,
    totalNormalSteps: sim.totalNormalSteps,
    totalNormalDistanceTraveled: sim.totalNormalDistanceTraveled,
    totalNormalTime: sim.totalNormalTime,
    totalPublicZoneSteps: sim.totalPublicZoneSteps,
    totalIntimateZoneSteps: sim.totalIntimateZoneSteps,
    totalPersonalZoneSteps: sim.totalPersonalZoneSteps,
    totalSocialZoneSteps: sim.totalSocialZoneSteps,
    currentAgents: sim.pedAliveCount,
    currentShopping: countEngagementMode(sim, ENGAGEMENT_SHOPPING),
    currentWaiting: countEngagementMode(sim, ENGAGEMENT_WAITING),
    elapsedSimSeconds,
    globalTick,
  }
  postReply(statsMsg)
}

function publishSnapshot(state: SimState, simIdx: number): void {
  const snapshot = buildSnapshot(state)
  const snapMsg: SnapshotMessage = { type: 'SNAPSHOT', simIdx, snapshot }
  postReply(snapMsg, collectTransferables(snapshot))
}

// ─────────────────────────────────────────────────────────────
// Snapshot construction
// ─────────────────────────────────────────────────────────────

function allocSnapshotBuffers(capacity: number): SnapshotBuffers {
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

/**
 * Build a dense, live-only snapshot of the sim's render state. Uses a
 * recycled buffer from the pool if one is available and large enough;
 * otherwise allocates fresh.
 */
function buildSnapshot(state: SimState): SimSnapshot {
  const sim = state.sim
  const liveCount = sim.pedAliveCount
  // Pick the smallest pool buffer that fits, or allocate if none does.
  // Geometric growth keeps reallocation rare.
  let bufs: SnapshotBuffers | undefined
  for (let k = 0; k < state.bufferPool.length; k++) {
    const candidate = state.bufferPool[k]!
    if (candidate.pedX.length >= liveCount) {
      bufs = candidate
      state.bufferPool.splice(k, 1)
      break
    }
  }
  if (!bufs) {
    const cap = Math.max(256, liveCount * 2)
    bufs = allocSnapshotBuffers(cap)
  }

  // Compact live agents into the snapshot arrays
  const alive = sim.pedAlive
  const pedX = sim.pedX
  const pedY = sim.pedY
  const pedHeading = sim.pedHeading
  const pedEngagementMode = sim.pedEngagementMode
  const pedStartNodeIdx = sim.pedStartNodeIdx
  const pedIntimateViolations = sim.pedIntimateViolations
  const pedPersonalViolations = sim.pedPersonalViolations
  const pedSocialViolations = sim.pedSocialViolations

  let w = 0
  const n = sim.pedCount
  for (let i = 0; i < n; i++) {
    if (alive[i] === 0) continue
    bufs.pedX[w] = pedX[i]!
    bufs.pedY[w] = pedY[i]!
    bufs.pedHeading[w] = pedHeading[i]!
    bufs.pedEngagementMode[w] = pedEngagementMode[i]!
    bufs.pedVisualRisk[w] = getAgentVisualRisk(sim, i)
    bufs.pedStartNodeIdx[w] = pedStartNodeIdx[i]!
    bufs.pedIntimateViolations[w] = pedIntimateViolations[i]!
    bufs.pedPersonalViolations[w] = pedPersonalViolations[i]!
    bufs.pedSocialViolations[w] = pedSocialViolations[i]!
    w++
  }

  return {
    pedCount: w,
    capacity: bufs.pedX.length,
    pedX: bufs.pedX,
    pedY: bufs.pedY,
    pedHeading: bufs.pedHeading,
    pedEngagementMode: bufs.pedEngagementMode,
    pedVisualRisk: bufs.pedVisualRisk,
    pedStartNodeIdx: bufs.pedStartNodeIdx,
    pedIntimateViolations: bufs.pedIntimateViolations,
    pedPersonalViolations: bufs.pedPersonalViolations,
    pedSocialViolations: bufs.pedSocialViolations,
  }
}

function countEngagementMode(sim: Simulation, mode: number): number {
  const alive = sim.pedAlive
  const em = sim.pedEngagementMode
  const n = sim.pedCount
  let count = 0
  for (let i = 0; i < n; i++) {
    if (alive[i] === 0) continue
    if (em[i] === mode) count++
  }
  return count
}

// ─────────────────────────────────────────────────────────────
// Message posting (worker → main)
// ─────────────────────────────────────────────────────────────

function postReply(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    ;(self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(msg, transfer)
  } else {
    self.postMessage(msg)
  }
}
