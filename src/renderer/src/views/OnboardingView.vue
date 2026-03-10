<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

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
}>()

const emit = defineEmits<{
  requestPermission: [type: 'microphone' | 'accessibility' | 'screen']
  refresh: []
  continue: []
}>()

const canContinue = computed(() => props.permissions.microphone && props.permissions.accessibility)
const permissionHint = ref('')
let clearHintTimer: ReturnType<typeof setTimeout> | null = null

const codeToShortcut: Record<string, string> = {
  MetaLeft: 'LeftCommand',
  MetaRight: 'RightCommand',
  AltLeft: 'LeftOption',
  AltRight: 'RightOption',
  ControlLeft: 'LeftControl',
  ControlRight: 'RightControl',
  ShiftLeft: 'LeftShift',
  ShiftRight: 'RightShift'
}

function showPermissionHint(): void {
  permissionHint.value = '当前快捷键需要辅助功能权限。授权后返回应用，无需重启。'
  if (clearHintTimer) {
    clearTimeout(clearHintTimer)
  }
  clearHintTimer = setTimeout(() => {
    permissionHint.value = ''
  }, 2500)
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.permissions.accessibility) return

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
      <div class="onboarding-hero">
        <p class="eyebrow">首次使用引导</p>
        <h1>先完成权限配置，才能开始语音输入</h1>
        <p class="lead">
          乐多汪汪至少需要麦克风和辅助功能权限。屏幕录制权限只影响截图增强，不阻止你开始使用。
        </p>
      </div>

      <section class="permission-section required-group">
        <div class="section-heading">
          <div>
            <p class="section-kicker">必需权限</p>
            <h2>先完成这两项，才能开始使用</h2>
          </div>
          <p class="section-summary">{{ canContinue ? '已满足使用条件' : '缺少必需权限，继续按钮会保持禁用' }}</p>
        </div>

        <div class="permission-grid">
          <section class="permission-panel required">
            <div class="panel-header">
              <div class="panel-copy">
                <h3>麦克风权限</h3>
                <p>用于录音和语音识别，是必需权限。</p>
              </div>
              <span :class="['panel-badge', props.permissions.microphone ? 'ready' : 'missing']">
                {{ props.permissions.microphone ? '已授权' : '未授权' }}
              </span>
            </div>
            <div v-if="!props.permissions.microphone" class="panel-actions">
              <button class="btn btn-primary" @click="emit('requestPermission', 'microphone')">授予麦克风权限</button>
            </div>
          </section>

          <section class="permission-panel required">
            <div class="panel-header">
              <div class="panel-copy">
                <h3>辅助功能权限</h3>
                <p>用于全局快捷键与自动输入，是必需权限。</p>
              </div>
              <span :class="['panel-badge', props.permissions.accessibility ? 'ready' : 'missing']">
                {{ props.permissions.accessibility ? '已授权' : '未授权' }}
              </span>
            </div>
            <div class="panel-actions">
              <button v-if="!props.permissions.accessibility" class="btn btn-primary" @click="emit('requestPermission', 'accessibility')">
                打开辅助功能授权
              </button>
            </div>
          </section>
        </div>
      </section>

      <section class="permission-section optional-group">
        <div class="section-heading">
          <div>
            <p class="section-kicker optional">可选增强</p>
            <h2>这项不是必需的，后面再开也可以</h2>
          </div>
          <p class="section-summary">只影响截图辅助润色和语音助手上下文</p>
        </div>

        <section class="permission-panel optional">
          <div class="panel-header">
            <div class="panel-copy">
              <h3>屏幕录制权限</h3>
              <p>仅用于截图辅助润色和语音助手上下文，不是必需权限。</p>
            </div>
            <span :class="['panel-badge', props.permissions.screen ? 'ready' : 'optional']">
              {{ props.permissions.screen ? '已授权' : '可稍后设置' }}
            </span>
          </div>
          <div v-if="!props.permissions.screen" class="panel-actions">
            <button class="btn btn-secondary" @click="emit('requestPermission', 'screen')">先去配置</button>
          </div>
        </section>
      </section>

      <div class="onboarding-footer">
        <div class="footer-actions">
          <button class="btn btn-secondary" @click="emit('refresh')">重新检测权限</button>
          <button class="btn btn-primary" :disabled="!canContinue" @click="continueToSettings">
            继续进入设置
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
  background:
    radial-gradient(circle at top left, rgba(0, 113, 227, 0.14), transparent 34%),
    radial-gradient(circle at bottom right, rgba(52, 199, 89, 0.12), transparent 30%),
    linear-gradient(135deg, #f5f5f7, #ececf2);
}

.onboarding-card {
  width: min(980px, 100%);
  max-height: calc(100dvh - env(titlebar-area-height, 0px) - 68px);
  padding: 22px 20px 18px;
  border-radius: 24px;
  overflow: auto;
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(24px);
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
}

.onboarding-hero {
  margin-bottom: 18px;
}

.eyebrow {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-color);
  margin-bottom: 6px;
}

.onboarding-hero h1 {
  font-size: 26px;
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

.permission-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.permission-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.95), rgba(245, 247, 250, 0.9));
}

.permission-panel.required {
  border-color: rgba(0, 113, 227, 0.12);
}

.permission-panel.optional {
  border-style: dashed;
  border-color: rgba(110, 110, 115, 0.18);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.panel-copy {
  min-width: 0;
}

.panel-header h3 {
  font-size: 15px;
  margin-bottom: 2px;
}

.panel-header p {
  font-size: 12px;
  color: var(--text-secondary);
}

.panel-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.panel-actions .btn {
  padding-inline: 12px;
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

@media (max-width: 720px) {
  .onboarding-shell {
    align-items: flex-start;
    padding-top: calc(env(titlebar-area-height, 0px) + 28px);
    padding-left: 16px;
  }

  .permission-grid {
    grid-template-columns: 1fr;
  }

  .onboarding-card {
    padding: 18px 16px 14px;
  }

  .onboarding-hero h1 {
    font-size: 22px;
  }

  .section-heading,
  .panel-header,
  .panel-actions {
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
