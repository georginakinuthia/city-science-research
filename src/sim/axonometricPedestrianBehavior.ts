import type { FeatureCollection, Geometry } from 'geojson'

import { featureMask, type RoutingData } from '../stores/geo'
import { interventionSpineAxis, INTERVENTION_RULES } from './scenarioBInterventions'

const SCENARIO_B_CORRIDORS = [
  [[-99.1879, 19.40235], [-99.1869, 19.40255], [-99.1858, 19.40275]],
  [[-99.18635, 19.40175], [-99.18625, 19.40275], [-99.18615, 19.40375]],
  [[-99.18765, 19.40210], [-99.18752, 19.40275], [-99.18742, 19.40335]],
  [[-99.18770, 19.40170], [-99.18725, 19.40205], [-99.18655, 19.40225]],
] as const

interface AxonometricPedestrianVariables {
  axisX: Float32Array
  axisY: Float32Array
  linearity: Float32Array
  shoppingPull: Float32Array
  waitingPull: Float32Array
  stallApproach?: Float32Array
}

/** Bake the design into the existing pedestrian grid once, before agents step. */
export function computeAxonometricPedestrianVariables(
  zones: RoutingData['interventionZones'],
  grid: Parameters<typeof featureMask>[1],
  walkable: Uint8Array | undefined,
  metersPerCell?: number,
  stalls?: FeatureCollection<Geometry>,
): AxonometricPedestrianVariables | undefined {
  if (!zones || !walkable) return

  const size = walkable.length
  const axisX = new Float32Array(size)
  const axisY = new Float32Array(size)
  const linearity = new Float32Array(size)
  const shoppingPull = new Float32Array(size)
  const waitingPull = new Float32Array(size)

  for (const feature of zones.features) {
    const { category, axis } = feature.properties
    // 07 shared access and 01/08 metro and bus interchange carry through trips.
    // 02/10 markets serve shoppers; 06 canopy, 04/05 seating/grove and
    // 03/09/11 courts and play serve agents looking for a place to wait.
    if (category === 'street_lighting') continue
    const through = category === 'shared_access_spine' || category === 'transit_wayfinding'
    const direction = through ? axis ?? interventionSpineAxis(feature.geometry) : undefined
    const pull = INTERVENTION_RULES[category].offCorridorDwellPull
    const dwell = category === 'market_organized' ? shoppingPull : waitingPull
    const weight = category === 'shared_access_spine' ? 0.22 : 0.14
    if (through && !direction) continue
    const mask = featureMask({ type: 'FeatureCollection', features: [feature] }, grid)
    for (let cell = 0; cell < size; cell++) {
      if (!mask[cell] || !walkable[cell]) continue
      if (direction && weight > linearity[cell]!) {
        axisX[cell] = direction[0]
        axisY[cell] = direction[1]
        linearity[cell] = weight
      } else if (!through && pull > dwell[cell]!) {
        dwell[cell] = pull
      }
    }
  }
  if (metersPerCell && metersPerCell > 0) {
    const radius = 12 / metersPerCell
    const closest = new Float32Array(size).fill(radius * radius)
    for (const corridor of SCENARIO_B_CORRIDORS) {
      for (let i = 1; i < corridor.length; i++) {
        const [lon0, lat0] = corridor[i - 1]!
        const [lon1, lat1] = corridor[i]!
        const x0 = grid.lonToX(lon0), y0 = grid.latToY(lat0)
        const x1 = grid.lonToX(lon1), y1 = grid.latToY(lat1)
        const dx = x1 - x0, dy = y1 - y0
        const lengthSquared = dx * dx + dy * dy
        if (!lengthSquared) continue
        const length = Math.sqrt(lengthSquared)
        const west = Math.max(0, Math.floor(Math.min(x0, x1) - radius))
        const east = Math.min(grid.width - 1, Math.ceil(Math.max(x0, x1) + radius))
        const north = Math.max(0, Math.floor(Math.min(y0, y1) - radius))
        const south = Math.min(grid.height - 1, Math.ceil(Math.max(y0, y1) + radius))
        for (let y = north; y <= south; y++) {
          for (let x = west; x <= east; x++) {
            const cell = y * grid.width + x
            if (!walkable[cell]) continue
            const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lengthSquared))
            const ex = x - (x0 + t * dx), ey = y - (y0 + t * dy)
            const distance = ex * ex + ey * ey
            if (distance >= closest[cell]!) continue
            closest[cell] = distance
            axisX[cell] = dx / length
            axisY[cell] = dy / length
            linearity[cell] = 0.34 - 0.1 * Math.sqrt(distance) / radius
          }
        }
      }
    }
  }
  const stallApproach = stalls?.features.length && metersPerCell && metersPerCell > 0
    ? buildStallApproach(stalls, grid, walkable, metersPerCell)
    : undefined
  return { axisX, axisY, linearity, shoppingPull, waitingPull, stallApproach }
}

// Frontage cells are outside the footprint, so pausing does not place anyone inside a stall.
function buildStallApproach(
  stalls: FeatureCollection<Geometry>,
  grid: Parameters<typeof featureMask>[1],
  walkable: Uint8Array,
  metersPerCell: number,
): Float32Array {
  const organized = stalls.features.filter(({ properties }) => properties?.category === 'market_organized')
  const footprint = featureMask(organized.length ? { ...stalls, features: organized } : stalls, grid)
  const potential = new Float32Array(walkable.length).fill(-1)
  const distance = new Int32Array(walkable.length).fill(-1)
  const queue = new Int32Array(walkable.length)
  const { width } = grid
  let tail = 0

  for (let cell = 0; cell < walkable.length; cell++) {
    if (!walkable[cell] || footprint[cell]) continue
    const x = cell % width
    if (!(footprint[cell - width] || footprint[cell + width] ||
        (x > 0 && footprint[cell - 1]) || (x < width - 1 && footprint[cell + 1]))) continue
    distance[cell] = 0
    potential[cell] = 1
    queue[tail++] = cell
  }

  const reach = 9 / metersPerCell
  for (let head = 0; head < tail; head++) {
    const cell = queue[head]!
    const steps = distance[cell]! + 1
    if (steps >= reach) continue
    const x = cell % width
    for (const neighbor of [
      cell - width, cell + width, x > 0 ? cell - 1 : -1, x < width - 1 ? cell + 1 : -1,
    ]) {
      if (!walkable[neighbor] || footprint[neighbor] || distance[neighbor] !== -1) continue
      distance[neighbor] = steps
      potential[neighbor] = 1 - 2 * steps / reach
      queue[tail++] = neighbor
    }
  }
  return potential
}

/** Bias a through trip along the corridor in its current direction of travel. */
export function applyPedestrianAxonometricSteering(
  variables: AxonometricPedestrianVariables | undefined,
  cell: number,
  heading: number,
  routeHeading: number,
): number {
  const weight = variables?.linearity[cell] ?? 0
  if (!variables || !weight) return heading
  const x = variables.axisX[cell]!
  const y = variables.axisY[cell]!
  const route = routeHeading * Math.PI / 180
  const along = x * Math.sin(route) - y * Math.cos(route)
  // A nearly perpendicular departure is intentional, such as leaving for a side street.
  if (Math.abs(along) < 0.35) return heading
  const angle = heading * Math.PI / 180
  const sign = Math.sign(along)
  const dx = Math.sin(angle) * (1 - weight) + x * sign * weight
  const dy = -Math.cos(angle) * (1 - weight) + y * sign * weight
  return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
}
