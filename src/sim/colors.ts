/**
 * u32-packed RGBA color helpers for direct ImageData writes.
 *
 * Colors are represented as `number` (Uint32) rather than `{r,g,b,a}` objects
 * so they can be written into a `Uint32Array` view of an `ImageData.data`
 * buffer with zero per-pixel allocation cost.
 *
 * Byte order: ImageData.data is a little-endian `[R, G, B, A]` layout on
 * every WebGL-capable browser, which means viewing the same bytes as a
 * `Uint32Array` yields `(a << 24) | (b << 16) | (g << 8) | r`.
 */
import { color as d3color } from 'd3-color'

/** Pack 8-bit RGBA components into a single u32 suitable for ImageData writes. */
export function packRGBA(r: number, g: number, b: number, a: number = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
}

/**
 * Parse a hex / named color string into a u32. Accepts `#rgb`, `#rrggbb`,
 * `#rrggbbaa`, and the literal `'transparent'`. Unknown inputs fall back
 * to fully transparent.
 */
export function parseColorU32(input: string): number {
  if (input === 'transparent') return 0
  const c = d3color(input)
  if (!c) return 0
  const rgb = c.rgb()
  const r = Math.round(rgb.r)
  const g = Math.round(rgb.g)
  const b = Math.round(rgb.b)
  const a = Math.round((rgb.opacity ?? 1) * 255)
  return packRGBA(r, g, b, a)
}

/** Unpack the red component of a u32 pixel. */
export function unpackR(pixel: number): number { return pixel & 0xff }

/** Unpack the green component of a u32 pixel. */
export function unpackG(pixel: number): number { return (pixel >>> 8) & 0xff }

/** Unpack the blue component of a u32 pixel. */
export function unpackB(pixel: number): number { return (pixel >>> 16) & 0xff }

/** Unpack the alpha component of a u32 pixel. */
export function unpackA(pixel: number): number { return (pixel >>> 24) & 0xff }

/** Convert a u32 pixel to a CSS `rgba(r,g,b,a)` string for `ctx.fillStyle`. */
export function u32ToCssRGBA(pixel: number): string {
  const r = unpackR(pixel)
  const g = unpackG(pixel)
  const b = unpackB(pixel)
  const a = unpackA(pixel) / 255
  return `rgba(${r},${g},${b},${a})`
}

/**
 * Linearly interpolate between two u32 colors in RGBA space by `t ∈ [0, 1]`.
 * Allocation-free — returns a u32 directly.
 */
export function lerpColorU32(c1: number, c2: number, t: number): number {
  const t2 = t < 0 ? 0 : t > 1 ? 1 : t
  const r1 = c1 & 0xff
  const g1 = (c1 >>> 8) & 0xff
  const b1 = (c1 >>> 16) & 0xff
  const a1 = (c1 >>> 24) & 0xff
  const r2 = c2 & 0xff
  const g2 = (c2 >>> 8) & 0xff
  const b2 = (c2 >>> 16) & 0xff
  const a2 = (c2 >>> 24) & 0xff
  const r = Math.round(r1 + (r2 - r1) * t2)
  const g = Math.round(g1 + (g2 - g1) * t2)
  const b = Math.round(b1 + (b2 - b1) * t2)
  const a = Math.round(a1 + (a2 - a1) * t2)
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
}

/**
 * Create a scalar→u32-color mapper that interpolates linearly between two
 * packed colors for a value in `[min, max]`. Values outside the range are
 * clamped. Returns a `number` (not an object) — no allocation per call.
 *
 * Usage:
 *   const grad = makeGradientU32(parseColorU32('#00000000'), parseColorU32('#ff5820ff'))
 *   const pixel = grad(stallPotential[idx], 0, 1)
 */
export function makeGradientU32(c1: number, c2: number): (value: number, min: number, max: number) => number {
  return (value: number, min: number, max: number): number => {
    const span = max - min
    const t = span === 0 ? 0 : (value - min) / span
    return lerpColorU32(c1, c2, t)
  }
}


export const AGENT_RISK_COLORS = ['#ffffff', '#ff3b30', '#ff3b30'] as const
