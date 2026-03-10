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

    if (!initialized) {
      initialized = true
      mustCompleteOnboarding.value = !hasRequiredPermissions.value
    } else if (!hasRequiredPermissions.value) {
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

function continueToSettings(): void {
  if (!hasRequiredPermissions.value) return
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
    @request-permission="requestPermission"
    @refresh="refreshState"
    @continue="continueToSettings"
  />
  <SettingsView v-else />
</template>

<style scoped>
.home-loading {
  min-height: 100vh;
  background:
    linear-gradient(120deg, rgba(0, 113, 227, 0.06), transparent 30%),
    var(--bg-primary);
}
</style>
