import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let permissionState = {
  microphone: false,
  accessibility: false,
  screen: false
}

vi.mock('./SettingsView.vue', () => ({
  default: {
    template: '<div data-test="settings-view">settings</div>'
  }
}))

vi.mock('./OnboardingView.vue', () => ({
  default: {
    emits: ['request-permission', 'refresh', 'continue'],
    template: `
      <div data-test="onboarding-view">
        <button data-test="continue" @click="$emit('continue')">continue</button>
      </div>
    `
  }
}))

import HomeView from './HomeView.vue'

describe('HomeView', () => {
  beforeEach(() => {
    permissionState = {
      microphone: false,
      accessibility: false,
      screen: false
    }

    window.electronAPI = {
      checkPermissions: vi.fn(async () => ({ ...permissionState })),
      getConfig: vi.fn(async () => ({
        shortcut: 'RightCommand',
        transcriptionShortcut: 'RightCommand',
        assistantShortcut: 'RightOption'
      })),
      refreshShortcutStatus: vi.fn(async () => ({
        permissionState: permissionState.accessibility ? 'granted' : 'missing',
        backendState: permissionState.accessibility ? 'native' : 'disabled',
        reason: permissionState.accessibility ? 'ready' : 'permission_missing',
        modes: {
          transcription: {
            mode: 'transcription',
            shortcut: 'RightCommand',
            backendState: permissionState.accessibility ? 'native' : 'disabled',
            reason: permissionState.accessibility ? 'ready' : 'unsupported_without_accessibility',
            requiresAccessibility: true,
            canTriggerGlobally: permissionState.accessibility
          },
          assistant: {
            mode: 'assistant',
            shortcut: 'RightOption',
            backendState: permissionState.accessibility ? 'native' : 'disabled',
            reason: permissionState.accessibility ? 'ready' : 'unsupported_without_accessibility',
            requiresAccessibility: true,
            canTriggerGlobally: permissionState.accessibility
          }
        }
      })),
      requestPermission: vi.fn(async () => false),
      ensureNativeBackendReady: vi.fn(async () => true)
    } as never
  })

  it('shows onboarding when required permissions are missing', async () => {
    const wrapper = mount(HomeView)
    await flushPromises()

    expect(wrapper.find('[data-test="onboarding-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="settings-view"]').exists()).toBe(false)
  })

  it('shows settings immediately when required permissions are already granted', async () => {
    permissionState.microphone = true
    permissionState.accessibility = true

    const wrapper = mount(HomeView)
    await flushPromises()

    expect(wrapper.find('[data-test="settings-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="onboarding-view"]').exists()).toBe(false)
  })

  it('requires onboarding completion after permissions become available', async () => {
    const wrapper = mount(HomeView)
    await flushPromises()

    permissionState.microphone = true
    permissionState.accessibility = true
    window.dispatchEvent(new Event('focus'))
    await flushPromises()

    expect(wrapper.find('[data-test="onboarding-view"]').exists()).toBe(true)

    await wrapper.find('[data-test="continue"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="settings-view"]').exists()).toBe(true)
  })
})
