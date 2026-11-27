/**
 * SimView — main-thread read-only proxy for a worker-owned Simulation.
 *
 * Exposes the subset of `Simulation` fields that the renderer (and
 * ThreeView) actually read, backed by the latest `SimSnapshot` received
 * from the worker. Satisfies the structural `RenderSimLike` interface
 * used by `createMapRenderer` so the same renderer code works against
 * either a live Simulation (tests, baseline fixture) or a SimView
 * (production with a worker).
 *
 * `SimView` is MUTABLE in the sense that `updateSnapshot(snap)` swaps the
 * backing buffers atomically — readers iterating during that swap would
 * see inconsistent state, but render code only reads inside a single
 * synchronous `draw()` call so there's no race in practice.
 */

import { createEmptySnapshot, type SimSnapshot } from './SimSnapshot'

export interface SimViewOptions {
  width: number
  height: number
  bbox: readonly [number, number, number, number]
  cellColorBuffer: Uint32Array
  nodeIdTable: string[]
}

export class SimView {
  readonly width: number
  readonly height: number
  readonly bbox: readonly [number, number, number, number]
  /** Pre-baked cell colors, produced by the worker and shipped in INIT_DONE. */
  readonly cellColorBuffer: Uint32Array
  readonly nodeIdTable: string[]

  /**
   * Marker read by `createMapRenderer` to skip the `pedAlive[i] === 0` check.
   * Worker snapshots are already compacted to live agents only, so every slot
   * in `[0, pedCount)` is alive — the check would always be false, wasting a
   * load + branch per agent per frame.
   */
  readonly snapshotIsCompacted = true

  /** Cached inverse scales for lon/lat ↔ cell conversion on the main thread. */
  private readonly xScale: number
  private readonly yScale: number

  /** id → interned index — built once, then O(1) lookups on the hot highlight path. */
  private readonly nodeIdIndex: Map<string, number>

  private _snapshot: SimSnapshot

  constructor(opts: SimViewOptions) {
    this.width = opts.width
    this.height = opts.height
    this.bbox = opts.bbox
    this.cellColorBuffer = opts.cellColorBuffer
    this.nodeIdTable = opts.nodeIdTable
    this.xScale = opts.width / (opts.bbox[2] - opts.bbox[0])
    this.yScale = opts.height / (opts.bbox[3] - opts.bbox[1])
    this._snapshot = createEmptySnapshot(256)
    this.nodeIdIndex = new Map()
    for (let i = 0; i < opts.nodeIdTable.length; i++) {
      this.nodeIdIndex.set(opts.nodeIdTable[i]!, i)
    }
  }

  /** Replace the current snapshot. Previous snapshot's buffers are
   * released to the caller to be recycled (sent back to the worker). */
  updateSnapshot(snap: SimSnapshot): SimSnapshot {
    const prev = this._snapshot
    this._snapshot = snap
    return prev
  }

  get snapshot(): SimSnapshot {
    return this._snapshot
  }

  // ─── Fields the renderer reads (matches Simulation's shape) ───

  get pedCount(): number { return this._snapshot.pedCount }
  get pedX(): Float32Array { return this._snapshot.pedX }
  get pedY(): Float32Array { return this._snapshot.pedY }
  get pedHeading(): Float32Array { return this._snapshot.pedHeading }
  get pedVisualRisk(): Uint8Array { return this._snapshot.pedVisualRisk }
  get pedEngagementMode(): Uint8Array { return this._snapshot.pedEngagementMode }
  get pedStartNodeIdx(): Int32Array { return this._snapshot.pedStartNodeIdx }
  get pedIntimateViolations(): Uint16Array { return this._snapshot.pedIntimateViolations }
  get pedPersonalViolations(): Uint16Array { return this._snapshot.pedPersonalViolations }
  get pedSocialViolations(): Uint16Array { return this._snapshot.pedSocialViolations }

  /**
   * Shared all-ones `Uint8Array` returned by `pedAlive`. Worker snapshots
   * are pre-compacted to live-only agents, so every slot is "alive" from
   * the renderer's perspective. We expose a single grow-on-demand buffer
   * so any code paths that still read `pedAlive[i]` get truthy values
   * without allocating — but `createMapRenderer` checks `snapshotIsCompacted`
   * and skips the `alive[i]` read entirely.
   */
  private _aliveOnes: Uint8Array = new Uint8Array(256).fill(1)
  get pedAlive(): Uint8Array {
    const needed = this._snapshot.capacity
    if (this._aliveOnes.length < needed) {
      this._aliveOnes = new Uint8Array(needed).fill(1)
    }
    return this._aliveOnes
  }

  // ─── Coordinate helpers used by the view layer ───

  lonToX(lon: number): number {
    return (lon - this.bbox[0]) * this.xScale - 0.5
  }

  latToY(lat: number): number {
    return (this.bbox[3] - lat) * this.yScale - 0.5
  }

  xToLon(x: number): number {
    return this.bbox[0] + (x + 0.5) / this.xScale
  }

  yToLat(y: number): number {
    return this.bbox[3] - (y + 0.5) / this.yScale
  }

  cellCornersGeoJSON(): [number, number][] {
    const [minLon, minLat, maxLon, maxLat] = this.bbox
    return [
      [minLon, maxLat],  // NW
      [maxLon, maxLat],  // NE
      [maxLon, minLat],  // SE
      [minLon, minLat],  // SW
    ]
  }

  /** Look up a node string id → interned index (O(1)). Used by the highlight path. */
  nodeIdxFor(id: string | null | undefined): number {
    if (id == null) return -1
    return this.nodeIdIndex.get(id) ?? -1
  }
}
