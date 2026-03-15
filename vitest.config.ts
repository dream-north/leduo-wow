import { resolve } from 'path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, Plugin } from 'vitest/config'

// Mock static assets in tests
function mockAssets(): Plugin {
  return {
    name: 'mock-assets',
    enforce: 'pre',
    resolveId(id) {
      if (id === '/icon.png' || id.endsWith('.png')) {
        return id
      }
      return null
    },
    load(id) {
      if (id === '/icon.png' || id.endsWith('.png')) {
        return 'export default ""'
      }
      return null
    }
  }
}

export default defineConfig({
  plugins: [mockAssets(), vue()],
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts']
  }
})
