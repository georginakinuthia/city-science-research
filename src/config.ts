/**
 * Consolidated ABM configuration.
 *
 * Every tunable constant lives here, grouped by scientific domain.
 * Consumers import the relevant group rather than defining inline
 * magic numbers.  Where a value derives from the literature the
 * citation is given inline.
 */

// ── User-facing defaults (exposed via UI sliders) ──────────────
export const DEFAULTS = {
  behaviorDiversity: 0.1, // [0, 1] per-agent variation
  personalSpace: 0.9, // [0.45, 1.5] m — Hall (1966) mid personal-far zone (0.76–1.22m)
  speedBase: 1.34, // [0.8, 2.0] m/s — Weidmann (1993) meta-analysis mean
  shoppingProbability: 0.666, // 4 stops: 0 (None), 0.333 (Low), 0.666 (Med), 1.0 (High)
  spareTimeProbability: 0.666, // 4 stops: 0 (None), 0.333 (Low), 0.666 (Med), 1.0 (High)
}

// ── Timing ─────────────────────────────────────────────────────
export const TIMING = {
  simulationDuration: 3600, // seconds (1 hour)
  fps: 30, // animation frames per second
  baseDeltaTime: 0.25, // simulated seconds per tick (normal mode)
  fastModeMultiplier: 4, // deltaTime multiplier in fast mode
}

export const MAX_AGENTS = 800

// Peak transfer-wave demand distributed across the Tacubaya hub.
export const TACUBAYA_CROWD = {
  initialAgents: 400,
  replenishmentThreshold: 650,
  replenishmentBand: 250,
  peakPph: 24_000,
  entrySnapMeters: 30,
  initialTargetLimit: 6,
  initialTripMeters: 25,
} as const

// ── Route choice — Antonini, Bierlaire & Weber (2006) MNL structure ──
// Patch-neighbor scoring follows a multinomial logit (MNL):
//   V(patch_i) = β_dist · v_dist + β_align · v_align · straightness
//              + β_density · v_density + β_obstacle · v_obstacle
//              + β_shade · v_shade + β_bias · biasVec + ε
// where ε is stable FNV-hash jitter (approximates Gumbel error).
// Both distGain and density are normalized to [0,1] per tick, so distance
// always dominates — agents make forward progress even in dense counter-flow.
// Density is opposition-weighted (oncoming = 1, co-directional = coDirectionalFloor),
// driving lane formation via relative differences between candidates.
// The same lookahead scan also outputs areal density (ped/m²) for Weidmann
// speed — one perception drives both heading and speed.
// Coefficients are not estimated from data; the model is illustrative.
export const ROUTE_CHOICE = {
  // MNL utility coefficients
  beta: {
    distance: 2.0, // β_dist — normalized progress toward destination
    alignment: 2.0, // β_align — preference for current heading (× straightness)
    density: -2.5, // β_density — normalized opposition-weighted density [0,1] (negative = repel)
    obstacle: -2.0, // β_obstacle — avoidance of stalls/structures (negative = repel)
    shade: 2.5, // β_shade — preference for shaded patches when sunny & uncrowded (positive = attract)
    // gated off when localDensity ≥ shadeDensityGate so density avoidance dominates
  },
  // Per-agent heterogeneity
  straightness: 0.3, // base alignment preference per agent
  biasStrengthScale: 1.0, // route bias = diversity × this
  // Gumbel error approximation
  jitterScale: 0.3, // FNV hash noise amplitude (reduced — less needed with normalization)
  // Logit scale parameter
  temperature: 1.0, // 1/μ in Antonini notation; lower = more deterministic
  // Directional density lookahead
  densityLookahead: 15, // patches ahead to sample for route-choice density (~15m at 1m/patch)
  shadeLookahead: 8, // patches ahead to sample for shade sensing (~8m at 1m/patch)
  coDirectionalFloor: 0.2, // minimum opposition weight for co-moving agents (0 = invisible, 1 = same as head-on)
  // gives MNL lateral spreading force for same-direction lane formation
}

// ── Following — co-directional position tracking ────────────
// Post-MNL nudge: steer toward the nearest co-directional agent
// ahead, producing single-file chains.  Density-gated so agents
// walk freely in open space and only queue when crowded.
export const FOLLOWING = {
  radius: 8, // metres — how far ahead to look for leaders
  coneHalfAngleDeg: 60, // degrees — forward cone width (±60° = 120° total)
  blendStrength: 0.75, // max heading blend toward leader's position
  crowdingOnset: 0, // oncoming agents before following begins
  crowdingFull: 3, // oncoming agents at which following reaches full strength
  pinchSlowdown: 0.5, // max speed reduction fraction at full oncoming crowding (0.5 = halve speed)
}

// ── Momentum smoothing ────────────────────────────────────────
// Analogous to the relaxation time τ in the Social Force Model
// (Helbing & Molnár 1995): agents blend toward their desired heading
// rather than snapping instantly, producing smooth, realistic trajectories.
// Applied BEFORE ORCA so collision avoidance is never dampened.
export const MOMENTUM = {
  base: 0.6, // heading smoothing — blends toward desired heading across ticks
  cap: 0.8, // hard max on momentum blend
  spreadScale: 0.6, // per-agent momentum variation = diversity × this
  maxPreference: 0.9, // cap on per-agent momentumPreference
}

// ── Speed ─────────────────────────────────────────────────────
export const SPEED = {
  minAgentSpeed: 0.1, // m/s floor on per-agent speed
  spreadBase: 0.1, // minimum speed spread fraction
  spreadDiversityScale: 0.4, // speed spread = speedBase × (spreadBase + diversity × this)
  straightnessSpread: 0.4, // per-agent straightness variation = diversity × this
}

// ── Weidmann (1993) fundamental diagram ───────────────────────
// v(ρ) = v₀ × (1 − exp(−γ × (1/ρ − 1/ρ_max)))
export const WEIDMANN = {
  gamma: 1.913, // shape parameter (1/m²)
  rhoMax: 5.4, // jam density (ped/m²) — standstill
  densityRadius: 2, // patch radius for local density (shade gate + engagement crowding only)
}

// ── ORCA — van den Berg et al. (2011) ─────────────────────────
export const ORCA = {
  timeHorizonWalking: 1.0, // seconds — collision avoidance lookahead
  timeHorizonEngaged: 1.5, // seconds — shopping/waiting agents
  maxNeighbors: 6,
  neighborDist: 10, // metres — should cover closure speed envelope
  radiusMultiplier: 0.7, // agentRadius = personalSpace × this
  engagedBlend: 0.3, // ORCA compliance for engaged agents (1.0 = full)
  spatialHashCellSize: 15, // world units — should be ≥ neighborDist for efficiency
}

// ── Proxemic zones — Hall (1966) ──────────────────────────────
// Thresholds as multiples of personalSpace. At default 0.90m these map to:
//   intimate  < 0.90m  (within personal space — ORCA collision boundary)
//   personal  < 1.22m  (personal-far → social boundary, Hall 1966)
//   social    < 3.69m  (social-far → public boundary, Hall 1966)
//   public    ≥ 3.69m  (no crowding effect)
export const PROXIMITY_ZONES = {
  intimate: 1.0, // multiplier × personalSpace — within configured comfort zone
  personal: 1.35, // ≈ personal → social boundary (1.22m at 0.90m PS)
  social: 4.1, // ≈ social → public boundary (3.66m at 0.90m PS)
}

// ── Engagement ────────────────────────────────────────────────
export const ENGAGEMENT = {
  shopMaxMinutes: 3,
  waitMaxMinutes: 3,
  crowdingThreshold: 2.0, // ped/m² — above this, engagement prob → 0
  stuckTimeoutSeconds: 30, // safety valve: disengage if agent can't reach amenity within this time
  // Amenity gradient weights by potential zone
  lowPotentialThreshold: 0.2,
  highPotentialThreshold: 0.4,
  ambientPullThreshold: 0.5,
  weights: {
    low: { heading: 0.5, speed: 0.5 },
    mid: { heading: 0.6, speed: 0.3 },
    high: { heading: 0.7, speed: 0.05 },
    ambient: { heading: 0.05 },
  },
}

// ── Surface preferences ───────────────────────────────────────
// Hierarchy (gated in MNL):
//   1. crowded (localDensity ≥ shadeDensityGate) → beta.shade zeroed, density avoidance dominates
//   2. sunny & uncrowded → beta.shade active, biases candidate choice toward shaded patches
//   3. no sun → beta.shade inactive, wall-centre preference from Dijkstra edge penalty
export const SURFACE = {
  recoveryStrengthNormal: 0.8, // push back onto walkable surface
  recoveryStrengthEngaged: 0.6,
  shadeDensityGate: 0.8, // ped/m² — above this, shade utility zeroed so crowd avoidance dominates
}

// ── Geometry ──────────────────────────────────────────────────
export const GEOMETRY = {
  targetPatchMeters: 1.0, // patch resolution (1 patch ≈ 1m²)
  arrivalRadius: 2, // world units — agent arrives and dies
  nearTargetRadius: 4, // skip amenity/avoidance when this close
  bboxPaddingMeters: 20, // buffer around scenario surfaces
  minPatchesWidth: 3, // floor on world grid width
  edgePenaltyFactor: 1.5, // Dijkstra cost multiplier at obstacle boundary (quadratic decay to 1.0 over penaltyRadius)
  // Steep near-wall cost creates smooth arcs around corners
  edgePenaltyRadius: 6, // patches over which the penalty decays (~6m at 1m/patch)
  // Wide reach creates a smooth centre-preference across typical corridor widths
}

// ── WGS84 geodetic constants ─────────────────────────────────
// Coefficients for the WGS84 ellipsoid latitude-dependent arc length series.
// Used to convert degree spans to metres for patch grid sizing.
export const WGS84 = {
  a0: 111132.92, // metres per degree latitude (zeroth-order)
  a2: 559.82, // second-order correction
  a4: 1.175, // fourth-order correction
  // Approximate degrees-per-metre at the equator (for sandbox terrain generation)
  degPerMeterEquator: 0.000009,
}
