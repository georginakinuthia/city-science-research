import type { CustomLayerInterface } from 'maplibre-gl'
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Camera, DynamicDrawUsage,
  Points, Scene, ShaderMaterial, WebGLRenderer,
} from 'three'

import { TACUBAYA_CROWD } from '../config'
import type { SimView } from '../sim/SimView'

const CORE_RADIUS = 1.6
const CORE_STROKE_RADIUS = 2.5
const HALO_RADIUS = 4.2
const HALO_OPACITY = 0.28

function makeMaterial(radius: number, halo: boolean): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    ...(halo ? { blending: AdditiveBlending } : {}),
    uniforms: {
      diameter: { value: radius * 2 },
      opacity: { value: halo ? HALO_OPACITY : 1 },
      halo: { value: halo },
      coreRatio: { value: CORE_RADIUS / CORE_STROKE_RADIUS },
    },
    vertexShader: `
      attribute float danger;
      uniform float diameter;
      varying float vDanger;

      void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
        gl_PointSize = diameter;
        vDanger = danger;
      }
    `,
    fragmentShader: `
      uniform float opacity;
      uniform bool halo;
      uniform float coreRatio;
      varying float vDanger;

      void main() {
        float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float edge = max(fwidth(r), 0.001);
        float alpha = halo ? 1.0 - smoothstep(0.0, 1.0, r)
          : 1.0 - smoothstep(1.0 - edge, 1.0, r);
        vec3 color = mix(vec3(1.0), vec3(255.0, 59.0, 48.0) / 255.0, vDanger);
        if (!halo) {
          float core = 1.0 - smoothstep(coreRatio - edge * 0.5, coreRatio + edge * 0.5, r);
          color = mix(vec3(0.09, 0.11, 0.14), color, core);
        }
        gl_FragColor = vec4(color, alpha * opacity);
      }
    `,
  })
}

export function createTacubayaAgentsLayer(sim: SimView): CustomLayerInterface {
  let draw: () => void = () => {}
  let dispose: () => void = () => {}

  return {
    id: 'agents',
    type: 'custom',
    renderingMode: '2d',
    onAdd(map, gl) {
      const canvas = map.getCanvas()
      const renderer = new WebGLRenderer({ canvas, context: gl as WebGL2RenderingContext })
      renderer.autoClear = false
      const camera = new Camera()
      const scene = new Scene()
      const geometry = new BufferGeometry()
      const positions = new Float32Array(TACUBAYA_CROWD.capacity * 3)
      const risks = new Float32Array(TACUBAYA_CROWD.capacity)
      const positionAttribute = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage)
      const dangerAttribute = new BufferAttribute(risks, 1).setUsage(DynamicDrawUsage)
      geometry.setAttribute('position', positionAttribute)
      geometry.setAttribute('danger', dangerAttribute)
      const haloMaterial = makeMaterial(HALO_RADIUS, true)
      const coreMaterial = makeMaterial(CORE_STROKE_RADIUS, false)

      for (const [order, material] of [haloMaterial, coreMaterial].entries()) {
        const points = new Points(geometry, material)
        points.frustumCulled = false
        points.renderOrder = order
        scene.add(points)
      }
      renderer.resetState()

      draw = () => {
        const { clientWidth: width, clientHeight: height } = canvas
        if (!width || !height || !sim.pedCount) return
        let count = 0
        for (let i = 0; i < sim.pedCount && count < risks.length; i++) {
          const lon = sim.xToLon(sim.pedX[i]!)
          const lat = sim.yToLat(sim.pedY[i]!)
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
          const point = map.project([lon, lat])
          if (point.x < -HALO_RADIUS || point.x > width + HALO_RADIUS ||
              point.y < -HALO_RADIUS || point.y > height + HALO_RADIUS) continue
          positions[count * 3] = 2 * point.x / width - 1
          positions[count * 3 + 1] = 1 - 2 * point.y / height
          risks[count] = Number(Boolean(sim.pedVisualRisk[i]))
          count++
        }
        geometry.setDrawRange(0, count)
        positionAttribute.needsUpdate = true
        dangerAttribute.needsUpdate = true
        const pixelRatio = canvas.width / width
        haloMaterial.uniforms.diameter!.value = HALO_RADIUS * 2 * pixelRatio
        coreMaterial.uniforms.diameter!.value = CORE_STROKE_RADIUS * 2 * pixelRatio
        renderer.resetState()
        renderer.setViewport(0, 0, canvas.width, canvas.height)
        renderer.render(scene, camera)
      }

      dispose = () => {
        geometry.dispose()
        haloMaterial.dispose()
        coreMaterial.dispose()
        renderer.dispose()
        draw = () => {}
      }
    },
    render() { draw() },
    onRemove() { dispose() },
  }
}

