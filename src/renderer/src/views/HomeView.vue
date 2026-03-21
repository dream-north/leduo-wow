<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import SettingsView from './SettingsView.vue'
import OnboardingView from './OnboardingView.vue'
import type { ShortcutServiceStatus } from '../../../shared/types'
import { getDefaultAssistantShortcut, getDefaultTranscriptionShortcut } from '../../../shared/types'
import { getRendererPlatform } from '../utils/platform'

interface PermissionState {
  microphone: boolean
  accessibility: boolean
  screen: boolean
}

const loading = ref(true)
const platform = getRendererPlatform()
const permissions = ref<PermissionState>({
  microphone: false,
  accessibility: false,
  screen: false
})
const shortcuts = ref({
  transcription: getDefaultTranscriptionShortcut(platform),
  assistant: getDefaultAssistantShortcut(platform)
})
const shortcutStatus = ref<ShortcutServiceStatus | null>(null)
const enabledModes = ref({
  transcription: true,
  assistant: true
})
const mustCompleteOnboarding = ref(false)
const isEnsuringBackend = ref(false)
let initialized = false

const hasGlobalShortcutsReady = computed(() => {
  if (!shortcutStatus.value) return false
  if (enabledModes.value.transcription && !shortcutStatus.value.modes.transcription.canTriggerGlobally) return false
  if (enabledModes.value.assistant && !shortcutStatus.value.modes.assistant.canTriggerGlobally) return false
  return true
})
const hasRequiredPermissions = computed(() => permissions.value.microphone && hasGlobalShortcutsReady.value)
const showOnboarding = computed(() => !loading.value && (!hasRequiredPermissions.value || mustCompleteOnboarding.value))

async function refreshState(): Promise<void> {
  try {
    const [nextPermissions, config, nextShortcutStatus] = await Promise.all([
      window.electronAPI.checkPermissions(),
      window.electronAPI.getConfig(),
      window.electronAPI.refreshShortcutStatus()
    ])

    permissions.value = nextPermissions
    shortcutStatus.value = nextShortcutStatus
    enabledModes.value = {
      transcription: config.transcriptionEnabled ?? true,
      assistant: config.assistantEnabled ?? true
    }
    shortcuts.value = {
      transcription: config.transcriptionShortcut ?? config.shortcut ?? getDefaultTranscriptionShortcut(platform),
      assistant: config.assistantShortcut ?? getDefaultAssistantShortcut(platform)
    }

    if (!initialized && (platform === 'win32' || nextPermissions.accessibility)) {
      await window.electronAPI.ensureNativeBackendReady()
      shortcutStatus.value = await window.electronAPI.refreshShortcutStatus()
    }

    if (!initialized) {
      initialized = true
      mustCompleteOnboarding.value = !(nextPermissions.microphone && hasGlobalShortcutsReady.value)
    } else if (!(nextPermissions.microphone && hasGlobalShortcutsReady.value)) {
      mustCompleteOnboarding.value = true
    }
  } finally {
    loading.value = false
  }
}

async function requestPermission(type: 'microphone' | 'accessibility' | 'screen'): Promise<void> {
  await window.electronAPI.requestPermission(type)
  await refreshState()
}

async function continueToSettings(): Promise<void> {
  if (!hasRequiredPermissions.value) return

  if (platform === 'darwin' && permissions.value.accessibility) {
    isEnsuringBackend.value = true
    try {
      await window.electronAPI.ensureNativeBackendReady()
    } finally {
      isEnsuringBackend.value = false
    }
  }

  mustCompleteOnboarding.value = false
}

function handleWindowFocus(): void {
  void refreshState()
}

onMounted(async () => {
  await refreshState()
  window.addEventListener('focus', handleWindowFocus)
  document.addEventListener('visibilitychange', handleWindowFocus)
})

onUnmounted(() => {
  window.removeEventListener('focus', handleWindowFocus)
  document.removeEventListener('visibilitychange', handleWindowFocus)
})
</script>

<template>
  <div v-if="loading" class="home-loading"></div>
  <OnboardingView
    v-else-if="showOnboarding"
    :permissions="permissions"
    :shortcuts="shortcuts"
    :shortcut-status="shortcutStatus"
    :enabled-modes="enabledModes"
    :is-ensuring-backend="isEnsuringBackend"
    @request-permission="requestPermission"
    @refresh="refreshState"
    @continue="continueToSettings"
  />
  <SettingsView v-else />
</template>

<style scoped>
.home-loading {
  min-height: 100vh;
  background: #f5f5f7;
}
</style>
