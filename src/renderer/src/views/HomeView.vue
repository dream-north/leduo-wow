<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import SettingsView from './SettingsView.vue'
import OnboardingView from './OnboardingView.vue'

interface PermissionState {
  microphone: boolean
  accessibility: boolean
  screen: boolean
}

const loading = ref(true)
const permissions = ref<PermissionState>({
  microphone: false,
  accessibility: false,
  screen: false
})
const shortcuts = ref({
  transcription: 'RightCommand',
  assistant: 'RightOption'
})
const mustCompleteOnboarding = ref(false)
const isEnsuringBackend = ref(false)
let initialized = false

const hasRequiredPermissions = computed(() => permissions.value.microphone && permissions.value.accessibility)
const showOnboarding = computed(() => !loading.value && (!hasRequiredPermissions.value || mustCompleteOnboarding.value))

async function refreshState(): Promise<void> {
  try {
    const [nextPermissions, config] = await Promise.all([
      window.electronAPI.checkPermissions(),
      window.electronAPI.getConfig(),
      window.electronAPI.refreshShortcutStatus()
    ])

    permissions.value = nextPermissions
    shortcuts.value = {
      transcription: config.transcriptionShortcut ?? config.shortcut ?? 'RightCommand',
      assistant: config.assistantShortcut ?? 'RightOption'
    }

    // If accessibility is granted on first load, ensure native backend is ready
    if (nextPermissions.accessibility && !initialized) {
      await window.electronAPI.ensureNativeBackendReady()
      // Refresh status after backend is ready
      await window.electronAPI.refreshShortcutStatus()
    }

    if (!initialized) {
      initialized = true
      mustCompleteOnboarding.value = !(nextPermissions.microphone && nextPermissions.accessibility)
    } else if (!(nextPermissions.microphone && nextPermissions.accessibility)) {
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

  // Ensure native backend is ready before continuing
  if (permissions.value.accessibility) {
    isEnsuringBackend.value = true
    try {
      const ready = await window.electronAPI.ensureNativeBackendReady()
      if (!ready) {
        console.warn('[HomeView] Native backend not ready after multiple attempts')
      }
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
