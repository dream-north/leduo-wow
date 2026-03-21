import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import OnboardingView from './OnboardingView.vue'

describe('OnboardingView', () => {
  it('shows an accessibility hint when side-specific shortcuts require accessibility permission', async () => {
    const wrapper = mount(OnboardingView, {
      props: {
        permissions: {
          microphone: true,
          accessibility: false,
          screen: false
        },
        shortcuts: {
          transcription: 'RightCommand',
          assistant: 'RightOption'
        },
        enabledModes: {
          transcription: true,
          assistant: true
        },
        shortcutStatus: {
          permissionState: 'missing',
          backendState: 'disabled',
          reason: 'permission_missing',
          modes: {
            transcription: {
              mode: 'transcription',
              shortcut: 'RightCommand',
              backendState: 'disabled',
              reason: 'unsupported_without_accessibility',
              requiresAccessibility: true,
              canTriggerGlobally: false
            },
            assistant: {
              mode: 'assistant',
              shortcut: 'RightOption',
              backendState: 'disabled',
              reason: 'unsupported_without_accessibility',
              requiresAccessibility: true,
              canTriggerGlobally: false
            }
          }
        }
      }
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'MetaRight' }))
    await flushPromises()

    expect(wrapper.text()).toContain('当前快捷键需要辅助功能权限')
  })

  it('shows a global shortcut hint when Windows-style shortcut readiness is missing', async () => {
    const wrapper = mount(OnboardingView, {
      props: {
        permissions: {
          microphone: true,
          accessibility: true,
          screen: false
        },
        shortcuts: {
          transcription: 'RightAlt',
          assistant: 'RightControl'
        },
        enabledModes: {
          transcription: true,
          assistant: true
        },
        shortcutStatus: {
          permissionState: 'granted',
          backendState: 'disabled',
          reason: 'backend_failed',
          modes: {
            transcription: {
              mode: 'transcription',
              shortcut: 'RightAlt',
              backendState: 'disabled',
              reason: 'backend_failed',
              requiresAccessibility: false,
              canTriggerGlobally: false
            },
            assistant: {
              mode: 'assistant',
              shortcut: 'RightControl',
              backendState: 'disabled',
              reason: 'backend_failed',
              requiresAccessibility: false,
              canTriggerGlobally: false
            }
          }
        }
      }
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlRight' }))
    await flushPromises()

    expect(wrapper.text()).toContain('当前快捷键还没有全局生效')
  })

  it('disables continue until microphone and shortcut readiness are both satisfied', async () => {
    const wrapper = mount(OnboardingView, {
      props: {
        permissions: {
          microphone: true,
          accessibility: true,
          screen: true
        },
        shortcuts: {
          transcription: 'RightAlt',
          assistant: 'RightControl'
        },
        enabledModes: {
          transcription: true,
          assistant: true
        },
        shortcutStatus: {
          permissionState: 'granted',
          backendState: 'disabled',
          reason: 'backend_failed',
          modes: {
            transcription: {
              mode: 'transcription',
              shortcut: 'RightAlt',
              backendState: 'disabled',
              reason: 'backend_failed',
              requiresAccessibility: false,
              canTriggerGlobally: false
            },
            assistant: {
              mode: 'assistant',
              shortcut: 'RightControl',
              backendState: 'disabled',
              reason: 'backend_failed',
              requiresAccessibility: false,
              canTriggerGlobally: false
            }
          }
        }
      }
    })

    expect(wrapper.text()).toContain('全局快捷键可用性')
    expect(wrapper.text()).toContain('屏幕录制权限')

    const continueButton = wrapper.findAll('button').find((button) => button.text() === '继续进入设置')
    expect(continueButton).toBeDefined()
    expect(continueButton!.attributes('disabled')).toBeDefined()

    await continueButton!.trigger('click')
    expect(wrapper.emitted('continue')).toBeUndefined()
  })
})
