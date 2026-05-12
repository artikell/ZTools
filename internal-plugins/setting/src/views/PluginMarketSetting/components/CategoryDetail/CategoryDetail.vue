<script setup lang="ts">
import { computed, ref } from 'vue'
import { DetailPanel } from '@/components'
import { shuffleArray } from '@/utils'
import { PluginCard } from '../PluginCard'
import { RefreshButton } from '../RefreshButton'
import type { Plugin, CategoryInfo, CategoryLayoutSection, PluginDownloadState } from '../types'

const props = defineProps<{
  category: CategoryInfo
  layout: CategoryLayoutSection[]
  installingPlugin: string | null
  downloadStates: Record<string, PluginDownloadState | undefined>
  pluginMap: Map<string, Plugin>
  canUpgrade: (plugin: Plugin) => boolean
}>()

defineEmits<{
  (e: 'back'): void
  (e: 'click-plugin', plugin: Plugin): void
  (e: 'open-plugin', plugin: Plugin): void
  (e: 'download-plugin', plugin: Plugin): void
  (e: 'upgrade-plugin', plugin: Plugin): void
}>()

function interpolateTemplate(template: string): string {
  return template
    .replace(/\$\{title\}/g, props.category.title)
    .replace(/\$\{count\}/g, String(props.category.plugins.length))
}

interface ResolvedSection {
  key: string
  type: string
  title?: string
  plugins: Plugin[]
  count?: number
}

// 用于追踪 random 区块的刷新版本号
const randomVersion = ref(0)

const resolvedSections = computed<ResolvedSection[]>(() => {
  if (props.layout.length === 0) {
    return [{ key: 'all', type: 'list', plugins: props.category.plugins }]
  }

  const sections: ResolvedSection[] = []

  for (let i = 0; i < props.layout.length; i++) {
    const section = props.layout[i]
    const title = section.title ? interpolateTemplate(section.title) : undefined

    if (section.type === 'list') {
      sections.push({
        key: `list-${i}`,
        type: 'list',
        title,
        plugins: props.category.plugins
      })
    } else if (section.type === 'fixed') {
      const pluginNames = section.plugins || []
      const fixedPlugins = pluginNames
        .map((name) => props.pluginMap.get(name))
        .filter((p): p is Plugin => !!p)
      if (fixedPlugins.length > 0) {
        sections.push({ key: `fixed-${i}`, type: 'fixed', title, plugins: fixedPlugins })
      }
    } else if (section.type === 'random') {
      const count = section.count || 4
      // 分类详情页范围较小，从该分类的全部插件中随机选取，允许与 fixed 区块重复
      const shuffled = shuffleArray(props.category.plugins)
      sections.push({
        key: `random-${i}-${randomVersion.value}`,
        type: 'random',
        title,
        plugins: shuffled.slice(0, count),
        count
      })
    }
  }

  return sections
})

function shuffleSection(): void {
  randomVersion.value++
}
</script>
<template>
  <DetailPanel :title="category.title" @back="$emit('back')">
    <div class="category-detail-content">
      <div v-if="category.description" class="category-detail-header">
        <img
          v-if="category.icon"
          :src="category.icon"
          alt=""
          class="category-detail-icon"
          draggable="false"
        />
        <div class="category-detail-desc">{{ category.description }}</div>
      </div>

      <div v-for="section in resolvedSections" :key="section.key" class="category-detail-section">
        <div v-if="section.title || section.type === 'random'" class="section-header">
          <span v-if="section.title" class="storefront-title">{{ section.title }}</span>
          <RefreshButton v-if="section.type === 'random'" @click="shuffleSection()" />
        </div>
        <div class="market-grid">
          <PluginCard
            v-for="plugin in section.plugins"
            :key="plugin.name"
            :plugin="plugin"
            :installing-plugin="installingPlugin"
            :download-state="downloadStates[plugin.name]"
            :can-upgrade="canUpgrade(plugin)"
            @click="$emit('click-plugin', plugin)"
            @open="$emit('open-plugin', plugin)"
            @download="$emit('download-plugin', plugin)"
            @upgrade="$emit('upgrade-plugin', plugin)"
          />
        </div>
      </div>
    </div>
  </DetailPanel>
</template>

<style scoped>
.category-detail-content {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.category-detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 2px;
}

.category-detail-icon {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.category-detail-desc {
  font-size: 13px;
  color: var(--text-secondary);
}

.category-detail-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.storefront-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-color);
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
</style>
