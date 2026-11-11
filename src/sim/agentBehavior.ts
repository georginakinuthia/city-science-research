/**
 * Agent behavior — pure functions.
 *
 * Moved out of the Pinia store (`src/stores/behavior.ts`) so the same logic
 * can run in a Web Worker context without any Vue/Pinia dependencies.
 *
 * **State model**: module-scoped `_p: BehaviorParams` holds the live
 * parameter snapshot. Callers update it via `setBehaviorParams(params)`.
 * On the main thread, the Pinia adapter in `src/stores/behavior.ts` wires
 * reactive slider changes into this call. On the worker thread, incoming
 * `UPDATE_PARAMS` messages call it.
 *
 * **Concurrency**: the main thread and worker each have their own module
 * instance (separate JS realms), so their `_p` values are independent.
 *
 * The per-agent functions (`initialiseAgent`, `advanceAgent`,
 * `recomputeAgentParams`) are exported directly for `Simulation` to call.
 */

import {
  DEFAULTS,
  ENGAGEMENT,
  FOLLOWING,
  GEOMETRY,
  MOMENTUM,
  ORCA as ORCA_CONFIG,
  PROXIMITY_ZONES,
  ROUTE_CHOICE,
  SPEED,
  SURFACE,
  TIMING,
  WEIDMANN,
} from '../config'
import { type OrcaAgent, type OrcaParams, solveORCA } from '../models/orca'

import {
  type AdvanceResult,
  DEG_TO_RAD,
  ENGAGEMENT_OFF,
  ENGAGEMENT_SHOPPING,
  ENGAGEMENT_WAITING,
  RAD_TO_DEG,
  type Simulation,
  type SpawnNode,
} from './Simulation'

// ─────────────────────────────────────────────────────────────
// BehaviorParams — the plain-object snapshot of all tunables
// ─────────────────────────────────────────────────────────────

export interface BehaviorParams {
  // User-facing (UI sliders)
  behaviorDiversity: number
  personalSpace: number
  speedBase: number
  shoppingProbability: number
  spareTimeProbability: number

  // Global / one-time
  isSunny: boolean
  arrivalRadius: number
  nearTargetRadius: number
  baseDeltaTime: number

  // Debug toggles
  debugOrcaEnabled: boolean
  debugDensityEnabled: boolean
  debugMomentumEnabled: boolean
  debugDensityBeta: number
  debugMomentumBase: number
  debugFollowingStrength: number
}

/**
 * Default params — used as the initial snapshot before any UI has had a
 * chance to push updated values. Matches the reactive refs in the Pinia
 * adapter at their construction-time defaults.
 */
export function createDefaultBehaviorParams(): BehaviorParams {
  return {
    behaviorDiversity: DEFAULTS.behaviorDiversity,
    personalSpace: DEFAULTS.personalSpace,
    speedBase: DEFAULTS.speedBase,
    shoppingProbability: DEFAULTS.shoppingProbability,
    spareTimeProbability: DEFAULTS.spareTimeProbability,
    isSunny: false,
    arrivalRadius: GEOMETRY.arrivalRadius,
    nearTargetRadius: GEOMETRY.nearTargetRadius,
    baseDeltaTime: TIMING.baseDeltaTime,
    debugOrcaEnabled: true,
    debugDensityEnabled: true,
    debugMomentumEnabled: true,
    debugDensityBeta: ROUTE_CHOICE.beta.density,
    debugMomentumBase: MOMENTUM.base,
    debugFollowingStrength: FOLLOWING.blendStrength,
  }
}

/** Module-scoped live params. */
let _p: BehaviorParams = createDefaultBehaviorParams()

/**
 * Install a new params snapshot. Cheap — just reassigns the reference.
 * Callers are expected to pass a **plain** object (no reactive wrappers).
 */
export function setBehaviorParams(p: BehaviorParams): void {
  _p = p
}

/** Current params snapshot. Mostly for debug / diagnostic. */
export function getBehaviorParams(): BehaviorParams {
  return _p
}

/** Convenience — used by `Simulation.rebuildSpatialHash`. */
export function getMinAgentSpacing(): number {
  return _p.personalSpace
}

/** Convenience — used by `Simulation.advanceAgents`. */
export function getBaseDeltaTime(): number {
  return _p.baseDeltaTime
}

// ─────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────

const EPSILON = 1e-6
const TAU = Math.PI * 2

const FNV_OFFSET = 2166136261 >>> 0
const FNV_PRIME = 16777619

function fnv1aHash2(a: number, b: number): number {
  let hash = FNV_OFFSET
  hash ^= a >>> 0
  hash = Math.imul(hash, FNV_PRIME)
  hash ^= b >>> 0
  hash = Math.imul(hash, FNV_PRIME)
  return hash >>> 0
}

function fnv1aHash3(a: number, b: number, c: number): number {
  let hash = FNV_OFFSET
  hash ^= a >>> 0
  hash = Math.imul(hash, FNV_PRIME)
  hash ^= b >>> 0
  hash = Math.imul(hash, FNV_PRIME)
  hash ^= c >>> 0
  hash = Math.imul(hash, FNV_PRIME)
  return hash >>> 0
}

/** Normalise a degree value to (-180, 180]. */
function normalizeDeg(d: number): number {
  const mod = (((d + 180) % 360) + 360) % 360
  return mod - 180
}

/** Convert compass degrees to math radians (0° = north, 90° = east → 0 rad = east, ccw). */
function compassDegToRad(deg: number): number {
  return (90 - deg) * DEG_TO_RAD
}

/** Convert math radians back to compass degrees, normalised to (-180, 180]. */
function radToCompassDeg(rad: number): number {
  return normalizeDeg(90 - rad * RAD_TO_DEG)
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

function agentRandom(id: number, salt: number): number {
  return fnv1aHash2(id, salt) / 0xffffffff
}

function agentSignedRandom(id: number, salt: number): number {
  return agentRandom(id, salt) * 2 - 1
}

const _densityOut = { oncoming: 0, areal: 0 }

function weidmannSpeedFactor(density: number): number {
  if (density <= 0) return 1
  if (density >= WEIDMANN.rhoMax) return 0
  return 1 - Math.exp(-WEIDMANN.gamma * (1 / density - 1 / WEIDMANN.rhoMax))
}

// ─────────────────────────────────────────────────────────────
// HeadingState and reusable scratch
// ─────────────────────────────────────────────────────────────

type HeadingState = {
  heading: number
  speed: number
  shopMinutes: number
  waitMinutes: number
}

const _headingState: HeadingState = { heading: 0, speed: 0, shopMinutes: 0, waitMinutes: 0 }

// ─────────────────────────────────────────────────────────────
// Density / perception helpers
// ─────────────────────────────────────────────────────────────

function getLocalDensityAt(
  sim: Simulation,
  patchX: number,
  patchY: number,
  radius: number,
): number {
  const density = sim.density
  const width = sim.width
  const height = sim.height
  let count = 0
  let cells = 0
  for (let dy = -radius; dy <= radius; dy++) {
    const ny = patchY + dy
    if (ny < 0 || ny >= height) continue
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = patchX + dx
      if (nx < 0 || nx >= width) continue
      const ni = ny * width + nx
      count += density[ni]!
      cells++
    }
  }
  return cells > 0 ? count / cells : 0
}

function getLocalDensity(sim: Simulation, i: number): number {
  const cellIdx = sim.pedCellIdx[i]!
  if (cellIdx < 0) return 0
  const width = sim.width
  const px = cellIdx % width
  const py = (cellIdx / width) | 0
  return getLocalDensityAt(sim, px, py, WEIDMANN.densityRadius)
}

function getDirectionalDensity(
  sim: Simulation,
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  lookahead: number,
): typeof _densityOut {
  _densityOut.oncoming = 0
  _densityOut.areal = 0
  const density = sim.density
  const hdx = sim.cellHeadingDx
  const hdy = sim.cellHeadingDy
  const width = sim.width
  const height = sim.height
  const len = density.length
  const perpX = -dirY
  const perpY = dirX
  let oncoming = 0
  let cells = 0
  for (let i = 1; i <= lookahead; i++) {
    const cx = fromX + dirX * i
    const cy = fromY + dirY * i
    for (let s = -1; s <= 1; s++) {
      const px = Math.round(cx + perpX * s)
      const py = Math.round(cy + perpY * s)
      if (px < 0 || px >= width || py < 0 || py >= height) continue
      const idx = py * width + px
      if (idx < 0 || idx >= len) continue
      cells++
      const count = density[idx]!
      if (count === 0) continue
      const rawDot = -(hdx[idx]! * dirX + hdy[idx]! * dirY)
      const perAgent = rawDot / count
      oncoming += count * Math.max(ROUTE_CHOICE.coDirectionalFloor, perAgent)
    }
  }
  _densityOut.oncoming = oncoming
  _densityOut.areal = cells > 0 ? oncoming / cells : 0
  return _densityOut
}

function getShadeLookahead(
  sim: Simulation,
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  lookahead: number,
): number {
  const shade = sim.shadePotential
  const width = sim.width
  const height = sim.height
  const len = shade.length
  let best = -Infinity
  for (let i = 1; i <= lookahead; i++) {
    const px = Math.round(fromX + dirX * i)
    const py = Math.round(fromY + dirY * i)
    if (px < 0 || px >= width || py < 0 || py >= height) continue
    const idx = py * width + px
    if (idx < 0 || idx >= len) continue
    const val = shade[idx]!
    if (val > best) best = val
  }
  return best === -Infinity ? 0 : best
}

function getEffectiveMomentum(sim: Simulation, i: number): number {
  if (!_p.debugMomentumEnabled) return 0
  const globalMom = _p.debugMomentumBase
  const agentOffset = (sim.pedMomentumPreference[i]! - 0.5) * _p.behaviorDiversity
  return clamp01(globalMom + agentOffset)
}

function getEffectiveStraightness(sim: Simulation, i: number): number {
  return clamp01(sim.pedRouteStraightness[i]!)
}

// ─────────────────────────────────────────────────────────────
// MNL route choice — scratch buffers sized for 8 Moore neighbors
// ─────────────────────────────────────────────────────────────

const MAX_CANDIDATES = 8
const candNdx = new Float64Array(MAX_CANDIDATES)
const candNdy = new Float64Array(MAX_CANDIDATES)
const candDistGain = new Float64Array(MAX_CANDIDATES)
const candAlignment = new Float64Array(MAX_CANDIDATES)
const candDensity = new Float64Array(MAX_CANDIDATES)
const candAreal = new Float64Array(MAX_CANDIDATES)
const candObstacle = new Float64Array(MAX_CANDIDATES)
const candShade = new Float64Array(MAX_CANDIDATES)
const candJitterHash = new Int32Array(MAX_CANDIDATES)
const candUtilities = new Float64Array(MAX_CANDIDATES)

function getTargetHeading(sim: Simulation, i: number, _stepDt: number = _p.baseDeltaTime): number {
  const cellIdx = sim.pedCellIdx[i]!
  if (cellIdx < 0) return sim.pedHeading[i]!

  const stallPotential = sim.stallPotential
  const neighborTable = sim.walkableNeighborTable
  const width = sim.width

  const nodeIdx = sim.pedTargetNodeIdx[i]!
  const nodeField = nodeIdx >= 0 ? sim.nodeDistanceFields[nodeIdx] : undefined
  const tx = sim.pedX[i]!
  const ty = sim.pedY[i]!

  let headVecDx: number
  let headVecDy: number
  const mnlHeading = sim.pedMnlHeading[i]!
  if (!Number.isNaN(mnlHeading)) {
    const rad = compassDegToRad(mnlHeading)
    headVecDx = Math.cos(rad)
    headVecDy = -Math.sin(rad)
  } else {
    headVecDx = sim.pedHeadingDx[i]!
    headVecDy = sim.pedHeadingDy[i]!
  }

  const tDist = nodeField ? (nodeField[cellIdx] ?? Infinity) : Infinity
  const { densityLookahead, shadeLookahead } = ROUTE_CHOICE

  const shadeActive = _p.isSunny && getLocalDensity(sim, i) < SURFACE.shadeDensityGate

  let candCount = 0
  let maxDistGain = -Infinity
  let maxDensity = 0
  const agentId = sim.pedId[i]!

  const neighborBase = cellIdx * 9
  const neighborCount = neighborTable[neighborBase]!
  for (let k = 1; k <= neighborCount; k++) {
    const nIdx = neighborTable[neighborBase + k]!

    const nDist = nodeField ? (nodeField[nIdx] ?? Infinity) : Infinity
    const distGain = tDist - nDist
    if (distGain < 0) continue

    const nx = nIdx % width
    const ny = (nIdx / width) | 0
    const dx = nx - tx
    const dy = ny - ty
    const dist = Math.hypot(dx, dy)
    if (dist <= EPSILON) continue
    const ndx = dx / dist
    const ndy = dy / dist

    const alignment = ndx * headVecDx + ndy * headVecDy
    const densityResult = getDirectionalDensity(sim, tx, ty, ndx, ndy, densityLookahead)
    const density = densityResult.oncoming
    const areal = densityResult.areal
    const rawStall = stallPotential[nIdx] ?? -1
    const obstacle = (rawStall + 1) / 2
    const shade = shadeActive ? getShadeLookahead(sim, tx, ty, ndx, ndy, shadeLookahead) : 0

    if (distGain > maxDistGain) maxDistGain = distGain
    if (density > maxDensity) maxDensity = density

    candNdx[candCount] = ndx
    candNdy[candCount] = ndy
    candDistGain[candCount] = distGain
    candAlignment[candCount] = alignment
    candDensity[candCount] = density
    candAreal[candCount] = areal
    candObstacle[candCount] = obstacle
    candShade[candCount] = shade
    candJitterHash[candCount] =
      fnv1aHash3(agentId, Math.round(nx * 1000) >>> 0, Math.round(ny * 1000) >>> 0) | 0
    candCount++
  }

  if (candCount > 0) {
    const { beta, temperature, jitterScale } = ROUTE_CHOICE
    const straightness = getEffectiveStraightness(sim, i)
    const distNorm = maxDistGain > EPSILON ? 1 / maxDistGain : 1
    const densityNorm = maxDensity > EPSILON ? 1 / maxDensity : 0

    const biasDx = sim.pedRouteBiasDx[i]!
    const biasDy = sim.pedRouteBiasDy[i]!
    const biasWeight = sim.pedRouteBiasWeight[i]!

    let maxU = -Infinity
    const effectiveDensityBeta = _p.debugDensityEnabled ? _p.debugDensityBeta : 0
    for (let k = 0; k < candCount; k++) {
      const vDist = candDistGain[k]! * distNorm
      const vDensity = candDensity[k]! * densityNorm
      const biasDot = candNdx[k]! * biasDx + candNdy[k]! * biasDy
      const jitter = ((candJitterHash[k]! >>> 0) & 0xffff) / 0xffff

      const V =
        beta.distance * vDist +
        beta.alignment * candAlignment[k]! * straightness +
        effectiveDensityBeta * vDensity +
        beta.obstacle * candObstacle[k]! +
        beta.shade * candShade[k]! +
        biasWeight * biasDot +
        jitter * jitterScale

      candUtilities[k] = V
      if (V > maxU) maxU = V
    }

    let totalWeight = 0
    let blendedX = 0
    let blendedY = 0
    let blendedDensity = 0
    for (let k = 0; k < candCount; k++) {
      const weight = Math.exp((candUtilities[k]! - maxU) / temperature)
      blendedX += candNdx[k]! * weight
      blendedY += candNdy[k]! * weight
      blendedDensity += candAreal[k]! * weight
      totalWeight += weight
    }

    if (totalWeight > 0) {
      blendedX /= totalWeight
      blendedY /= totalWeight
      sim.pedPerceivedDensity[i] = blendedDensity / totalWeight

      const rad = Math.atan2(-blendedY, blendedX)
      return radToCompassDeg(rad)
    }
  }

  const dx = sim.pedTargetX[i]! - tx
  const dy = sim.pedTargetY[i]! - ty
  const rad = Math.atan2(-dy, dx)
  return radToCompassDeg(rad)
}

// ─────────────────────────────────────────────────────────────
// Heading blending
// ─────────────────────────────────────────────────────────────

function blendHeadingWithVector(
  currentHeading: number,
  dirVectorDx: number | null,
  dirVectorDy: number | null,
  weight: number,
): number {
  if (dirVectorDx === null || dirVectorDy === null) return currentHeading
  const w = clamp01(weight)
  const currentRad = compassDegToRad(currentHeading)
  const currentX = Math.cos(currentRad)
  const currentY = -Math.sin(currentRad)
  const blendedX = currentX * (1 - w) + dirVectorDx * w
  const blendedY = currentY * (1 - w) + dirVectorDy * w
  const rad = Math.atan2(-blendedY, blendedX)
  return radToCompassDeg(rad)
}

function blendAngles(a: number, b: number | null, w: number): number {
  if (b === null) return a
  const weight = clamp01(w)
  const aRad = (a * Math.PI) / 180
  const bRad = (b * Math.PI) / 180
  const x = Math.cos(aRad) * (1 - weight) + Math.cos(bRad) * weight
  const y = Math.sin(aRad) * (1 - weight) + Math.sin(bRad) * weight
  const resultRad = Math.atan2(y, x)
  const result = (resultRad * 180) / Math.PI
  return normalizeDeg(result)
}

// ─────────────────────────────────────────────────────────────
// Gradient seek / amenity handling
// ─────────────────────────────────────────────────────────────

const _gradOut: [number, number] = [0, 0]

function seekGradient(
  sim: Simulation,
  i: number,
  fieldArray: Float32Array,
  upHill: boolean,
): [number, number] | null {
  const cellIdx = sim.pedCellIdx[i]!
  if (cellIdx < 0) return null
  const neighborTable = sim.walkableNeighborTable
  const width = sim.width

  let bestPotential = fieldArray[cellIdx] ?? (upHill ? -Infinity : Infinity)
  let bestDx = 0
  let bestDy = 0
  let found = false
  const tx = sim.pedX[i]!
  const ty = sim.pedY[i]!

  const base = cellIdx * 9
  const count = neighborTable[base]!
  for (let k = 1; k <= count; k++) {
    const nIdx = neighborTable[base + k]!
    const nPotential = fieldArray[nIdx] ?? (upHill ? -Infinity : Infinity)
    const isBetter = upHill ? nPotential > bestPotential : nPotential < bestPotential
    if (isBetter) {
      bestPotential = nPotential
      const nx = nIdx % width
      const ny = (nIdx / width) | 0
      const dx = nx - tx
      const dy = ny - ty
      const dist = Math.hypot(dx, dy)
      if (dist <= EPSILON) continue
      bestDx = dx / dist
      bestDy = dy / dist
      found = true
    }
  }
  if (!found) return null
  _gradOut[0] = bestDx
  _gradOut[1] = bestDy
  return _gradOut
}

interface AmenityOut {
  hasGradient: boolean
  gradientDx: number
  gradientDy: number
  weight: number
  speedFactor: number
  minutesSpent: number
}
const _furnitureOut: AmenityOut = {
  hasGradient: false,
  gradientDx: 0,
  gradientDy: 0,
  weight: 0,
  speedFactor: 1,
  minutesSpent: 0,
}
const _stallsOut: AmenityOut = {
  hasGradient: false,
  gradientDx: 0,
  gradientDy: 0,
  weight: 0,
  speedFactor: 1,
  minutesSpent: 0,
}

function handleAmenity(
  sim: Simulation,
  i: number,
  potentialField: Float32Array,
  engagedMode: typeof ENGAGEMENT_SHOPPING | typeof ENGAGEMENT_WAITING,
  useShopProb: boolean,
  probability: number,
  maxDuration: number,
  stepDt: number,
  out: AmenityOut,
): void {
  out.hasGradient = false
  out.gradientDx = 0
  out.gradientDy = 0
  out.weight = 0
  out.speedFactor = 1
  out.minutesSpent = 0

  const cellIdx = sim.pedCellIdx[i]!
  const rawPotential = cellIdx >= 0 ? (potentialField[cellIdx] ?? -1) : -1
  const amenityPotential = (rawPotential + 1) / 2

  if (sim.pedEngagementMode[i] === engagedMode) {
    if (sim.pedEngagementDuration[i]! <= 0) {
      sim.pedEngagementMode[i] = ENGAGEMENT_OFF
      if (useShopProb) sim.pedShopProb[i] = 0
      else sim.pedWaitProb[i] = 0
      sim.pedEngagementElapsed[i] = 0
    } else {
      sim.pedEngagementElapsed[i]! += stepDt
      if (sim.pedEngagementElapsed[i]! >= ENGAGEMENT.stuckTimeoutSeconds) {
        sim.pedEngagementMode[i] = ENGAGEMENT_OFF
        if (useShopProb) sim.pedShopProb[i] = 0
        else sim.pedWaitProb[i] = 0
        sim.pedEngagementElapsed[i] = 0
      }
    }
  }

  if (amenityPotential > 0) {
    if (sim.pedEngagementMode[i] === engagedMode) {
      const g = seekGradient(sim, i, potentialField, true)
      if (g !== null) {
        out.hasGradient = true
        out.gradientDx = g[0]
        out.gradientDy = g[1]
      }
      out.weight = ENGAGEMENT.weights.low.heading
      out.speedFactor = ENGAGEMENT.weights.low.speed
      if (amenityPotential > ENGAGEMENT.lowPotentialThreshold) {
        out.weight = ENGAGEMENT.weights.mid.heading
        out.speedFactor = ENGAGEMENT.weights.mid.speed
      }
      if (amenityPotential > ENGAGEMENT.highPotentialThreshold) {
        const timeSpent = stepDt
        sim.pedEngagementDuration[i]! -= timeSpent
        sim.pedEngagementElapsed[i] = 0
        out.weight = ENGAGEMENT.weights.high.heading
        out.speedFactor = ENGAGEMENT.weights.high.speed
        out.minutesSpent = timeSpent / 60
      }
    } else {
      const crowdingThreshold = ENGAGEMENT.crowdingThreshold
      const localDensity = getLocalDensity(sim, i)
      const crowdingDiscount = clamp01(1 - localDensity / crowdingThreshold)
      const effectiveP = clamp01(probability) * crowdingDiscount
      const probPerTick = 1 - Math.pow(1 - effectiveP, stepDt / 60)
      if (Math.random() <= probPerTick) {
        sim.pedEngagementMode[i] = engagedMode
        const durationMinutes = Math.random() * maxDuration
        const durationSimSeconds = durationMinutes * 60
        sim.pedEngagementDuration[i] = durationSimSeconds
        sim.pedEngagementElapsed[i] = 0
      }
    }
  }

  if (!out.hasGradient && amenityPotential > ENGAGEMENT.ambientPullThreshold) {
    const g = seekGradient(sim, i, potentialField, false)
    if (g !== null) {
      out.hasGradient = true
      out.gradientDx = g[0]
      out.gradientDy = g[1]
      out.weight = ENGAGEMENT.weights.ambient.heading
    }
  }
}

function applyAmenityInfluences(
  sim: Simulation,
  i: number,
  state: HeadingState,
  stepDt: number,
): void {
  if (sim.pedNoEngagement[i] === 1) return

  handleAmenity(
    sim,
    i,
    sim.furniturePotential,
    ENGAGEMENT_WAITING,
    false,
    _p.spareTimeProbability,
    ENGAGEMENT.waitMaxMinutes,
    stepDt,
    _furnitureOut,
  )
  if (_furnitureOut.hasGradient) {
    state.heading = blendHeadingWithVector(
      state.heading,
      _furnitureOut.gradientDx,
      _furnitureOut.gradientDy,
      _furnitureOut.weight,
    )
    state.speed = _furnitureOut.speedFactor * sim.pedSpeed[i]!
  }
  state.waitMinutes += _furnitureOut.minutesSpent
  const hasFurniturePull = _furnitureOut.hasGradient

  handleAmenity(
    sim,
    i,
    sim.stallPotential,
    ENGAGEMENT_SHOPPING,
    true,
    _p.shoppingProbability,
    ENGAGEMENT.shopMaxMinutes,
    stepDt,
    _stallsOut,
  )
  if (!hasFurniturePull && _stallsOut.hasGradient) {
    state.heading = blendHeadingWithVector(
      state.heading,
      _stallsOut.gradientDx,
      _stallsOut.gradientDy,
      _stallsOut.weight,
    )
    state.speed = _stallsOut.speedFactor * sim.pedSpeed[i]!
  }
  state.shopMinutes += _stallsOut.minutesSpent
}

// ─────────────────────────────────────────────────────────────
// Path / following / avoidance
// ─────────────────────────────────────────────────────────────

function isPathClear(sim: Simulation, x1: number, y1: number, x2: number, y2: number): boolean {
  const surfacePotential = sim.surfacePotential
  const len = surfacePotential.length
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.sqrt(dx * dx + dy * dy)

  const destIdx = sim.cellAt(x2, y2)
  if (destIdx < 0 || destIdx >= len) return false
  if ((surfacePotential[destIdx] ?? 0) < 0) return false
  if (dist < 0.5) return true

  const steps = Math.max(2, Math.ceil(dist * 2))
  for (let k = 1; k < steps; k++) {
    const frac = k / steps
    const px = Math.round(x1 + dx * frac)
    const py = Math.round(y1 + dy * frac)
    const idx = sim.cellAt(px, py)
    if (idx < 0 || idx >= len) return false
    if ((surfacePotential[idx] ?? 0) < 0) return false
  }
  return true
}

function applyFollowing(sim: Simulation, i: number, state: HeadingState): void {
  if (sim.pedEngagementMode[i] !== ENGAGEMENT_OFF) return
  const hash = sim.spatialHash

  const maxStrength = _p.debugFollowingStrength
  if (maxStrength < EPSILON) return

  const headRad = compassDegToRad(state.heading)
  const fwdX = Math.cos(headRad)
  const fwdY = -Math.sin(headRad)
  const coneThreshold = Math.cos((FOLLOWING.coneHalfAngleDeg * Math.PI) / 180)

  const tx = sim.pedX[i]!
  const ty = sim.pedY[i]!
  const neighbors = hash.queryNearest(
    tx,
    ty,
    FOLLOWING.radius,
    sim.pedId[i]!,
    ORCA_CONFIG.maxNeighbors,
  )

  let oncomingCount = 0
  let bestDist = Infinity
  let bestDx = 0
  let bestDy = 0

  for (let k = 0; k < neighbors.length; k++) {
    const n = neighbors[k]!
    const dx = n.x - tx
    const dy = n.y - ty
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < EPSILON) continue
    const dotPos = (dx * fwdX + dy * fwdY) / dist
    if (dotPos < coneThreshold) continue

    const nSpeed = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
    if (nSpeed < EPSILON) continue
    const dotVel = (n.vx * fwdX + n.vy * fwdY) / nSpeed

    if (dotVel < -0.3) {
      oncomingCount++
    } else if (dotVel > 0.3 && dist < bestDist) {
      if (isPathClear(sim, tx, ty, n.x, n.y)) {
        bestDist = dist
        bestDx = dx
        bestDy = dy
      }
    }
  }

  const crowdFrac = clamp01(
    (oncomingCount - FOLLOWING.crowdingOnset) / (FOLLOWING.crowdingFull - FOLLOWING.crowdingOnset),
  )

  if (crowdFrac > EPSILON) {
    state.speed *= 1 - FOLLOWING.pinchSlowdown * crowdFrac
  }

  if (crowdFrac < EPSILON || bestDist === Infinity) return

  const towardRad = Math.atan2(-bestDy, bestDx)
  const towardDeg = radToCompassDeg(towardRad)
  state.heading = blendAngles(state.heading, towardDeg, maxStrength * crowdFrac)
}

function wouldLeaveWalkable(sim: Simulation, i: number, headingDeg: number, dist: number): boolean {
  const rad = compassDegToRad(headingDeg)
  const dx = Math.cos(rad) * dist
  const dy = -Math.sin(rad) * dist
  const probeX = Math.round(sim.pedX[i]! + dx)
  const probeY = Math.round(sim.pedY[i]! + dy)
  const idx = sim.cellAt(probeX, probeY)
  if (idx < 0) return true
  return (sim.surfacePotential[idx] ?? 0) < 0
}

const _selfOrca: OrcaAgent = {
  id: -1,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  radius: 0,
  maxSpeed: 0,
}
const _orcaParams: OrcaParams = {
  timeHorizon: ORCA_CONFIG.timeHorizonWalking,
  agentRadius: 0,
  maxNeighbors: ORCA_CONFIG.maxNeighbors,
  neighborDist: ORCA_CONFIG.neighborDist,
  headOnBias: 0,
}
const _orcaOut = { vx: 0, vy: 0 }

function evaluateCollisions(
  sim: Simulation,
  i: number,
  prefVx: number,
  prefVy: number,
  stepDt: number,
): boolean {
  if (!_p.debugOrcaEnabled) return false

  const minSpacing = _p.personalSpace
  const isEngaged = sim.pedEngagementMode[i] !== ENGAGEMENT_OFF
  const agentRadius = minSpacing * ORCA_CONFIG.radiusMultiplier

  _orcaParams.timeHorizon = isEngaged
    ? ORCA_CONFIG.timeHorizonEngaged
    : ORCA_CONFIG.timeHorizonWalking
  _orcaParams.agentRadius = agentRadius
  _orcaParams.maxNeighbors = ORCA_CONFIG.maxNeighbors
  _orcaParams.neighborDist = ORCA_CONFIG.neighborDist
  _orcaParams.headOnBias = 0

  const speed = sim.pedCurrentSpeed[i]! || sim.pedSpeed[i]! || 0
  const theta = compassDegToRad(sim.pedHeading[i]!)
  _selfOrca.id = sim.pedId[i]!
  _selfOrca.x = sim.pedX[i]!
  _selfOrca.y = sim.pedY[i]!
  _selfOrca.vx = Math.cos(theta) * speed
  _selfOrca.vy = -Math.sin(theta) * speed
  _selfOrca.radius = agentRadius
  _selfOrca.maxSpeed = sim.pedSpeed[i]!

  const neighbors = sim.spatialHash.queryNearest(
    sim.pedX[i]!,
    sim.pedY[i]!,
    _orcaParams.neighborDist,
    sim.pedId[i]!,
    _orcaParams.maxNeighbors,
  )

  if (neighbors.length === 0) return false

  recordZoneViolations(sim, i, minSpacing, neighbors)

  solveORCA(_selfOrca, neighbors, prefVx, prefVy, _orcaParams, stepDt, _orcaOut)
  return true
}

function recordZoneViolations(
  sim: Simulation,
  i: number,
  minSpacing: number,
  neighbors: OrcaAgent[],
): void {
  const intimateDist = minSpacing * PROXIMITY_ZONES.intimate
  const personalDist = minSpacing * PROXIMITY_ZONES.personal
  const socialDist = minSpacing * PROXIMITY_ZONES.social
  let intimateCount = 0
  let personalCount = 0
  let socialCount = 0

  const tx = sim.pedX[i]!
  const ty = sim.pedY[i]!
  for (let k = 0; k < neighbors.length; k++) {
    const n = neighbors[k]!
    const dist = Math.hypot(n.x - tx, n.y - ty)
    if (dist < intimateDist) intimateCount++
    else if (dist < personalDist) personalCount++
    else if (dist < socialDist) socialCount++
  }
  sim.pedIntimateViolations[i] = intimateCount
  sim.pedPersonalViolations[i] = personalCount
  sim.pedSocialViolations[i] = socialCount
}

function applyAvoidance(sim: Simulation, i: number, state: HeadingState, stepDt: number): void {
  const baseSpeed = state.speed

  const prefRad = compassDegToRad(state.heading)
  const prefVx = Math.cos(prefRad) * state.speed
  const prefVy = -Math.sin(prefRad) * state.speed

  const ran = evaluateCollisions(sim, i, prefVx, prefVy, stepDt)
  if (!ran) {
    sim.pedOrcaDeflection[i] = 0
    return
  }
  const orcaVx = _orcaOut.vx
  const orcaVy = _orcaOut.vy

  const newSpeed = Math.hypot(orcaVx, orcaVy)
  if (newSpeed < EPSILON) {
    state.speed = 0
    sim.pedOrcaDeflection[i] = 180
    return
  }

  const newHeadingRad = Math.atan2(-orcaVy, orcaVx)
  const newHeadingDeg = radToCompassDeg(newHeadingRad)
  const deflection = Math.abs(normalizeDeg(newHeadingDeg - state.heading))
  sim.pedOrcaDeflection[i] = deflection

  const probeDist = 2
  if (wouldLeaveWalkable(sim, i, newHeadingDeg, probeDist)) {
    state.speed = Math.min(baseSpeed * 0.5, newSpeed)
    return
  }

  const deflectionFactor = Math.max(0.2, 1 - deflection / 90)
  const cappedSpeed = Math.min(newSpeed, baseSpeed) * deflectionFactor

  if (sim.pedEngagementMode[i] === ENGAGEMENT_OFF) {
    state.heading = newHeadingDeg
    state.speed = cappedSpeed
  } else {
    const blend = ORCA_CONFIG.engagedBlend
    state.heading = blendAngles(newHeadingDeg, state.heading, 1 - blend)
    state.speed = cappedSpeed * blend + baseSpeed * (1 - blend)
  }
}

function applySurfacePreferences(sim: Simulation, i: number, state: HeadingState): void {
  const cellIdx = sim.pedCellIdx[i]!
  const currentSurfacePotential = cellIdx >= 0 ? (sim.surfacePotential[cellIdx] ?? 0) : 0
  if (currentSurfacePotential < 0) {
    const surfaceGradient = seekGradient(sim, i, sim.surfacePotential, true)
    if (surfaceGradient !== null) {
      state.heading = blendHeadingWithVector(
        state.heading,
        surfaceGradient[0],
        surfaceGradient[1],
        1.0,
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main per-agent pipeline
// ─────────────────────────────────────────────────────────────

function computeSpeedFactor(sim: Simulation, i: number): number {
  const density = sim.pedPerceivedDensity[i]!
  return clamp01(weidmannSpeedFactor(density))
}

function calculateHeading(sim: Simulation, i: number, targetDist: number, stepDt: number): void {
  const state = _headingState
  const cellIdx = sim.pedCellIdx[i]!
  if (cellIdx < 0) {
    state.heading = sim.pedHeading[i]!
    state.speed = 0
    state.shopMinutes = 0
    state.waitMinutes = 0
    return
  }

  const targetHeading = getTargetHeading(sim, i, stepDt)
  state.heading = targetHeading
  state.speed = sim.pedSpeed[i]!
  state.shopMinutes = 0
  state.waitMinutes = 0

  if (targetDist < _p.nearTargetRadius) return

  applyAmenityInfluences(sim, i, state, stepDt)
  applySurfacePreferences(sim, i, state)
  applyFollowing(sim, i, state)

  const baseMomentum = getEffectiveMomentum(sim, i)
  const smoothing = Math.min(baseMomentum, MOMENTUM.cap)
  if (smoothing > 0) {
    const prev = !Number.isNaN(sim.pedMnlHeading[i]!) ? sim.pedMnlHeading[i]! : state.heading
    state.heading = blendAngles(state.heading, prev, smoothing)
  }

  state.speed *= computeSpeedFactor(sim, i)

  applyAvoidance(sim, i, state, stepDt)

  if (wouldLeaveWalkable(sim, i, state.heading, 1)) {
    state.heading = targetHeading
    state.speed *= 0.5
  }

  sim.pedMnlHeading[i] = state.heading
}

/**
 * Advance agent `i` one tick. Writes results into `out` — no allocation.
 * Part of the public API consumed by `Simulation.advanceAgents`.
 */
export function advanceAgent(sim: Simulation, i: number, out: AdvanceResult): void {
  out.hasArrived = false
  out.shopMinutes = 0
  out.waitMinutes = 0
  out.distanceTraveled = 0

  const cellIdx = sim.pedCellIdx[i]!
  if (cellIdx < 0) return

  const stepDt = _p.baseDeltaTime

  const tx = sim.pedX[i]!
  const ty = sim.pedY[i]!
  const targetDist = Math.hypot(sim.pedTargetX[i]! - tx, sim.pedTargetY[i]! - ty)
  if (targetDist <= _p.arrivalRadius) {
    sim.killAgent(i)
    out.hasArrived = true
    return
  }

  calculateHeading(sim, i, targetDist, stepDt)
  const headingRaw = _headingState.heading
  const speedMs = _headingState.speed
  out.shopMinutes = _headingState.shopMinutes
  out.waitMinutes = _headingState.waitMinutes

  const fallbackHeading = Number.isFinite(sim.pedHeading[i]!) ? sim.pedHeading[i]! : 0
  const safeHeading = Number.isFinite(headingRaw) ? headingRaw : fallbackHeading
  const fallbackSpeed = Number.isFinite(sim.pedCurrentSpeed[i]!)
    ? sim.pedCurrentSpeed[i]!
    : Number.isFinite(sim.pedSpeed[i]!)
      ? sim.pedSpeed[i]!
      : 0
  const safeSpeed = Number.isFinite(speedMs) ? speedMs : fallbackSpeed

  sim.setAgentHeading(i, safeHeading)
  sim.pedCurrentSpeed[i] = safeSpeed

  const stepDistance = safeSpeed * stepDt
  if (Number.isFinite(stepDistance) && stepDistance > 0) {
    const prevX = sim.pedX[i]!
    const prevY = sim.pedY[i]!
    sim.advanceAgentForward(i, stepDistance)

    const landedIdx = sim.pedCellIdx[i]!
    const landedPotential = landedIdx >= 0 ? (sim.surfacePotential[landedIdx] ?? 0) : -1
    const pathBlocked =
      landedPotential < 0 || !isPathClear(sim, prevX, prevY, sim.pedX[i]!, sim.pedY[i]!)
    if (pathBlocked) {
      sim.setAgentPosition(i, prevX, prevY)
    } else {
      out.distanceTraveled += stepDistance
    }
  }

  const newTx = sim.pedX[i]!
  const newTy = sim.pedY[i]!
  const remainingDist = Math.hypot(sim.pedTargetX[i]! - newTx, sim.pedTargetY[i]! - newTy)
  if (remainingDist <= _p.arrivalRadius) {
    sim.killAgent(i)
    out.hasArrived = true
  }

  if (!out.hasArrived) {
    const finalIdx = sim.pedCellIdx[i]!
    if (finalIdx >= 0) {
      sim.trails[finalIdx]! += 1
    }
  }
}

/** Initialise a freshly-spawned agent's state. Public API. */
export function initialiseAgent(
  sim: Simulation,
  i: number,
  startNode: SpawnNode,
  destNode: SpawnNode,
  shopProb: number,
  waitProb: number,
): void {
  if (startNode.worldX == null || startNode.worldY == null) {
    console.warn('Start node missing world coordinates:', startNode)
    return
  }
  if (destNode.worldX == null || destNode.worldY == null) {
    console.warn('Destination node missing world coordinates:', destNode)
    return
  }

  const startNodeIdx = sim.internNodeId(String(startNode.id))
  const targetNodeIdx = sim.internNodeId(String(destNode.id))
  sim.pedStartNodeIdx[i] = startNodeIdx
  sim.pedTargetNodeIdx[i] = targetNodeIdx

  sim.setAgentPosition(i, Math.round(startNode.worldX), Math.round(startNode.worldY))
  sim.pedTargetX[i] = Math.round(destNode.worldX)
  sim.pedTargetY[i] = Math.round(destNode.worldY)

  const dispersion = clamp01(_p.behaviorDiversity)
  const baseMomentum = Math.min(clamp01(MOMENTUM.base), MOMENTUM.maxPreference)
  const baseStraightness = clamp01(ROUTE_CHOICE.straightness)

  const agentId = sim.pedId[i]!

  // ── 3 Defined Pedestrian Profiles (Buen Camino Benchmark) ──────────
  // Deterministic roll per agent ID: 60% Commuters, 25% Caregivers, 15% Reduced Mobility
  const profileRoll = agentRandom(agentId, 99)
  let profileBaseSpeed = 1.2 // default m/s (FHWA P01 baseline)
  let defaultShopProb = 0.05
  let defaultWaitProb = 0.05

  if (profileRoll < 0.6) {
    // Profile 1: Commuters / Direct Transit (60%)
    profileBaseSpeed = 1.2
    defaultShopProb = 0.02
    defaultWaitProb = 0.02
  } else if (profileRoll < 0.85) {
    // Profile 2: Caregivers & Families / Women with Children (25%)
    profileBaseSpeed = 1.0
    defaultShopProb = 0.35 // higher pull toward vendor stalls & shade
    defaultWaitProb = 0.2
  } else {
    // Profile 3: Reduced Mobility & Older Adults (15%) (FHWA P03/P04 baseline)
    profileBaseSpeed = 0.8
    defaultShopProb = 0.05
    defaultWaitProb = 0.15
  }

  // Apply individual speed variation based on profile baseline
  const speedSpread =
    profileBaseSpeed * (SPEED.spreadBase + dispersion * SPEED.spreadDiversityScale)
  const speedOffset = agentSignedRandom(agentId, 7) * speedSpread
  sim.pedSpeed[i] = Math.max(SPEED.minAgentSpeed, profileBaseSpeed + speedOffset)

  let heading = getTargetHeading(sim, i)
  heading = normalizeDeg(heading)
  sim.setAgentHeading(i, heading)

  const momentumSpread = dispersion * MOMENTUM.spreadScale
  const straightnessSpread = dispersion * SPEED.straightnessSpread
  const momentumOffset = agentSignedRandom(agentId, 11) * momentumSpread
  const straightnessOffset = agentSignedRandom(agentId, 17) * straightnessSpread

  sim.pedMomentumPreference[i] = Math.min(
    clamp01(baseMomentum + momentumOffset),
    MOMENTUM.maxPreference,
  )
  sim.pedRouteStraightness[i] = clamp01(baseStraightness + straightnessOffset)

  const biasAngle = agentRandom(agentId, 23) * TAU
  const biasStrength = dispersion * ROUTE_CHOICE.biasStrengthScale
  sim.pedRouteBiasDx[i] = Math.cos(biasAngle)
  sim.pedRouteBiasDy[i] = Math.sin(biasAngle)
  sim.pedRouteBiasWeight[i] = biasStrength

  // Set engagement probabilities per profile
  sim.pedShopProb[i] = Number.isFinite(shopProb) ? shopProb : defaultShopProb
  sim.pedWaitProb[i] = Number.isFinite(waitProb) ? waitProb : defaultWaitProb
  sim.pedNoEngagement[i] = startNode.noEngagement === true ? 1 : 0
  sim.pedEngagementMode[i] = ENGAGEMENT_OFF
  sim.pedEngagementDuration[i] = 0
  sim.pedEngagementElapsed[i] = 0
  sim.pedCurrentSpeed[i] = sim.pedSpeed[i]!
  sim.pedMnlHeading[i] = Number.NaN
}

/** Re-derive per-agent baked params after a slider change. Public API. */
export function recomputeAgentParams(sim: Simulation, i: number): void {
  const dispersion = clamp01(_p.behaviorDiversity)
  const agentId = sim.pedId[i]!

  const speedSpread = _p.speedBase * (SPEED.spreadBase + dispersion * SPEED.spreadDiversityScale)
  const speedOffset = agentSignedRandom(agentId, 7) * speedSpread
  sim.pedSpeed[i] = Math.max(SPEED.minAgentSpeed, _p.speedBase + speedOffset)

  const baseMomentum = Math.min(clamp01(MOMENTUM.base), MOMENTUM.maxPreference)
  const momentumSpread = dispersion * MOMENTUM.spreadScale
  const momentumOffset = agentSignedRandom(agentId, 11) * momentumSpread
  sim.pedMomentumPreference[i] = Math.min(
    clamp01(baseMomentum + momentumOffset),
    MOMENTUM.maxPreference,
  )

  const baseStraightness = clamp01(ROUTE_CHOICE.straightness)
  const straightnessSpread = dispersion * SPEED.straightnessSpread
  const straightnessOffset = agentSignedRandom(agentId, 17) * straightnessSpread
  sim.pedRouteStraightness[i] = clamp01(baseStraightness + straightnessOffset)

  sim.pedRouteBiasWeight[i] = dispersion * ROUTE_CHOICE.biasStrengthScale
}
