import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'url'
import { defineConfig } from 'vite'
import svgLoader from 'vite-svg-loader'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  return {
    base: command === 'build' ? '/city-science-research/' : '/',
    plugins: [
      vue(),
      tailwindcss(),
      svgLoader({
        svgo: true,
        svgoConfig: {
          multipass: true,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      minify: command === 'serve' ? false : 'esbuild',
      sourcemap: command === 'serve' ? 'inline' : false,
      rollupOptions: {
        output: {
          manualChunks: {
            // Separate large vendor libraries into their own chunks
            'vendor-map': ['maplibre-gl'],
            'vendor-three': ['three'],
            'vendor-geo': ['@turf/turf'],
            'vendor-vue': ['vue', 'pinia', '@vueuse/core', '@vueuse/components'],
            'vendor-ui': ['reka-ui'],
          },
        },
      },
      chunkSizeWarningLimit: 1000, // Increase warning limit to 1MB
    },
    css: {
      devSourcemap: true,
    },
  }
})
