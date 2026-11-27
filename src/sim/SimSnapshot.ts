/**
 * SimSnapshot — a point-in-time view of render-critical pedestrian state.
 *
 * Produced by the worker after each tick batch and consumed by the main-
 * thread renderer. The fields are all transferable typed arrays with
 * fixed capacity; `pedCount` tells the renderer how many entries are live.
 *
 * The renderer uses this as a stand-in for the live `Simulation` when
 * reading per-agent fields. All render code that previously read from
 * `sim.pedX[i]`, `sim.pedEngagementMode[i]`, etc., now reads from the
 * snapshot's matching fields.
 */

export interface SimSnapshot {
  /** Number of live agents (0 ≤ pedCount ≤ capacity). */
  pedCount: number
  /** Slot capacity for the typed arrays. pedCount ≤ capacity. */
  capacity: number

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

/**
 * Allocate a fresh snapshot with all typed arrays sized to `capacity`.
 * Used by the worker to produce new buffers and by the main thread as an
 * initial empty state before the first real snapshot arrives.
 */
export function createEmptySnapshot(capacity: number): SimSnapshot {
  return {
    pedCount: 0,
    capacity,
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
