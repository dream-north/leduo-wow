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

      <div class="permission-grid">
        <section class="permission-panel required">
          <div class="panel-header">
            <div>
              <h2>麦克风权限</h2>
              <p>用于录音和语音识别，是必需权限。</p>
            </div>
            <span :class="['panel-badge', props.permissions.microphone ? 'ready' : 'missing']">
              {{ props.permissions.microphone ? '已授权' : '未授权' }}
            </span>
          </div>
          <button v-if="!props.permissions.microphone" class="btn btn-primary" @click="emit('requestPermission', 'microphone')">
            授予麦克风权限
          </button>
        </section>

        <section class="permission-panel required">
          <div class="panel-header">
            <div>
              <h2>辅助功能权限</h2>
              <p>用于全局快捷键与自动输入，是必需权限。</p>
            </div>
            <span :class="['panel-badge', props.permissions.accessibility ? 'ready' : 'missing']">
              {{ props.permissions.accessibility ? '已授权' : '未授权' }}
            </span>
          </div>
          <button v-if="!props.permissions.accessibility" class="btn btn-primary" @click="emit('requestPermission', 'accessibility')">
            打开辅助功能授权
          </button>
          <p class="panel-note">
            当前快捷键：`{{ props.shortcuts.transcription }}` / `{{ props.shortcuts.assistant }}`
          </p>
        </section>

        <section class="permission-panel optional">
          <div class="panel-header">
            <div>
              <h2>屏幕录制权限</h2>
              <p>仅用于截图辅助润色和语音助手上下文，不是必需权限。</p>
            </div>
            <span :class="['panel-badge', props.permissions.screen ? 'ready' : 'optional']">
              {{ props.permissions.screen ? '已授权' : '可稍后设置' }}
            </span>
          </div>
          <button v-if="!props.permissions.screen" class="btn btn-secondary" @click="emit('requestPermission', 'screen')">
            先去配置
          </button>
        </section>
      </div>

      <div class="onboarding-footer">
        <div class="footer-actions">
          <button class="btn btn-secondary" @click="emit('refresh')">重新检测权限</button>
          <button class="btn btn-primary" :disabled="!canContinue" @click="emit('continue')">
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
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background:
    radial-gradient(circle at top left, rgba(0, 113, 227, 0.14), transparent 34%),
    radial-gradient(circle at bottom right, rgba(52, 199, 89, 0.12), transparent 30%),
    linear-gradient(135deg, #f5f5f7, #ececf2);
}

.onboarding-card {
  width: min(980px, 100%);
  padding: 32px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(24px);
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
}

.onboarding-hero {
  margin-bottom: 24px;
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-color);
  margin-bottom: 8px;
}

.onboarding-hero h1 {
  font-size: 32px;
  line-height: 1.1;
  margin-bottom: 10px;
}

.lead {
  max-width: 640px;
  color: var(--text-secondary);
  font-size: 15px;
}

.permission-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.permission-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.95), rgba(245, 247, 250, 0.9));
}

.permission-panel.required {
  border-color: rgba(0, 113, 227, 0.12);
}

.permission-panel.optional {
  border-style: dashed;
}

.panel-header {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.panel-header h2 {
  font-size: 18px;
}

.panel-header p,
.panel-note {
  font-size: 13px;
  color: var(--text-secondary);
}

.panel-badge {
  align-self: flex-start;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
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
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.footer-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.permission-hint {
  color: var(--warning-color);
  font-size: 13px;
}

@media (max-width: 900px) {
  .permission-grid {
    grid-template-columns: 1fr;
  }

  .onboarding-card {
    padding: 24px;
  }

  .onboarding-hero h1 {
    font-size: 26px;
  }

  .footer-actions {
    flex-direction: column;
  }
}
</style>
