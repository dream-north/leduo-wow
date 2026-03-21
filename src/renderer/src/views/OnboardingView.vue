<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ShortcutServiceStatus } from '../../../shared/types'
import { getRendererPlatform } from '../utils/platform'

interface PermissionState {
  microphone: boolean
  accessibility: boolean
  screen: boolean
}

const props = defineProps<{
  permissions: PermissionState
  shortcuts: {
    transcription: string
    assistant: string
  }
  shortcutStatus: ShortcutServiceStatus | null
  enabledModes: {
    transcription: boolean
    assistant: boolean
  }
  isEnsuringBackend?: boolean
}>()

const emit = defineEmits<{
  requestPermission: [type: 'microphone' | 'accessibility' | 'screen']
  refresh: []
  continue: []
}>()

const shortcutsReady = computed(() => {
  if (!props.shortcutStatus) return false
  if (props.enabledModes.transcription && !props.shortcutStatus.modes.transcription.canTriggerGlobally) return false
  if (props.enabledModes.assistant && !props.shortcutStatus.modes.assistant.canTriggerGlobally) return false
  return true
})

const requiresAccessibility = computed(() => {
  if (!props.shortcutStatus) return false
  if (props.enabledModes.transcription && props.shortcutStatus.modes.transcription.requiresAccessibility) return true
  if (props.enabledModes.assistant && props.shortcutStatus.modes.assistant.requiresAccessibility) return true
  return false
})

const canContinue = computed(() => props.permissions.microphone && shortcutsReady.value && !props.isEnsuringBackend)
const requiredGrantedCount = computed(() => Number(props.permissions.microphone) + Number(shortcutsReady.value))
const permissionHint = ref('')
const platform = getRendererPlatform()
let clearHintTimer: ReturnType<typeof setTimeout> | null = null

const codeToShortcut: Record<string, string> = {
  MetaLeft: 'LeftCommand',
  MetaRight: 'RightCommand',
  AltLeft: platform === 'win32' ? 'LeftAlt' : 'LeftOption',
  AltRight: platform === 'win32' ? 'RightAlt' : 'RightOption',
  ControlLeft: 'LeftControl',
  ControlRight: 'RightControl',
  ShiftLeft: 'LeftShift',
  ShiftRight: 'RightShift'
}
const showScreenPermission = platform === 'darwin'

function showPermissionHint(): void {
  permissionHint.value = requiresAccessibility.value
    ? '当前快捷键需要辅助功能权限。授权后返回应用，无需重启。'
    : '当前快捷键还没有全局生效，请刷新检查，或改成未被其他程序占用的快捷键。'
  if (clearHintTimer) {
    clearTimeout(clearHintTimer)
  }
  clearHintTimer = setTimeout(() => {
    permissionHint.value = ''
  }, 2500)
}

function handleKeydown(event: KeyboardEvent): void {
  if (shortcutsReady.value) return

  const mapped = codeToShortcut[event.code]
  if (!mapped) return

  if (mapped === props.shortcuts.transcription || mapped === props.shortcuts.assistant) {
    showPermissionHint()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (clearHintTimer) {
    clearTimeout(clearHintTimer)
  }
})

function continueToSettings(): void {
  if (!canContinue.value) return
  emit('continue')
}
</script>

<template>
  <div class="onboarding-shell">
    <div class="onboarding-card">
      <div class="onboarding-header">
        <div class="app-mark" aria-hidden="true">
          <span class="app-mark-label">LW</span>
        </div>
        <div class="onboarding-hero">
          <p class="eyebrow">欢迎使用乐多汪汪</p>
          <h1>授予权限后即可开始语音输入</h1>
          <p class="lead">建议先完成必需项，截图相关能力后续可以按需开启。</p>
        </div>
        <div class="setup-progress" :class="canContinue ? 'ready' : ''">
          <p class="setup-label">设置进度</p>
          <p class="setup-value">{{ requiredGrantedCount }}/2 必需项已完成</p>
        </div>
      </div>

      <section class="permission-section required-group">
        <div class="section-heading">
          <div>
            <p class="section-kicker">必需项</p>
            <h2>先完成这两项，才能继续</h2>
          </div>
          <p class="section-summary">{{ canContinue ? '已满足使用条件' : '缺少必需项，继续按钮会保持禁用' }}</p>
        </div>

        <div class="permission-list">
          <section class="permission-row required">
            <div class="permission-icon" aria-hidden="true">🎙️</div>
            <div class="permission-copy">
              <h3>麦克风权限</h3>
              <p>用于录音和语音识别，是必需权限。</p>
            </div>
            <span :class="['panel-badge', props.permissions.microphone ? 'ready' : 'missing']">
              {{ props.permissions.microphone ? '已授权' : '未授权' }}
            </span>
            <button
              v-if="!props.permissions.microphone"
              class="btn btn-primary"
              @click="emit('requestPermission', 'microphone')"
            >
              授予权限
            </button>
          </section>

          <section class="permission-row required">
            <div class="permission-icon" aria-hidden="true">⌨️</div>
            <div class="permission-copy">
              <h3>{{ requiresAccessibility ? '辅助功能权限' : '全局快捷键可用性' }}</h3>
              <p>{{ requiresAccessibility ? '用于全局快捷键与自动输入，是必需权限。' : '要求已启用模式的快捷键可以被全局触发，是必需项。' }}</p>
            </div>
            <span :class="['panel-badge', shortcutsReady ? 'ready' : 'missing']">
              {{ shortcutsReady ? '已就绪' : '未就绪' }}
            </span>
            <button
              v-if="requiresAccessibility ? !props.permissions.accessibility : !shortcutsReady"
              class="btn btn-primary"
              @click="requiresAccessibility ? emit('requestPermission', 'accessibility') : emit('refresh')"
            >
              {{ requiresAccessibility ? '打开授权' : '重新检查' }}
            </button>
          </section>
        </div>
      </section>

      <section v-if="showScreenPermission" class="permission-section optional-group">
        <div class="section-heading">
          <div>
            <p class="section-kicker optional">可选增强</p>
            <h2>这项不是必需的，后面再开也可以</h2>
          </div>
          <p class="section-summary">只影响截图辅助润色和语音助手上下文</p>
        </div>

        <section class="permission-row optional">
          <div class="permission-icon" aria-hidden="true">🖥️</div>
          <div class="permission-copy">
            <h3>屏幕录制权限</h3>
            <p>仅用于截图辅助润色和语音助手上下文，不是必需权限。</p>
          </div>
          <span :class="['panel-badge', props.permissions.screen ? 'ready' : 'optional']">
            {{ props.permissions.screen ? '已授权' : '可稍后设置' }}
          </span>
          <button v-if="!props.permissions.screen" class="btn btn-secondary" @click="emit('requestPermission', 'screen')">
            先去配置
          </button>
        </section>
      </section>

      <div class="onboarding-footer">
        <div class="footer-actions">
          <button class="btn btn-secondary" @click="emit('refresh')">重新检测</button>
          <button class="btn btn-primary" :disabled="!canContinue" @click="continueToSettings">
            <span v-if="props.isEnsuringBackend" class="btn-loading"></span>
            {{ props.isEnsuringBackend ? '正在初始化...' : '继续进入设置' }}
          </button>
        </div>
        <p v-if="permissionHint" class="permission-hint">{{ permissionHint }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onboarding-shell {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: calc(env(titlebar-area-height, 0px) + 44px);
  padding-right: 16px;
  padding-bottom: 24px;
  padding-left: calc(env(titlebar-area-x, 0px) + 28px);
  background: #f5f5f7;
}

.onboarding-card {
  width: min(880px, 100%);
  max-height: calc(100dvh - env(titlebar-area-height, 0px) - 68px);
  padding: 20px 18px 16px;
  border-radius: 12px;
  overflow: auto;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.06);
}

.onboarding-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 14px;
  align-items: center;
  margin-bottom: 16px;
}

.app-mark {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  overflow: hidden;
}

.app-mark-label {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--accent-color);
}

.setup-progress {
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  padding: 8px 10px;
  min-width: 170px;
  background: #fafafa;
}

.setup-progress.ready {
  border-color: rgba(52, 199, 89, 0.4);
  background: rgba(52, 199, 89, 0.08);
}

.setup-label {
  margin-bottom: 2px;
  font-size: 11px;
  color: var(--text-secondary);
}

.setup-value {
  font-size: 13px;
  font-weight: 600;
}

.eyebrow {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-color);
  margin-bottom: 6px;
}

.onboarding-hero h1 {
  font-size: 24px;
  line-height: 1.1;
  margin-bottom: 6px;
}

.lead {
  max-width: 700px;
  color: var(--text-secondary);
  font-size: 13px;
}

.permission-section + .permission-section {
  margin-top: 14px;
}

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.section-kicker {
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-color);
}

.section-kicker.optional {
  color: #6e6e73;
}

.section-heading h2 {
  font-size: 15px;
}

.section-summary {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: right;
}

.permission-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.permission-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: #fafafa;
}

.permission-row.required {
  border-color: rgba(0, 113, 227, 0.15);
}

.permission-row.optional {
  border-style: dashed;
  border-color: rgba(0, 0, 0, 0.12);
}

.permission-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.04);
}

.permission-copy {
  min-width: 0;
}

.permission-copy h3 {
  font-size: 15px;
  margin-bottom: 2px;
}

.permission-copy p {
  font-size: 12px;
  color: var(--text-secondary);
}

.panel-badge {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.panel-badge.ready {
  background: rgba(52, 199, 89, 0.12);
  color: #22863a;
}

.panel-badge.missing {
  background: rgba(255, 149, 0, 0.15);
  color: #b26a00;
}

.panel-badge.optional {
  background: rgba(110, 110, 115, 0.12);
  color: var(--text-secondary);
}

.onboarding-footer {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}

.footer-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.footer-actions .btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.permission-hint {
  color: var(--warning-color);
  font-size: 12px;
  align-self: flex-start;
}

.btn-loading {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: #fff;
  animation: spin 0.8s linear infinite;
  vertical-align: middle;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 720px) {
  .onboarding-shell {
    align-items: flex-start;
    padding-top: calc(env(titlebar-area-height, 0px) + 28px);
    padding-left: 16px;
  }

  .onboarding-card {
    padding: 18px 16px 14px;
  }

  .onboarding-header {
    grid-template-columns: 1fr;
  }

  .onboarding-hero h1 {
    font-size: 22px;
  }

  .section-heading,
  .permission-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .footer-actions {
    flex-direction: column;
    width: 100%;
  }

  .footer-actions .btn {
    width: 100%;
  }
}
</style>
