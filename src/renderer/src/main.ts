import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import SettingsView from './views/SettingsView.vue'
import './styles/main.css'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', component: SettingsView }]
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
