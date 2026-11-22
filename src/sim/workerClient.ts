/**
 * Main-thread helper for spawning and communicating with the sim worker.
 *
 * Wraps the low-level `postMessage` protocol in a small API that the
 * Pinia stores consume. The worker lifecycle is:
 *
 *   1. `new SimWorkerClient()` — spawns the worker module
 *   2. `await client.init({...})` — ships scenario data + palette, awaits INIT_DONE
 *   3. `client.start()` / `client.stop()` — controls the tick loop
 *   4. `client.setParams(...)` — pushes updated behavior params
 *   5. `client.setNodePph(id, pph)` — forwards slider changes to the worker
 *   6. `client.onSnapshot(cb)` — register a renderer to receive snapshots
 *   7. `client.onStats(cb)` — register a stats consumer (UI totals)
 *   8. `client.dispose()` — terminate the worker
 *
 * Spawn calculation itself lives inside the worker's tick loop (see
 * [worker.ts](./worker.ts)::tick) — the main thread does NOT push spawns.
 * That decoupling was added after we discovered that computing spawns on
 * the main thread's rAF (~60 Hz) and applying them in the worker's
 * setInterval (~30 Hz) produced clock-drift-dependent rate errors of 2×
 * and ½×. See the `workerNodes` block comment in `worker.ts` for the
 * full rationale.
 *
 * The client owns one or two `SimView` instances and updates them in
 * place when snapshots arrive. Renderers hold references to the views,
 * so new snapshot data is visible on the next `draw()` call without any
 * explicit plumbing.
 */

import type { BehaviorParams } from './agentBehavior'
import { SimView } from './SimView'
import type {
  CellPalette,
  InitDoneMessage,
  InitMessage,
  SerializedNode,
  SerializedScenario,
  SnapshotMessage,
  StatsUpdateMessage,
  WorkerResponse,
} from './workerProtocol'

export type SnapshotCallback = (simIdx: number, view: SimView) => void
export type StatsCallback = (msg: StatsUpdateMessage) => void

/** Allow time to rasterize both study areas and compute their starting routes. */
const INIT_TIMEOUT_MS = 30_000

export interface ClientInitOptions {
  mode: 'dual' | 'single'
  bbox: [number, number, number, number]
  targetWidth: number
  scenarioA: SerializedScenario
  scenarioB?: SerializedScenario
  nodes: SerializedNode[]
  params: BehaviorParams
  timing: {
    fps: number
    fastModeMultiplier: number
    simulationDuration: number
  }
  palette: CellPalette
}

export interface ClientInitResult {
  /** One SimView per sim in mode order (A then B, or just A for single). */
  views: SimView[]
  /** Projected node coordinates (world x,y in cell space). */
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

export class SimWorkerClient {
  private worker: Worker | null = null
  private views: SimView[] = []
  private snapshotCbs: SnapshotCallback[] = []
  private statsCbs: StatsCallback[] = []
  private initResolver: ((result: ClientInitResult) => void) | null = null
  private initRejecter: ((reason: unknown) => void) | null = null

  constructor() {
    // Use Vite's Web Worker import pattern: `?worker` suffix + ES module type.
    // The built output resolves to a separate chunk loaded via `new Worker(...)`.
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      this.handleMessage(e.data)
    }
    this.worker.onerror = (err) => {
      const error = err.error instanceof Error
        ? err.error
        : new Error(err.message || 'The simulation worker could not load.')
      if (this.initRejecter) this.failInit(error)
      else console.error('[sim worker] error:', error.message, error)
    }
  }

  /**
   * Ship INIT to the worker and wait for INIT_DONE.
   *
   * Rejects with a timeout error if INIT_DONE doesn't arrive within
   * `INIT_TIMEOUT_MS`. This guards against the failure
   * mode where the worker loads, doesn't throw, but never responds —
   * e.g., an exception inside `handleInit` that's swallowed somewhere.
   * Without the timeout the init promise would hang forever.
   */
  init(opts: ClientInitOptions): Promise<ClientInitResult> {
    const worker = this.worker
    if (!worker) throw new Error('SimWorkerClient disposed')
    const msg: InitMessage = {
      type: 'INIT',
      mode: opts.mode,
      bbox: opts.bbox,
      targetWidth: opts.targetWidth,
      scenarioA: opts.scenarioA,
      scenarioB: opts.scenarioB,
      nodes: opts.nodes,
      params: opts.params,
      timing: opts.timing,
      palette: opts.palette,
    }
    return new Promise<ClientInitResult>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timeoutId = null
        this.failInit(
          new Error(
            `SimWorkerClient.init timed out after ${INIT_TIMEOUT_MS}ms — ` +
            `worker did not respond with INIT_DONE. Check worker console for errors.`,
          ),
        )
      }, INIT_TIMEOUT_MS)
      this.initResolver = (result) => {
        if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null }
        resolve(result)
      }
      this.initRejecter = (reason) => {
        if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null }
        reject(reason)
      }
      try {
        worker.postMessage(msg)
      } catch (error) {
        this.failInit(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  start(): void {
    this.worker?.postMessage({ type: 'START' })
  }

  stop(): void {
    this.worker?.postMessage({ type: 'STOP' })
  }

  reset(): void {
    this.worker?.postMessage({ type: 'RESET' })
  }

  setFastMode(fastMode: boolean): void {
    this.worker?.postMessage({ type: 'SET_FAST_MODE', fastMode })
  }

  setFps(fps: number): void {
    this.worker?.postMessage({ type: 'SET_FPS', fps })
  }

  setIndefiniteMode(indefinite: boolean): void {
    this.worker?.postMessage({ type: 'SET_INDEFINITE_MODE', indefinite })
  }

  setParams(params: BehaviorParams): void {
    this.worker?.postMessage({ type: 'UPDATE_PARAMS', params })
  }

  /**
   * Update a node's per-hour spawn rate. Sent when a UI slider moves.
   * Spawn calculation itself lives inside the worker's tick loop — we
   * only push the new `pph` value; the worker uses it on the next tick.
   */
  setNodePph(nodeId: string, pph: number): void {
    this.worker?.postMessage({ type: 'UPDATE_NODE_PPH', nodeId, pph })
  }

  /** Register a callback invoked every time a fresh snapshot arrives. */
  onSnapshot(cb: SnapshotCallback): void {
    this.snapshotCbs.push(cb)
  }

  /** Register a callback invoked every time a stats update arrives. */
  onStats(cb: StatsCallback): void {
    this.statsCbs.push(cb)
  }

  /** Terminate the worker and release resources. */
  dispose(): void {
    if (this.initRejecter) this.failInit(new Error('Simulation worker was disposed.'))
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.views = []
    this.snapshotCbs = []
    this.statsCbs = []
  }

  // ─────────────────────────────────────────────────────────

  private handleMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'INIT_DONE':
        this.handleInitDone(msg)
        break
      case 'INIT_ERROR': {
        const error = new Error(msg.message)
        if (msg.stack) error.stack = msg.stack
        this.failInit(error)
        break
      }
      case 'SNAPSHOT':
        this.handleSnapshot(msg)
        break
      case 'STATS':
        for (const cb of this.statsCbs) cb(msg)
        break
    }
  }

  private failInit(error: Error): void {
    const reject = this.initRejecter
    this.initResolver = null
    this.initRejecter = null
    reject?.(error)
  }

  private handleInitDone(msg: InitDoneMessage): void {
    if (!this.initResolver) return
    this.views = msg.sims.map((s) => {
      const view = new SimView(s)
      view.updateSnapshot(s.initialSnapshot)
      return view
    })
    if (this.initResolver) {
      this.initResolver({
        views: this.views,
        projectedNodes: msg.projectedNodes,
      })
      this.initResolver = null
      this.initRejecter = null
    }
  }

  private handleSnapshot(msg: SnapshotMessage): void {
    const view = this.views[msg.simIdx]
    if (!view) return
    // Swap the view's backing snapshot. Previous snapshot's typed
    // array buffers are returned to the worker for reuse — the
    // transferable mechanics make this zero-copy.
    const prev = view.updateSnapshot(msg.snapshot)
    this.worker?.postMessage(
      {
        type: 'RELEASE_SNAPSHOT',
        simIdx: msg.simIdx,
        buffers: {
          pedX: prev.pedX,
          pedY: prev.pedY,
          pedHeading: prev.pedHeading,
          pedEngagementMode: prev.pedEngagementMode,
          pedStartNodeIdx: prev.pedStartNodeIdx,
          pedIntimateViolations: prev.pedIntimateViolations,
          pedPersonalViolations: prev.pedPersonalViolations,
          pedSocialViolations: prev.pedSocialViolations,
        },
      },
      [
        prev.pedX.buffer,
        prev.pedY.buffer,
        prev.pedHeading.buffer,
        prev.pedEngagementMode.buffer,
        prev.pedStartNodeIdx.buffer,
        prev.pedIntimateViolations.buffer,
        prev.pedPersonalViolations.buffer,
        prev.pedSocialViolations.buffer,
      ],
    )
    // Notify renderer(s)
    for (const cb of this.snapshotCbs) cb(msg.simIdx, view)
  }
}
