import { booleanPointInPolygon, featureCollection, lineString, point, polygon } from '@turf/turf'
import type { FeatureCollection } from 'geojson'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'

import { useScenariosStore } from '../scenarios'

afterEach(() => vi.unstubAllGlobals())

it('shares missing files with scenario A, replaces empty placeholders, and clips crowd anchors to the study polygon', async () => {
  const boundary = polygon([
    [
      [-99.19, 19.4],
      [-99.189, 19.4],
      [-99.189, 19.401],
      [-99.19, 19.401],
      [-99.19, 19.4],
    ],
    [
      [-99.1896, 19.4004],
      [-99.1896, 19.4006],
      [-99.1894, 19.4006],
      [-99.1894, 19.4004],
      [-99.1896, 19.4004],
    ],
  ])
  const inside = [-99.1898, 19.4002]
  const hole = [-99.1895, 19.4005]
  const outside = [-99.1889, 19.4005]
  const walkways = featureCollection([lineString([[-99.1901, 19.4005], outside])])
  const busStops = featureCollection([point(inside), point(outside)])
  const destinations = featureCollection([point(inside), point(hole), point(outside)])
  const empty = featureCollection([])
  const transport = featureCollection([
    lineString([inside, outside], { id: 'route-1' }),
  ])
  const files = new Map<string, FeatureCollection>([
    ['/scenarioA/main_buildings.geojson', featureCollection([point(outside)])],
    ['/scenarioA/publicspace.geojson', featureCollection([boundary])],
    ['/scenarioA/extra_buildings.geojson', featureCollection([boundary])],
    ['/scenarioA/streets.geojson', walkways],
    ['/scenarioA/buses.geojson', empty],
    ['/scenarioA/tacubaya_stalls.geojson', featureCollection([boundary])],
    ['/scenarioA/trees.geojson', empty],
    ['/scenarioA/blocks.geojson', empty],
    ['/scenarioA/crime.geojson', empty],
    ['/scenarioA/economic_activity2.geojson', destinations],
    ['/scenarioA/transport_types.geojson', transport],
    ['/scenarioA/study_boundary.geojson', featureCollection([boundary])],
    ['/scenarioA/metro_stations.geojson', featureCollection([point(inside)])],
    ['/scenarioA/bus_stops.geojson', busStops],
    ['/scenarioA/zebra_crossings.geojson', featureCollection([boundary])],
    ['/scenarioA/street_lights.geojson', featureCollection([point(inside, { visibility_radius: 10 })])],
    ['/scenarioB/street_lights.geojson', empty],
    ['/scenarioB/tacubaya_stalls.geojson', empty],
    ['/scenarioB/bus_stops.geojson', empty],
    ['/scenarioB/metro_stations.geojson', featureCollection([point(hole), point(inside)])],
  ])
  const fetch = vi.fn(async ({ pathname }: URL) => {
    const data = files.get(pathname)
    if (data) return new Response(JSON.stringify(data))
    if (pathname === '/scenarioA/transport_types.csv') {
      return new Response('id,name\r\nroute-1,"Local, ""Express"""\r\n')
    }
    if (pathname === '/scenarioB/transport_types.csv') return new Response('id,name\n')
    if (pathname === '/scenarioB/study_boundary.geojson') {
      return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })
    }
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  const store = useScenariosStore(createPinia())

  await Promise.all([store.loadScenarios(), store.loadScenarios()])

  expect(store.isReady).toBe(true)
  expect(store.error).toBeNull()
  expect(store.scenarioA?.stalls.features).toHaveLength(1)
  expect(store.scenarioB?.stalls).toBe(store.scenarioA?.stalls)
  expect(store.scenarioB?.structures.features).toEqual([boundary])
  expect(store.scenarioB?.surfaces.features).toEqual([])
  expect(store.scenarioB?.routing?.studyBoundary).toEqual(featureCollection([boundary]))
  expect(store.scenarioA?.routing?.interventionZones).toBeUndefined()
  expect(store.scenarioB?.routing?.interventionZones?.features).toHaveLength(1)
  expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith('/main_buildings.geojson'))).toBe(false)
  expect(store.scenarioB?.routing?.pedestrian?.metro.features).toHaveLength(1)
  expect(store.scenarioB?.routing?.transport.features[0]?.properties?.name).toBe('Local, "Express"')
  const sharedLights = store.scenarioA?.routing?.pedestrian?.streetLights
  expect(sharedLights?.features).toHaveLength(1)
  expect(store.scenarioB?.routing?.pedestrian?.streetLights).toBe(sharedLights)
  expect(store.scenarioB?.routing?.pedestrian?.zebraCrossings?.features[0]?.properties)
    .toMatchObject({ id: 1, has_signal: 0, obstructed: 1, lit: 1 })
  const crowd = store.scenarioB?.routing?.crowd
  expect(crowd?.destinations).toEqual([inside])
  expect(store.scenarioA?.routing?.crowd?.busStops).toEqual([inside])
  expect(crowd?.busStops).toEqual([inside])
  expect(crowd!.walkways.length).toBeGreaterThan(0)
  expect(crowd!.walkways.every((anchor) => booleanPointInPolygon(anchor, boundary))).toBe(true)
  expect(
    fetch.mock.calls.filter(([url]) => url.pathname === '/scenarioA/streets.geojson'),
  ).toHaveLength(1)
  expect(fetch.mock.calls.some(([url]) =>
    /\/(?:walkway2|boundary|destinations|street_stalls|buildings)\.geojson$/.test(url.pathname),
  )).toBe(false)
  for (const file of ['surfaces', 'shade', 'furniture']) {
    expect(fetch.mock.calls.some(([url]) => url.pathname === `/scenarioB/${file}.geojson`)).toBe(true)
  }
  expect(fetch.mock.calls.some(([url]) => url.pathname === '/scenarioA/shade.geojson')).toBe(false)
})
