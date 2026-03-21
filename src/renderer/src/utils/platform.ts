export type RendererPlatform = 'darwin' | 'win32' | 'linux'

export function getRendererPlatform(): RendererPlatform {
  if (typeof window !== 'undefined' && window.electronAPI?.platform) {
    return window.electronAPI.platform
  }

  return 'darwin'
}
