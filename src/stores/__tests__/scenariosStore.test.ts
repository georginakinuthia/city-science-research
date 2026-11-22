import { booleanPointInPolygon, featureCollection, lineString, point, polygon } from '@turf/turf'
import type { FeatureCollection } from 'geojson'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'

import { useScenariosStore } from '../scenarios'

afterEach(() => vi.unstubAllGlobals())

it('shares missing files with scenario A, preserves empty layers, and clips crowd anchors to the study polygon', async () => {
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
  const files = new Map<string, FeatureCollection>([
    ['/scenarioA/surfaces.geojson', featureCollection([boundary])],
    ['/scenarioA/stalls.geojson', featureCollection([boundary])],
    ['/scenarioA/structures.geojson', empty],
    ['/scenarioA/shade.geojson', empty],
    ['/scenarioA/furniture.geojson', empty],
    ['/scenarioA/transport_types.geojson', empty],
    ['/scenarioA/study_boundary.geojson', featureCollection([boundary])],
    ['/scenarioA/metro_stations.geojson', empty],
    ['/scenarioA/walkway2.geojson', walkways],
    ['/scenarioA/destinations.geojson', destinations],
    ['/scenarioA/bus_stops.geojson', busStops],
    ['/scenarioB/stalls.geojson', empty],
    ['/scenarioB/bus_stops.geojson', empty],
  ])
  const fetch = vi.fn(async ({ pathname }: URL) => {
    const data = files.get(pathname)
    if (data) return new Response(JSON.stringify(data))
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
  expect(store.scenarioB?.stalls.features).toEqual([])
  expect(store.scenarioB?.structures.features).toEqual([])
  expect(store.scenarioB?.surfaces).toBe(store.scenarioA?.surfaces)
  expect(store.scenarioB?.routing?.studyBoundary).toEqual(featureCollection([boundary]))
  const crowd = store.scenarioB?.routing?.crowd
  expect(crowd?.destinations).toEqual([inside])
  expect(store.scenarioA?.routing?.crowd?.busStops).toEqual([inside])
  expect(crowd?.busStops).toEqual([])
  expect(crowd!.walkways.length).toBeGreaterThan(0)
  expect(crowd!.walkways.every((anchor) => booleanPointInPolygon(anchor, boundary))).toBe(true)
  expect(
    fetch.mock.calls.filter(([url]) => url.pathname === '/scenarioA/walkway2.geojson'),
  ).toHaveLength(1)
})
