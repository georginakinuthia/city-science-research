import { coordEach } from '@turf/turf'
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson'

interface InterventionRule {
  speedMultiplier: number
  routeUtilityBonus: number
  congestionThresholdScale: number
  crimeRiskMultiplier: number
  offCorridorDwellPull: number
}

export const INTERVENTION_RULES = {
  shared_access_spine: { speedMultiplier: 1.24, routeUtilityBonus: 0.45, congestionThresholdScale: 2.35, crimeRiskMultiplier: 0.25, offCorridorDwellPull: 0 },
  market_organized: { speedMultiplier: 1.12, routeUtilityBonus: 0.25, congestionThresholdScale: 2.1, crimeRiskMultiplier: 0.30, offCorridorDwellPull: 0.65 },
  community_canopy: { speedMultiplier: 1.08, routeUtilityBonus: 0.30, congestionThresholdScale: 2, crimeRiskMultiplier: 0.28, offCorridorDwellPull: 0.55 },
  active_recreation: { speedMultiplier: 1.05, routeUtilityBonus: 0.20, congestionThresholdScale: 1.9, crimeRiskMultiplier: 0.28, offCorridorDwellPull: 0.50 },
  sightline_seating_veg: { speedMultiplier: 1.10, routeUtilityBonus: 0.22, congestionThresholdScale: 1.75, crimeRiskMultiplier: 0.32, offCorridorDwellPull: 0.40 },
  transit_wayfinding: { speedMultiplier: 1.20, routeUtilityBonus: 0.40, congestionThresholdScale: 2.2, crimeRiskMultiplier: 0.30, offCorridorDwellPull: 0 },
  street_lighting: { speedMultiplier: 1.05, routeUtilityBonus: 0.25, congestionThresholdScale: 1.3, crimeRiskMultiplier: 0.26, offCorridorDwellPull: 0 },
} satisfies Record<string, InterventionRule>

export type InterventionCategory = keyof typeof INTERVENTION_RULES
export type InterventionZones = FeatureCollection<Polygon | MultiPolygon, {
  category?: InterventionCategory
  axis?: [number, number]
}>
export const INTERVENTION_CATEGORIES = Object.keys(INTERVENTION_RULES) as InterventionCategory[]
export const MAX_ROUTE_BONUS = 0.85
export const MIN_CRIME_WEIGHT = 0.18

export function classifyInterventionFeature(
  properties: Feature['properties'], sourceHint = '',
): InterventionCategory {
  const explicit = properties?.intervention_type ?? properties?.category
  if (typeof explicit === 'string' && Object.prototype.hasOwnProperty.call(INTERVENTION_RULES, explicit)) {
    return explicit as InterventionCategory
  }
  const hints = [explicit, properties?.type, properties?.name, properties?.layer, sourceHint]
    .filter((hint): hint is string => typeof hint === 'string')
    .join(' ').toLowerCase().replace(/[_-]/g, ' ')

  if (/\b(?:light|lighting|lights|lamps?|streetlights?)\b/.test(hints)) return 'street_lighting'
  if (/\b(?:metro|bus|buses|transit|wayfinding|totem)\b/.test(hints)) return 'transit_wayfinding'
  if (/\b(?:stalls?|puestos?|markets?)\b/.test(hints)) return 'market_organized'
  if (/\b(?:sports?|play|court|games?|recreation)\b/.test(hints)) return 'active_recreation'
  if (/\b(?:canopy|shade|covered|gathering)\b/.test(hints)) return 'community_canopy'
  if (/\b(?:spine|shared access|car free|pedestrian|surfaces?|crossings?)\b/.test(hints)) return 'shared_access_spine'
  return 'sightline_seating_veg'
}

/** Dominant axis of an elongated corridor, in east/south grid coordinates. */
export function interventionSpineAxis(geometry: Geometry): [number, number] | undefined {
  if (geometry.type !== 'LineString' && geometry.type !== 'Polygon') return
  const shape = geometry.type === 'Polygon' ? { type: 'LineString' as const, coordinates: geometry.coordinates[0] ?? [] }
    : geometry
  let count = 0
  let originX = 0, originY = 0, longitudinalScale = 1
  let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0
  coordEach(shape, ([longitude, latitude], index) => {
    if (index === shape.coordinates.length - 1 && geometry.type === 'Polygon') return
    if (longitude === undefined || latitude === undefined) return
    if (count === 0) {
      originX = longitude
      originY = latitude
      longitudinalScale = Math.cos(latitude * Math.PI / 180)
    }
    const x = (longitude - originX) * longitudinalScale
    const y = originY - latitude
    count++
    sumX += x
    sumY += y
    sumXX += x * x
    sumYY += y * y
    sumXY += x * y
  })
  if (count < 2) return
  const xx = sumXX - sumX * sumX / count
  const yy = sumYY - sumY * sumY / count
  const xy = sumXY - sumX * sumY / count
  const spread = Math.hypot(xx - yy, 2 * xy)
  if (spread <= 0 || spread < (xx + yy) * 0.6) return
  const axis = Math.atan2(2 * xy, xx - yy) / 2
  return [Math.cos(axis), Math.sin(axis)]
}
