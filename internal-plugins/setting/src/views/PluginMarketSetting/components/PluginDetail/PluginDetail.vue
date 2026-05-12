<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { PluginDetail as SharedPluginDetail } from '@/components'
import type { TabId } from '@/components'
import type { PluginDownloadState } from '../types'

const props = defineProps<{
  plugin: any
  isLoading?: boolean
  downloadState?: PluginDownloadState
  isRunning?: boolean
}>()

defineEmits<{
  (e: 'back'): void
  (e: 'open'): void
  (e: 'download'): void
  (e: 'upgrade'): void
  (e: 'uninstall'): void
  (e: 'kill'): void
  (e: 'open-folder'): void
  (e: 'package'): void
  (e: 'reload'): void
}>()

// Giscus 评论
const giscusRef = ref<HTMLDivElement>()
const showComments = ref(false)

function loadGiscus(): void {
  const container = giscusRef.value
  if (!container) return

  container.innerHTML = ''

  const script = document.createElement('script')
  script.src = 'https://giscus.app/client.js'
  script.setAttribute('data-repo', 'ZToolsCenter/ZTools')
  script.setAttribute('data-repo-id', 'R_kgDOQhlrNw')
  script.setAttribute('data-category', 'Comments')
  script.setAttribute('data-category-id', 'DIC_kwDOQhlrN84C4mww')
  script.setAttribute('data-mapping', 'specific')
  script.setAttribute('data-term', props.plugin.name || 'unknown')
  script.setAttribute('data-strict', '0')
  script.setAttribute('data-reactions-enabled', '1')
  script.setAttribute('data-emit-metadata', '0')
  script.setAttribute('data-input-position', 'bottom')
  script.setAttribute('data-theme', 'preferred_color_scheme')
  script.setAttribute('data-lang', 'zh-CN')
  script.setAttribute('crossorigin', 'anonymous')
  script.async = true

  container.appendChild(script)
}

function handleTabSwitch(tabId: TabId): void {
  showComments.value = tabId === 'comments'
  if (tabId === 'comments') {
    nextTick(() => loadGiscus())
  }
}
</script>

<template>
  <SharedPluginDetail
    :plugin="plugin"
    :is-loading="isLoading"
    :download-state="downloadState"
    :is-running="isRunning"
    :show-comments="true"
    :show-size="true"
    @back="$emit('back')"
    @open="$emit('open')"
    @download="$emit('download')"
    @upgrade="$emit('upgrade')"
    @uninstall="$emit('uninstall')"
    @kill="$emit('kill')"
    @open-folder="$emit('open-folder')"
    @package="$emit('package')"
    @reload="$emit('reload')"
    @tab-switch="handleTabSwitch"
  >
    <template #extra-tabs>
      <div v-if="showComments" class="tab-panel comments-panel">
        <div ref="giscusRef" class="giscus"></div>
      </div>
    </template>
  </SharedPluginDetail>
</template>

<style scoped>
.tab-panel {
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.comments-panel {
  padding: 0 12px;
}

.comments-panel :deep(.giscus-frame) {
  width: 100%;
  min-height: 360px;
  border: none;
}
</style>
