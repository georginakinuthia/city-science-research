import type { Feature, FeatureCollection, Geometry, Polygon } from 'geojson'
import { MercatorCoordinate, type CustomLayerInterface } from 'maplibre-gl'
import {
  BufferGeometry, Camera, Float32BufferAttribute, LineBasicMaterial, LineSegments, Matrix4, Scene, WebGLRenderer,
} from 'three'

const MARKET_EAVES_METERS = 6

// Mercado Peña Manterola, OSM way 44341051 (© OpenStreetMap contributors, ODbL).
// The 6 m eaves are a visual estimate from the supplied Google Earth view.
export const tacubayaMarket: Feature<Polygon> = {
  type: 'Feature',
  id: 4773,
  properties: { fid: 4773, name: 'Mercado Peña Manterola', height: MARKET_EAVES_METERS, marketHall: true },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [-99.1892286, 19.403336], [-99.1892929, 19.4025414], [-99.1892593, 19.4025386],
      [-99.1892608, 19.4025234], [-99.1892207, 19.4025188], [-99.1892208, 19.4025001],
      [-99.1885188, 19.4024425], [-99.1885059, 19.4026787], [-99.1884733, 19.4032777],
      [-99.1892286, 19.403336],
    ]],
  },
}
export const TACUBAYA_MARKET_PART_IDS: ReadonlySet<number | string | undefined> = new Set([4773, 6548])

export function createTacubayaBuildingEdges(data: FeatureCollection<Geometry>): CustomLayerInterface {
  let draw: CustomLayerInterface['render'] = () => {}
  let dispose = () => {}
  return {
    id: 'buildings-roof-edges',
    type: 'custom',
    renderingMode: '3d',
    onAdd(map, gl) {
      const positions: number[] = []
      let origin: MercatorCoordinate | undefined
      for (const { geometry, properties } of data.features) {
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
          : geometry.type === 'MultiPolygon' ? geometry.coordinates : []
        const height = Number(properties?.renderHeight)
        if (!Number.isFinite(height)) continue
        for (const polygon of polygons) {
          for (const ring of polygon) {
            let previous: MercatorCoordinate | undefined
            for (const [lng, lat] of ring) {
              const point = MercatorCoordinate.fromLngLat([lng!, lat!], height + 0.05)
              origin ??= point
              if (previous) positions.push(
                previous.x - origin.x, previous.y - origin.y, previous.z - origin.z,
                point.x - origin.x, point.y - origin.y, point.z - origin.z,
              )
              previous = point
            }
          }
        }
      }
      if (!origin || !positions.length) return

      const translation = new Matrix4().makeTranslation(origin.x, origin.y, origin.z)
      const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3))
      const material = new LineBasicMaterial({
        color: '#7b8190', transparent: true, opacity: 0.20, depthWrite: false,
      })
      const edges = new LineSegments(geometry, material)
      edges.frustumCulled = false
      const camera = new Camera()
      const scene = new Scene()
      scene.add(edges)
      const canvas = map.getCanvas()
      const renderer = new WebGLRenderer({ canvas, context: gl as WebGL2RenderingContext })
      renderer.autoClear = false
      draw = (_gl, args) => {
        camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(translation)
        renderer.resetState()
        renderer.setViewport(0, 0, canvas.width, canvas.height)
        renderer.render(scene, camera)
      }
      dispose = () => {
        geometry.dispose()
        material.dispose()
        renderer.dispose()
        draw = () => {}
      }
    },
    render(gl, args) { draw(gl, args) },
    onRemove() { dispose() },
  }
}
