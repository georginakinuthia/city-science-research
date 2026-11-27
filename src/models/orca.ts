// ORCA (Optimal Reciprocal Collision Avoidance) solver + Spatial Hash Grid
// Based on van den Berg et al., "Reciprocal n-body Collision Avoidance" (2011)
//
// ALLOCATION NOTES:
// This module is on the per-tick hot path and must not allocate during the
// step loop. All per-call scratch state (half-plane lists, neighbor query
// result buffers, candidate lists) is kept as module-level or instance-level
// typed arrays that are reused across calls. `solveORCA` writes its result
// into an out-parameter rather than returning a fresh object.

const EPSILON = 1e-6

// --- Interfaces ---

export interface OrcaAgent {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  maxSpeed: number
}

export interface OrcaParams {
  timeHorizon: number // seconds — how far ahead to avoid collisions
  agentRadius: number // meters — collision radius per agent
  maxNeighbors: number // max neighbors to consider
  neighborDist: number // search radius in meters
  headOnBias: number // m/s — "pass on the right" nudge for near-head-on encounters
}

export interface OrcaResult {
  vx: number
  vy: number
}

// --- Spatial Hash Grid ---

/**
 * Spatial hash grid for ORCA neighbor queries.
 *
 * **Allocation-free on the hot path.** Three reuse strategies:
 *
 *   1. `insert(...)` takes positional args and draws `OrcaAgent` records
 *      from a pool. `clear()` resets the pool index without freeing entries.
 *
 *   2. `queryNearest(...)` returns the SAME `OrcaAgent[]` instance every
 *      call — the internal `_queryResult` buffer. Callers MUST consume the
 *      result before the next `queryNearest` call on the same grid.
 *
 *   3. The internal candidate list (unsorted agents within radius) and
 *      their squared distances live in paired `_candAgents` / `_candDistSq`
 *      buffers that grow geometrically and never shrink.
 */
export class SpatialHashGrid {
  private cellSize: number
  private invCellSize: number
  private buckets: Map<number, OrcaAgent[]>
  private bucketPool: OrcaAgent[][] = []
  private pool: OrcaAgent[] = []
  private poolUsed: number = 0

  // --- Reusable query buffers (hot path) ---
  /** Caller-visible result of `queryNearest`. Reused across calls. */
  private _queryResult: OrcaAgent[] = []
  /** Candidate list — agents within the query radius, unsorted. */
  private _candAgents: OrcaAgent[] = []
  /** Squared distances to each candidate, parallel to `_candAgents`. */
  private _candDistSq: Float64Array = new Float64Array(32)
  private _candCount: number = 0

  constructor(cellSize: number) {
    this.cellSize = cellSize
    this.invCellSize = 1 / cellSize
    this.buckets = new Map()
  }

  clear(): void {
    for (const bucket of this.buckets.values()) {
      bucket.length = 0
      this.bucketPool.push(bucket)
    }
    this.buckets.clear()
    // Reset pool index but keep the records allocated for reuse
    this.poolUsed = 0
  }

  private hash(cx: number, cy: number): number {
    // Shift to positive domain to avoid negative key issues
    const a = (cx + 32768) | 0
    const b = (cy + 32768) | 0
    return a * 65536 + b
  }

  /**
   * Insert an agent into the grid using positional arguments (no object
   * allocation on the hot path).
   */
  insert(
    id: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    radius: number,
    maxSpeed: number,
  ): void {
    // Get or create a pool record
    let agent: OrcaAgent
    if (this.poolUsed < this.pool.length) {
      agent = this.pool[this.poolUsed]!
      agent.id = id
      agent.x = x
      agent.y = y
      agent.vx = vx
      agent.vy = vy
      agent.radius = radius
      agent.maxSpeed = maxSpeed
    } else {
      agent = { id, x, y, vx, vy, radius, maxSpeed }
      this.pool.push(agent)
    }
    this.poolUsed++

    const cx = Math.floor(x * this.invCellSize)
    const cy = Math.floor(y * this.invCellSize)
    const key = this.hash(cx, cy)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = this.bucketPool.pop() ?? []
      this.buckets.set(key, bucket)
    }
    bucket.push(agent)
  }

  /**
   * Grow the candidate parallel arrays if needed. Both grow together so
   * their indices stay in sync.
   */
  private ensureCandCapacity(needed: number): void {
    if (needed <= this._candDistSq.length) return
    let cap = this._candDistSq.length
    while (cap < needed) cap *= 2
    const next = new Float64Array(cap)
    next.set(this._candDistSq)
    this._candDistSq = next
  }

  /**
   * Return the top-k nearest agents (excluding `excludeId`) within `radius`.
   *
   * Returns the instance's reusable `_queryResult` buffer. The buffer's
   * length field indicates how many entries are valid — callers MUST use
   * `result.length`, not assume a fixed capacity. The same buffer is
   * overwritten on the next call to this method.
   */
  queryNearest(
    qx: number,
    qy: number,
    radius: number,
    excludeId: number,
    maxResults: number,
  ): OrcaAgent[] {
    const r2 = radius * radius
    const minCx = Math.floor((qx - radius) * this.invCellSize)
    const maxCx = Math.floor((qx + radius) * this.invCellSize)
    const minCy = Math.floor((qy - radius) * this.invCellSize)
    const maxCy = Math.floor((qy + radius) * this.invCellSize)

    const candAgents = this._candAgents
    candAgents.length = 0
    this._candCount = 0

    // Collect raw candidates into the parallel buffers
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.buckets.get(this.hash(cx, cy))
        if (!bucket) continue
        for (let i = 0; i < bucket.length; i++) {
          const a = bucket[i]!
          if (a.id === excludeId) continue
          const dx = a.x - qx
          const dy = a.y - qy
          const d2 = dx * dx + dy * dy
          if (d2 < r2) {
            this.ensureCandCapacity(this._candCount + 1)
            candAgents.push(a)
            this._candDistSq[this._candCount] = d2
            this._candCount++
          }
        }
      }
    }

    // Partial selection sort for top-k. For small k (ORCA maxNeighbors ≈ 6)
    // this is O(n·k) ≈ O(20·6) = 120 comparisons — cheaper than full sort
    // and avoids allocating comparator closures or temporary pair objects.
    const n = this._candCount
    const candDistSq = this._candDistSq
    const k = Math.min(maxResults, n)
    for (let i = 0; i < k; i++) {
      let minIdx = i
      let minD = candDistSq[i]!
      for (let j = i + 1; j < n; j++) {
        const d = candDistSq[j]!
        if (d < minD) {
          minIdx = j
          minD = d
        }
      }
      if (minIdx !== i) {
        const tmpAgent = candAgents[i]!
        candAgents[i] = candAgents[minIdx]!
        candAgents[minIdx] = tmpAgent
        const tmpD = candDistSq[i]!
        candDistSq[i] = candDistSq[minIdx]!
        candDistSq[minIdx] = tmpD
      }
    }

    // Populate the reusable result buffer — truncate to k, reuse entries.
    const result = this._queryResult
    result.length = k
    for (let i = 0; i < k; i++) result[i] = candAgents[i]!
    return result
  }
}

// --- ORCA Solver (allocation-free) ---
//
// Half-planes are stored as a flat `Float64Array` with 4 slots per plane:
// [pointX, pointY, normalX, normalY]. The active count is tracked in
// `planeCount`. A single module-level buffer is reused across all solveORCA
// calls — since solveORCA is called synchronously and never re-entrant.

const MAX_HALF_PLANES = 32 // plenty of slack above ORCA.maxNeighbors
const _hpPointX = new Float64Array(MAX_HALF_PLANES)
const _hpPointY = new Float64Array(MAX_HALF_PLANES)
const _hpNormalX = new Float64Array(MAX_HALF_PLANES)
const _hpNormalY = new Float64Array(MAX_HALF_PLANES)

/**
 * Solve the ORCA LP for one agent. Writes the resulting velocity into `out`.
 *
 * No allocations on the hot path: half-planes live in module-level
 * `Float64Array`s, and the result is written through the `out` parameter.
 */
export function solveORCA(
  agent: OrcaAgent,
  neighbors: OrcaAgent[],
  prefVx: number,
  prefVy: number,
  params: OrcaParams,
  dt: number,
  out: OrcaResult,
): void {
  let planeCount = 0
  const invTimeHorizon = 1 / params.timeHorizon
  const neighborCount = neighbors.length

  for (let i = 0; i < neighborCount; i++) {
    const other = neighbors[i]!
    const relPosX = other.x - agent.x
    const relPosY = other.y - agent.y
    const relVelX = agent.vx - other.vx
    const relVelY = agent.vy - other.vy

    const combinedRadius = agent.radius + other.radius
    const distSq = relPosX * relPosX + relPosY * relPosY
    const combinedRadiusSq = combinedRadius * combinedRadius

    let uX: number, uY: number
    let normalX: number, normalY: number

    if (distSq > combinedRadiusSq) {
      // No overlap — truncated velocity obstacle cone
      const wX = relVelX - invTimeHorizon * relPosX
      const wY = relVelY - invTimeHorizon * relPosY
      const wLenSq = wX * wX + wY * wY
      const dotProduct1 = wX * relPosX + wY * relPosY

      if (
        dotProduct1 < 0 &&
        dotProduct1 * dotProduct1 > combinedRadiusSq * wLenSq
      ) {
        // Project onto cut-off circle
        const wLen = Math.sqrt(wLenSq)
        if (wLen < EPSILON) {
          // w ≈ 0: relative velocity lands at center of cut-off disc.
          // Use perpendicular to line-of-centers to break symmetry.
          const dist = Math.sqrt(distSq)
          normalX = -relPosY / dist
          normalY = relPosX / dist
          uX = combinedRadius * invTimeHorizon * normalX
          uY = combinedRadius * invTimeHorizon * normalY
          if (planeCount < MAX_HALF_PLANES) {
            _hpPointX[planeCount] = agent.vx + 0.5 * uX
            _hpPointY[planeCount] = agent.vy + 0.5 * uY
            _hpNormalX[planeCount] = normalX
            _hpNormalY[planeCount] = normalY
            planeCount++
          }
          continue
        }
        const invWLen = 1 / wLen
        normalX = wX * invWLen
        normalY = wY * invWLen
        uX = (combinedRadius * invTimeHorizon - wLen) * normalX
        uY = (combinedRadius * invTimeHorizon - wLen) * normalY
      } else {
        // Project onto cone leg
        const leg = Math.sqrt(Math.max(0, distSq - combinedRadiusSq))
        const invDistSq = 1 / distSq
        const cross = relPosX * relVelY - relPosY * relVelX

        if (cross >= 0) {
          // Left leg
          normalX = (relPosX * leg - relPosY * combinedRadius) * invDistSq
          normalY = (relPosX * combinedRadius + relPosY * leg) * invDistSq
        } else {
          // Right leg
          normalX = (relPosX * leg + relPosY * combinedRadius) * invDistSq
          normalY = (-relPosX * combinedRadius + relPosY * leg) * invDistSq
        }

        const dotProduct2 = relVelX * normalX + relVelY * normalY
        uX = dotProduct2 * normalX - relVelX
        uY = dotProduct2 * normalY - relVelY

        // Head-on symmetry breaking: when relative velocity lies near the
        // VO cone boundary (cross ≈ 0), u is nearly tangent and the
        // half-plane barely constrains the preferred velocity.
        //
        // Fix: always use the RIGHT leg for near-head-on encounters.
        // The right leg consistently produces rightward deflection
        // relative to the agent's heading ("pass on the right").
        // Without this, the leg choice depends on the cross product
        // sign which flips unpredictably for near-head-on encounters,
        // causing tick-by-tick jitter.
        //
        // We recompute both the normal and u using the right-leg
        // formula, then shift the half-plane point along the normal
        // to guarantee the constraint is binding (forces the LP to
        // produce a meaningful deflection).
        //
        // Threshold: |cross| < sin(half-angle) × |relVel|, where
        // sin(half-angle) = combinedRadius / dist. This fires for all
        // encounters within the VO cone's angular width of head-on.
        //
        // Guard: only apply when agents are actually moving toward each
        // other (opposing velocities). When dot(v_agent, v_other) > 0
        // the agents travel in roughly the same direction — one is
        // trailing the other — and the bias would cause unnatural
        // lateral jumps.
        const velDot = agent.vx * other.vx + agent.vy * other.vy
        const isOpposing = velDot < 0
        const relVelLen = Math.sqrt(relVelX * relVelX + relVelY * relVelY)
        const coneThreshold = combinedRadius * relVelLen
        if (isOpposing && Math.abs(cross) < coneThreshold) {
          const HEAD_ON_BIAS = params.headOnBias
          // Recompute using right leg (regardless of original cross sign)
          const rNormX = (relPosX * leg + relPosY * combinedRadius) * invDistSq
          const rNormY = (-relPosX * combinedRadius + relPosY * leg) * invDistSq
          const rDot2 = relVelX * rNormX + relVelY * rNormY
          const rUX = rDot2 * rNormX - relVelX
          const rUY = rDot2 * rNormY - relVelY
          if (planeCount < MAX_HALF_PLANES) {
            _hpPointX[planeCount] = agent.vx + 0.5 * rUX + rNormX * HEAD_ON_BIAS
            _hpPointY[planeCount] = agent.vy + 0.5 * rUY + rNormY * HEAD_ON_BIAS
            _hpNormalX[planeCount] = rNormX
            _hpNormalY[planeCount] = rNormY
            planeCount++
          }
          continue
        }
      }
    } else {
      // Already overlapping — use dt-based escape
      const invDt = 1 / dt
      const wX = relVelX - invDt * relPosX
      const wY = relVelY - invDt * relPosY
      const wLen = Math.sqrt(wX * wX + wY * wY)
      if (wLen < EPSILON) continue
      const invWLen = 1 / wLen
      normalX = wX * invWLen
      normalY = wY * invWLen
      uX = (combinedRadius * invDt - wLen) * normalX
      uY = (combinedRadius * invDt - wLen) * normalY
    }

    // Each agent takes half the avoidance responsibility (reciprocity)
    if (planeCount < MAX_HALF_PLANES) {
      _hpPointX[planeCount] = agent.vx + 0.5 * uX
      _hpPointY[planeCount] = agent.vy + 0.5 * uY
      _hpNormalX[planeCount] = normalX
      _hpNormalY[planeCount] = normalY
      planeCount++
    }
  }

  linearProgram2D(planeCount, agent.maxSpeed, prefVx, prefVy, out)
}

// --- 2D Incremental Linear Program ---
//
// Reads half-planes from the module-level `_hpPointX/Y/_hpNormalX/Y` arrays
// populated by `solveORCA` above. Writes the result into `out`.

function linearProgram2D(
  planeCount: number,
  maxSpeed: number,
  prefVx: number,
  prefVy: number,
  out: OrcaResult,
): void {
  let resultX = prefVx
  let resultY = prefVy

  // Clamp preferred velocity to maxSpeed disc
  const prefSpeedSq = prefVx * prefVx + prefVy * prefVy
  if (prefSpeedSq > maxSpeed * maxSpeed) {
    const scale = maxSpeed / Math.sqrt(prefSpeedSq)
    resultX = prefVx * scale
    resultY = prefVy * scale
  }

  for (let i = 0; i < planeCount; i++) {
    const hpPx = _hpPointX[i]!
    const hpPy = _hpPointY[i]!
    const hpNx = _hpNormalX[i]!
    const hpNy = _hpNormalY[i]!

    // Check if current result satisfies this half-plane
    const dx = resultX - hpPx
    const dy = resultY - hpPy
    if (dx * hpNx + dy * hpNy >= 0) continue

    // Boundary line direction (perpendicular to normal)
    const lineDirX = -hpNy
    const lineDirY = hpNx

    // Intersect boundary line with maxSpeed disc
    // Line: P(t) = hp.point + t * lineDir
    // |P(t)|² = maxSpeed²
    const dotLinePoint = hpPx * lineDirX + hpPy * lineDirY
    const pointLenSq = hpPx * hpPx + hpPy * hpPy
    const discriminant = maxSpeed * maxSpeed - pointLenSq + dotLinePoint * dotLinePoint

    if (discriminant < 0) {
      // Line does not intersect speed disc — infeasible, use fallback
      linearProgram3(planeCount, i, maxSpeed, prefVx, prefVy, out)
      return
    }

    const sqrtDisc = Math.sqrt(discriminant)
    let tLeft = -dotLinePoint - sqrtDisc
    let tRight = -dotLinePoint + sqrtDisc

    // Clip against all previous half-planes
    let infeasible = false
    for (let j = 0; j < i; j++) {
      const hpjPx = _hpPointX[j]!
      const hpjPy = _hpPointY[j]!
      const hpjNx = _hpNormalX[j]!
      const hpjNy = _hpNormalY[j]!
      const denom = lineDirX * hpjNx + lineDirY * hpjNy
      const num = (hpjPx - hpPx) * hpjNx + (hpjPy - hpPy) * hpjNy

      if (Math.abs(denom) < EPSILON) {
        // Parallel lines
        if (num < 0) { infeasible = true; break }
        continue
      }

      const t = num / denom
      if (denom > 0) {
        if (t < tRight) tRight = t
      } else {
        if (t > tLeft) tLeft = t
      }

      if (tLeft > tRight) { infeasible = true; break }
    }

    if (infeasible) {
      linearProgram3(planeCount, i, maxSpeed, prefVx, prefVy, out)
      return
    }

    // Project preferred velocity onto feasible segment [tLeft, tRight]
    const tPref = (prefVx - hpPx) * lineDirX + (prefVy - hpPy) * lineDirY
    const tClamped = Math.max(tLeft, Math.min(tRight, tPref))
    resultX = hpPx + tClamped * lineDirX
    resultY = hpPy + tClamped * lineDirY
  }

  out.vx = resultX
  out.vy = resultY
}

// --- Fallback for infeasible constraints ---
// When no velocity satisfies all half-planes, find the velocity that
// minimizes the maximum penetration depth across all constraints.
//
// Standard RVO2 LP3: for each violated plane, solve LP1 on its boundary
// line clipped against all earlier planes and the speed disc.
function linearProgram3(
  planeCount: number,
  beginPlane: number,
  maxSpeed: number,
  prefVx: number,
  prefVy: number,
  out: OrcaResult,
): void {
  let resultX = prefVx
  let resultY = prefVy

  // Clamp to maxSpeed first
  const prefSpeedSq = prefVx * prefVx + prefVy * prefVy
  if (prefSpeedSq > maxSpeed * maxSpeed) {
    const scale = maxSpeed / Math.sqrt(prefSpeedSq)
    resultX = prefVx * scale
    resultY = prefVy * scale
  }

  for (let i = beginPlane; i < planeCount; i++) {
    const hpPx = _hpPointX[i]!
    const hpPy = _hpPointY[i]!
    const hpNx = _hpNormalX[i]!
    const hpNy = _hpNormalY[i]!

    // Check if current result satisfies this plane
    const dx = resultX - hpPx
    const dy = resultY - hpPy
    if (dx * hpNx + dy * hpNy >= 0) continue

    // Violated: find the best point on this plane's boundary line
    // that satisfies all planes 0..i-1 and lies within the speed disc.
    const lineDirX = -hpNy
    const lineDirY = hpNx

    // Intersect boundary line with speed disc
    const dotLP = hpPx * lineDirX + hpPy * lineDirY
    const pointLenSq = hpPx * hpPx + hpPy * hpPy
    const disc = maxSpeed * maxSpeed - pointLenSq + dotLP * dotLP

    if (disc < 0) continue // line outside speed disc — skip

    const sqrtDisc = Math.sqrt(disc)
    let tLeft = -dotLP - sqrtDisc
    let tRight = -dotLP + sqrtDisc

    // Clip against all earlier planes (0 .. i-1)
    let feasible = true
    for (let j = 0; j < i; j++) {
      const hpjPx = _hpPointX[j]!
      const hpjPy = _hpPointY[j]!
      const hpjNx = _hpNormalX[j]!
      const hpjNy = _hpNormalY[j]!
      const denom = lineDirX * hpjNx + lineDirY * hpjNy
      const num = (hpjPx - hpPx) * hpjNx + (hpjPy - hpPy) * hpjNy

      if (Math.abs(denom) < EPSILON) {
        if (num < 0) { feasible = false; break }
        continue
      }

      const t = num / denom
      if (denom > 0) {
        if (t < tRight) tRight = t
      } else {
        if (t > tLeft) tLeft = t
      }

      if (tLeft > tRight) { feasible = false; break }
    }

    if (!feasible) continue

    // Project preferred velocity onto the feasible segment [tLeft, tRight]
    const tPref = (prefVx - hpPx) * lineDirX + (prefVy - hpPy) * lineDirY
    const tClamped = Math.max(tLeft, Math.min(tRight, tPref))
    resultX = hpPx + tClamped * lineDirX
    resultY = hpPy + tClamped * lineDirY
  }

  out.vx = resultX
  out.vy = resultY
}
