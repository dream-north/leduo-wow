import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import OnboardingView from './OnboardingView.vue'

describe('OnboardingView', () => {
  it('shows a permission hint when the configured right-side shortcut is pressed without accessibility permission', async () => {
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
        }
      }
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'MetaRight' }))
    await flushPromises()

    expect(wrapper.text()).toContain('当前快捷键需要辅助功能权限')
  })

  it('does not show the shortcut hint once accessibility permission is granted', async () => {
    const wrapper = mount(OnboardingView, {
      props: {
        permissions: {
          microphone: true,
          accessibility: true,
          screen: false
        },
        shortcuts: {
          transcription: 'RightCommand',
          assistant: 'RightOption'
        }
      }
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'MetaRight' }))
    await flushPromises()

    expect(wrapper.text()).not.toContain('当前快捷键需要辅助功能权限')
  })

  it('groups required and optional permissions and disables continue until required permissions are granted', async () => {
    const wrapper = mount(OnboardingView, {
      props: {
        permissions: {
          microphone: true,
          accessibility: false,
          screen: true
        },
        shortcuts: {
          transcription: 'RightCommand',
          assistant: 'RightOption'
        }
      }
    })

    expect(wrapper.text()).toContain('必需权限')
    expect(wrapper.text()).toContain('可选增强')

    const continueButton = wrapper.findAll('button').find((button) => button.text() === '继续进入设置')
    expect(continueButton).toBeDefined()
    expect(continueButton!.attributes('disabled')).toBeDefined()

    await continueButton!.trigger('click')

    expect(wrapper.emitted('continue')).toBeUndefined()
  })
})
