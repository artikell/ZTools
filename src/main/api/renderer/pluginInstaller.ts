import type { PluginManager } from '../../managers/pluginManager'
import type { PluginDevProjectsAPI } from './pluginDevProjects'
import { app, shell, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import * as tar from 'tar'
import AdmZip from 'adm-zip'
import { isValidZpx, extractZpx, readTextFromZpx, readFileFromZpx } from '../../utils/zpxArchive.js'
import { DownloadCancelledError, downloadFile } from '../../utils/download.js'
import { httpGet } from '../../utils/httpRequest.js'
import { sleep } from '../../utils/common.js'
import databaseAPI from '../shared/database'
import { openDialog } from '../../utils/windowUtils'

/** 插件的本地安装目录 */
const PLUGIN_DIR = path.join(app.getPath('userData'), 'plugins')
const MARKET_DOWNLOAD_PROGRESS_CHANNEL = 'plugin-market-download-progress'

type MarketDownloadStatus = 'downloading' | 'installing' | 'success' | 'error' | 'cancelled'

interface MarketDownloadProgressPayload {
  pluginName: string
  taskId: string
  status: MarketDownloadStatus
  progress: number | null
  receivedBytes?: number
  totalBytes?: number
  error?: string
}

interface MarketDownloadTask {
  pluginName: string
  taskId: string
  controller: AbortController
  webContents?: WebContents
}

// ━━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 插件安装器的外部依赖接口。
 * 通过依赖注入解耦与 PluginsAPI 主类，便于测试。
 */
export interface PluginInstallerDeps {
  /** 主窗口实例，用于弹出对话框 */
  readonly mainWindow: Electron.BrowserWindow | null
  /** 插件管理器实例，用于覆盖安装时终止旧插件 */
  readonly pluginManager: PluginManager | null
  /** 开发项目 API 实例，用于打包时委托调用 */
  readonly devProjects: PluginDevProjectsAPI
  /** 获取非内置插件列表 */
  getPlugins(): Promise<any[]>
  /** 读取当前已安装插件列表 */
  readInstalledPlugins(): any[]
  /** 写入已安装插件列表到数据库 */
  writeInstalledPlugins(plugins: any[]): void
  /** 通知渲染进程插件列表已变更 */
  notifyPluginsChanged(): void
  /** 校验插件配置的合法性 */
  validatePluginConfig(config: any, existing: any[]): { valid: boolean; error?: string }
}

// ━━━ PluginInstallerAPI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 插件安装器 API。
 * 负责 ZPX/ZIP/NPM/市场等多种来源的插件安装，以及插件打包和导出。
 * 通过 PluginInstallerDeps 依赖注入与主 PluginsAPI 解耦。
 */
export class PluginInstallerAPI {
  private marketDownloadTasks = new Map<string, MarketDownloadTask>()

  constructor(private deps: PluginInstallerDeps) {}

  /**
   * 选择插件文件（不安装，仅返回文件路径）。
   * 用于“导入本地插件”场景，先让用户选择文件再展示预览。
   * @returns {success: boolean, filePath?: string, error?: string}
   */
  public async selectPluginFile(): Promise<any> {
    try {
      const result = await openDialog(
        this.deps.mainWindow!,
        {
          title: '选择插件文件',
          filters: [{ name: '插件文件', extensions: ['zpx', 'zip'] }],
          properties: ['openFile']
        },
        '未选择文件'
      )

      if (!result.success) {
        return result
      }

      return { success: true, filePath: result.data!.filePaths[0] }
    } catch (error: unknown) {
      console.error('[Plugins] 选择插件文件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 导入 ZPX 插件（直接安装不预览）。
   * 保留用于兼容性，新流程应使用 selectPluginFile + installPluginFromPath。
   * @returns {success: boolean, plugin?: object, error?: string}
   */
  public async importPlugin(): Promise<any> {
    try {
      const result = await openDialog(
        this.deps.mainWindow!,
        {
          title: '选择插件文件',
          filters: [{ name: '插件文件', extensions: ['zpx', 'zip'] }],
          properties: ['openFile']
        },
        '未选择文件'
      )

      if (!result.success) {
        return result
      }

      return await this.installPluginFromPath(result.data!.filePaths[0])
    } catch (error: unknown) {
      console.error('[Plugins] 导入插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 从 ZPX 文件中读取插件信息（不安装）。
   * 用于安装前预览插件详情，logo 转换为 base64 data URL。
   * @param zpxPath - .zpx 文件的绝对路径
   * @returns {success: boolean, pluginInfo?: object, error?: string}
   */
  public async readPluginInfoFromZpx(zpxPath: string): Promise<any> {
    try {
      let config: any
      let isZpx: boolean
      try {
        ;({ config, isZpx } = await this.readPluginJson(zpxPath))
      } catch (e: any) {
        return { success: false, error: e.message }
      }

      // 尝试提取 logo 为 base64
      let logoBase64 = ''
      if (config.logo) {
        try {
          const logoBuffer: Buffer = isZpx
            ? await readFileFromZpx(zpxPath, config.logo)
            : (new AdmZip(zpxPath).readFile(config.logo) as Buffer)
          if (logoBuffer) {
            const ext = path.extname(config.logo).toLowerCase().replace('.', '')
            const mimeType =
              ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : `image/${ext}`
            logoBase64 = `data:${mimeType};base64,${logoBuffer.toString('base64')}`
          }
        } catch (error) {
          console.warn('[Plugins] 提取插件 logo 失败:', error)
        }
      }

      const existingPlugins = await this.deps.getPlugins()
      const isInstalled = existingPlugins.some((p: any) => p.name === config.name)

      return {
        success: true,
        pluginInfo: {
          name: config.name,
          title: config.title || config.name,
          version: config.version || '未知',
          description: config.description || '',
          author: config.author || '未知',
          logo: logoBase64,
          features: config.features || [],
          isInstalled
        }
      }
    } catch (error: unknown) {
      console.error('[Plugins] 读取插件信息失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  /**
   * 从指定文件路径安装插件（.zpx），支持覆盖已存在的插件。
   * 覆盖时会先终止运行中的插件、移除旧记录和目录，再执行全新安装。
   * @param zpxPath - .zpx 文件的绝对路径
   * @returns {success: boolean, plugin?: object, error?: string}
   */
  public async installPluginFromPath(filePath: string): Promise<any> {
    try {
      let config: any
      let isZpx: boolean
      try {
        ;({ config, isZpx } = await this.readPluginJson(filePath))
      } catch (e: any) {
        return { success: false, error: e.message }
      }

      const pluginName = config.name
      const pluginPath = path.join(PLUGIN_DIR, pluginName)

      // 覆盖安装：先清理旧版本
      const existingPlugins: any[] = databaseAPI.dbGet('plugins') || []
      const existingIndex = existingPlugins.findIndex((p: any) => p.name === pluginName)
      if (existingIndex !== -1) {
        console.log('[Plugins] 插件已存在，执行覆盖安装:', pluginName)
        try {
          this.deps.pluginManager?.killPluginByName(pluginName)
        } catch {
          // 忽略终止错误
        }
        existingPlugins.splice(existingIndex, 1)
        databaseAPI.dbPut('plugins', existingPlugins)
        try {
          await fs.rm(pluginPath, { recursive: true, force: true })
          console.log('[Plugins] 已删除旧插件目录:', pluginPath)
        } catch {
          // 忽略删除错误
        }
      }

      return await this.installFromPackageFile(filePath, isZpx, config)
    } catch (error: unknown) {
      console.error('[Plugins] 覆盖安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  /**
   * 从插件市场安装插件。
   * 流程：下载 .zpx 文件（最多重试 3 次）→ 自动检测 ZPX/ZIP 格式 → 安装 → 清理临时文件。
   * @param plugin - 市场插件对象，必须包含 name 和 downloadUrl 字段
   * @returns {success: boolean, plugin?: object, error?: string}
   */
  public async installPluginFromMarket(plugin: any, webContents?: WebContents): Promise<any> {
    const pluginName = plugin?.name
    if (!pluginName) {
      return { success: false, error: '无效的插件信息' }
    }

    if (this.marketDownloadTasks.has(pluginName)) {
      return { success: false, error: '该插件正在下载中' }
    }

    const safePluginName = String(pluginName).replace(/[\\/]/g, '_')
    const taskId = `${safePluginName}-${Date.now()}`
    const controller = new AbortController()
    const task: MarketDownloadTask = {
      pluginName,
      taskId,
      controller,
      webContents
    }
    this.marketDownloadTasks.set(pluginName, task)

    const tempDir = path.join(app.getPath('temp'), 'ztools-plugin-download', taskId)
    const tempFilePath = path.join(tempDir, `${safePluginName}.zpx`)

    try {
      console.log('[Plugins] 开始从市场安装插件:', pluginName)
      const downloadUrl = plugin.downloadUrl
      if (!downloadUrl) {
        return { success: false, error: '无效的下载链接' }
      }

      console.log('[Plugins] 插件下载链接:', downloadUrl)

      await fs.mkdir(tempDir, { recursive: true })
      this.emitMarketDownloadProgress(task, {
        pluginName,
        taskId,
        status: 'downloading',
        progress: 0
      })

      let retryCount = 0
      const maxRetries = 3
      while (retryCount < maxRetries) {
        try {
          await downloadFile(downloadUrl, tempFilePath, {
            signal: controller.signal,
            onProgress: (progress) => {
              this.emitMarketDownloadProgress(task, {
                pluginName,
                taskId,
                status: 'downloading',
                progress: progress.percent,
                receivedBytes: progress.receivedBytes,
                totalBytes: progress.totalBytes
              })
            }
          })
          break
        } catch (error) {
          if (error instanceof DownloadCancelledError || controller.signal.aborted) {
            throw error
          }
          retryCount++
          console.error(`下载失败，重试第 ${retryCount} 次:`, error)
          if (retryCount >= maxRetries) throw error
          await fs.rm(tempFilePath, { force: true })
          await sleep(500)
        }
      }

      console.log('[Plugins] 插件下载完成:', tempFilePath)
      this.emitMarketDownloadProgress(task, {
        pluginName,
        taskId,
        status: 'installing',
        progress: 100
      })

      // 自动检测格式并安装
      const { config: marketConfig, isZpx } = await this.readPluginJson(tempFilePath)
      console.log(`[Plugins] 市场插件格式: ${isZpx ? 'ZPX' : 'ZIP（兼容）'}`)

      // 覆盖安装：若插件已存在则先清理旧版本（不清除插件 LMDB 数据）
      const marketPluginName = marketConfig.name
      const marketPluginPath = path.join(PLUGIN_DIR, marketPluginName)
      const existingPluginsForMarket: any[] = databaseAPI.dbGet('plugins') || []
      const existingMarketIndex = existingPluginsForMarket.findIndex(
        (p: any) => p.name === marketPluginName
      )
      if (existingMarketIndex !== -1) {
        console.log('[Plugins] 插件已存在，执行覆盖升级（保留数据）:', marketPluginName)
        try {
          this.deps.pluginManager?.killPluginByName(marketPluginName)
        } catch {
          // 忽略终止错误
        }
        existingPluginsForMarket.splice(existingMarketIndex, 1)
        databaseAPI.dbPut('plugins', existingPluginsForMarket)
        try {
          await fs.rm(marketPluginPath, { recursive: true, force: true })
          console.log('[Plugins] 已删除旧插件目录:', marketPluginPath)
        } catch {
          // 忽略删除错误
        }
      }

      const result = await this.installFromPackageFile(tempFilePath, isZpx, marketConfig)
      this.emitMarketDownloadProgress(task, {
        pluginName,
        taskId,
        status: result.success ? 'success' : 'error',
        progress: result.success ? 100 : null,
        error: result.success ? undefined : result.error || '安装失败'
      })

      return result
    } catch (error: unknown) {
      if (error instanceof DownloadCancelledError || controller.signal.aborted) {
        console.log('[Plugins] 市场插件下载已取消:', pluginName)
        this.emitMarketDownloadProgress(task, {
          pluginName,
          taskId,
          status: 'cancelled',
          progress: null
        })
        return { success: false, cancelled: true, error: '已取消下载' }
      }

      console.error('[Plugins] 从市场安装插件失败:', error)
      const message = error instanceof Error ? error.message : '安装失败'
      this.emitMarketDownloadProgress(task, {
        pluginName,
        taskId,
        status: 'error',
        progress: null,
        error: message
      })
      return { success: false, error: message }
    } finally {
      this.marketDownloadTasks.delete(pluginName)
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.error('[Plugins] 清理下载临时文件失败:', e)
      }
    }
  }

  public cancelPluginMarketDownload(pluginNameOrTaskId: string): {
    success: boolean
    error?: string
  } {
    const task = this.findMarketDownloadTask(pluginNameOrTaskId)
    if (!task) {
      return { success: false, error: '没有找到正在下载的插件' }
    }

    task.controller.abort()
    return { success: true }
  }

  /**
   * 从 npm 安装插件
   * @param packageName npm 包名（支持作用域包，如 @ztools/example）
   * @param useChinaMirror 是否使用国内镜像（默认 false）
   */
  public async installPluginFromNpm(packageName: string, useChinaMirror = false): Promise<any> {
    try {
      console.log('[Plugins] 开始从 npm 安装插件:', packageName)

      // 1. 从 npm registry 获取包信息
      const registryBase = useChinaMirror
        ? 'https://registry.npmmirror.com'
        : 'https://registry.npmjs.org'
      const registryUrl = `${registryBase}/${packageName}`
      console.log('[Plugins] 获取包信息:', registryUrl, useChinaMirror ? '(国内镜像)' : '')

      let packageInfo: any
      try {
        const response = await httpGet(registryUrl)
        packageInfo = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
      } catch (error) {
        console.error('[Plugins] 获取包信息失败:', error)
        return { success: false, error: '无法获取包信息，请检查包名是否正确' }
      }

      // 2. 获取最新版本的 tarball URL
      const latestVersion = packageInfo['dist-tags']?.latest
      if (!latestVersion) {
        return { success: false, error: '无法获取最新版本信息' }
      }

      const versionInfo = packageInfo.versions?.[latestVersion]
      if (!versionInfo) {
        return { success: false, error: '无法获取版本详情' }
      }

      const tarballUrl = versionInfo.dist?.tarball
      if (!tarballUrl) {
        return { success: false, error: '无法获取下载链接' }
      }

      console.log('[Plugins] 最新版本:', latestVersion)
      console.log('[Plugins] Tarball URL:', tarballUrl)

      // 3. 创建临时目录并下载 tarball
      const tempDir = path.join(app.getPath('temp'), 'ztools-npm-download')
      await fs.mkdir(tempDir, { recursive: true })

      const tarballPath = path.join(tempDir, `${Date.now()}.tgz`)
      console.log('[Plugins] 下载 tarball 到:', tarballPath)

      let retryCount = 0
      const maxRetries = 3
      while (retryCount < maxRetries) {
        try {
          await downloadFile(tarballUrl, tarballPath)
          break
        } catch (error) {
          retryCount++
          console.error(`下载失败，重试第 ${retryCount} 次:`, error)
          if (retryCount >= maxRetries) throw error
          await sleep(500)
        }
      }

      // 4. 解压 tarball 到临时目录
      const extractDir = path.join(tempDir, `extract-${Date.now()}`)
      await fs.mkdir(extractDir, { recursive: true })

      console.log('[Plugins] 解压 tarball 到:', extractDir)
      await tar.extract({
        file: tarballPath,
        cwd: extractDir
      })

      // 5. npm tarball 的内容在 package/ 目录下
      const packageDir = path.join(extractDir, 'package')
      const pluginJsonPath = path.join(packageDir, 'plugin.json')

      // 6. 检查 plugin.json 是否存在
      try {
        await fs.access(pluginJsonPath)
      } catch {
        // 清理临时文件
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: '这不是一个有效的 ZTools 插件包（缺少 plugin.json）' }
      }

      // 7. 读取并验证 plugin.json
      const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8')
      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonContent)
      } catch {
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      const pluginName = pluginConfig.name
      const targetPath = path.join(PLUGIN_DIR, pluginName)

      // 8. 检查是否已安装（覆盖安装逻辑）
      const existingPlugins: any[] = databaseAPI.dbGet('plugins') || []
      const existingIndex = existingPlugins.findIndex((p: any) => p.name === pluginName)

      if (existingIndex !== -1) {
        console.log('[Plugins] 插件已存在，执行覆盖安装:', pluginName)

        // 终止正在运行的插件
        try {
          this.deps.pluginManager?.killPluginByName(pluginName)
        } catch {
          // 忽略终止错误
        }

        // 从数据库中移除旧记录
        existingPlugins.splice(existingIndex, 1)
        databaseAPI.dbPut('plugins', existingPlugins)

        // 删除旧目录
        try {
          await fs.rm(targetPath, { recursive: true, force: true })
          console.log('[Plugins] 已删除旧插件目录:', targetPath)
        } catch {
          // 忽略删除错误
        }
      }

      // 9. 移动到插件目录
      await fs.mkdir(PLUGIN_DIR, { recursive: true })
      await fs.rename(packageDir, targetPath)

      console.log('[Plugins] 插件已安装到:', targetPath)

      // 10. 验证插件配置
      const validation = this.deps.validatePluginConfig(pluginConfig, existingPlugins)
      if (!validation.valid) {
        // 安装失败，清理目录
        await fs.rm(targetPath, { recursive: true, force: true })
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: validation.error }
      }

      // 11. 保存到数据库
      const pluginInfo = this.persistPlugin(pluginConfig, targetPath, { installedFrom: 'npm' })

      // 12. 清理临时文件
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.error('[Plugins] 清理临时文件失败:', e)
      }

      // 13. 输出新增的指令
      this.logInstalledFeatures(pluginConfig, `从 npm 安装插件成功\nnpm 包名: ${packageName}`)

      this.deps.notifyPluginsChanged()
      return { success: true, plugin: pluginInfo }
    } catch (error: unknown) {
      console.error('[Plugins] 从 npm 安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  /**
   * 导出所有非开发、非内置插件到下载目录。
   * 导出后自动在 Finder/Explorer 中显示导出文件夹。
   * @returns {success: boolean, exportPath?: string, count?: number, error?: string}
   */
  public async exportAllPlugins(): Promise<{
    success: boolean
    exportPath?: string
    count?: number
    error?: string
  }> {
    try {
      const plugins: any = databaseAPI.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const { isBundledInternalPlugin } = await import('../../core/internalPlugins')
      const exportablePlugins = plugins.filter(
        (p: any) => !p.isDevelopment && !isBundledInternalPlugin(p.name)
      )

      if (exportablePlugins.length === 0) {
        return { success: false, error: '没有可导出的插件' }
      }

      const now = new Date()
      const pad = (n: number): string => String(n).padStart(2, '0')
      const timestamp =
        `${now.getFullYear()}` +
        `${pad(now.getMonth() + 1)}` +
        `${pad(now.getDate())}` +
        `${pad(now.getHours())}` +
        `${pad(now.getMinutes())}` +
        `${pad(now.getSeconds())}`

      const downloadsDir = app.getPath('downloads')
      const exportDir = path.join(downloadsDir, `ztools-plugins-${timestamp}`)

      await fs.mkdir(exportDir, { recursive: true })

      let successCount = 0
      for (const plugin of exportablePlugins) {
        const pluginPath: string = plugin.path
        const baseName: string = plugin.name || path.basename(pluginPath)
        const folderName: string = plugin.version ? `${baseName}-v${plugin.version}` : baseName
        const destPath = path.join(exportDir, folderName)
        try {
          await fs.cp(pluginPath, destPath, { recursive: true })
          successCount++
        } catch (err) {
          console.error(`[Plugins] 导出插件失败: ${folderName}`, err)
        }
      }

      shell.showItemInFolder(exportDir)

      console.log('[Plugins] 插件导出完成:', exportDir)
      return { success: true, exportPath: exportDir, count: successCount }
    } catch (error: unknown) {
      console.error('[Plugins] 导出所有插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '导出失败' }
    }
  }

  // ━━━ Private ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private findMarketDownloadTask(pluginNameOrTaskId: string): MarketDownloadTask | undefined {
    const directTask = this.marketDownloadTasks.get(pluginNameOrTaskId)
    if (directTask) return directTask

    for (const task of this.marketDownloadTasks.values()) {
      if (task.taskId === pluginNameOrTaskId) return task
    }

    return undefined
  }

  private emitMarketDownloadProgress(
    task: MarketDownloadTask,
    payload: MarketDownloadProgressPayload
  ): void {
    const target = task.webContents?.isDestroyed() ? undefined : task.webContents
    const fallback = this.deps.mainWindow?.webContents
    const sender = target || (fallback && !fallback.isDestroyed() ? fallback : undefined)

    sender?.send(MARKET_DOWNLOAD_PROGRESS_CHANNEL, payload)
  }

  /**
   * 从插件包文件（ZPX 或 ZIP）中读取并解析 plugin.json，同时返回格式标识。
   * @throws 若 plugin.json 缺失、解析失败或缺少 name 字段则抛出带描述的 Error
   */
  private async readPluginJson(filePath: string): Promise<{ config: any; isZpx: boolean }> {
    const isZpx = await isValidZpx(filePath)
    let content: string
    try {
      if (isZpx) {
        content = await readTextFromZpx(filePath, 'plugin.json')
      } else {
        const zip = new AdmZip(filePath)
        content = zip.readAsText('plugin.json')
        if (!content) throw new Error()
      }
    } catch {
      throw new Error('无效的插件文件：缺少 plugin.json')
    }
    let config: any
    try {
      config = JSON.parse(content)
    } catch {
      throw new Error('无效的插件文件：plugin.json 格式错误')
    }
    if (!config.name) throw new Error('无效的插件文件：缺少 name 字段')
    return { config, isZpx }
  }

  /**
   * 将插件包文件（ZPX 或 ZIP）解压到指定目录。
   */
  private async extractToDir(filePath: string, isZpx: boolean, targetDir: string): Promise<void> {
    if (isZpx) {
      await extractZpx(filePath, targetDir)
    } else {
      new AdmZip(filePath).extractAllTo(targetDir, true)
    }
  }

  /**
   * 根据插件配置构建 pluginInfo 对象，写入数据库并返回该对象。
   */
  private persistPlugin(config: any, pluginPath: string, extra?: Record<string, any>): any {
    const pluginInfo = {
      name: config.name,
      title: config.title,
      version: config.version,
      description: config.description || '',
      author: config.author || '',
      homepage: config.homepage || '',
      logo: config.logo ? pathToFileURL(path.join(pluginPath, config.logo)).href : '',
      main: config.main,
      preload: config.preload,
      features: config.features,
      path: pluginPath,
      isDevelopment: false,
      installedAt: new Date().toISOString(),
      ...extra
    }
    let plugins: any = databaseAPI.dbGet('plugins')
    if (!plugins) plugins = []
    plugins.push(pluginInfo)
    databaseAPI.dbPut('plugins', plugins)
    return pluginInfo
  }

  /**
   * 将插件包安装到插件目录（核心安装逻辑，不做覆盖预处理）。
   * @param filePath - 插件包路径（ZPX 或 ZIP）
   * @param isZpx - 是否为 ZPX 格式（由 readPluginJson 返回）
   * @param pluginConfig - 已解析的 plugin.json 配置
   * @param extra - 写入数据库时附加的额外字段（如 installedFrom）
   */
  private async installFromPackageFile(
    filePath: string,
    isZpx: boolean,
    pluginConfig: any,
    extra?: Record<string, any>
  ): Promise<any> {
    await fs.mkdir(PLUGIN_DIR, { recursive: true })

    try {
      const pluginPath = path.join(PLUGIN_DIR, pluginConfig.name)

      // 检查目录是否已存在
      try {
        await fs.access(pluginPath)
        return { success: false, error: '插件目录已存在' }
      } catch {
        // 不存在，继续
      }

      // 检查插件记录是否已存在
      const existingPlugins = await this.deps.getPlugins()
      if (existingPlugins.some((p: any) => p.name === pluginConfig.name)) {
        return { success: false, error: '插件已存在' }
      }

      // 验证插件配置
      const validation = this.deps.validatePluginConfig(pluginConfig, existingPlugins)
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }

      // 解压到目标目录
      await this.extractToDir(filePath, isZpx, pluginPath)

      // 保存到数据库
      const pluginInfo = this.persistPlugin(pluginConfig, pluginPath, extra)
      this.logInstalledFeatures(pluginConfig)
      this.deps.notifyPluginsChanged()
      return { success: true, plugin: pluginInfo }
    } catch (error: unknown) {
      console.error('[Plugins] 安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  /**
   * 输出新安装插件的功能指令列表到控制台。
   * @param pluginConfig - 插件配置对象（包含 name、version、features）
   * @param header - 可选的日志标题（默认“新增插件指令”）
   */
  private logInstalledFeatures(pluginConfig: any, header?: string): void {
    console.log(`[Plugins] \n=== ${header || '新增插件指令'} ===`)
    console.log(`插件名称: ${pluginConfig.name}`)
    console.log(`插件版本: ${pluginConfig.version}`)
    console.log('[Plugins] 新增指令列表:')
    pluginConfig.features?.forEach((feature: any, index: number) => {
      console.log(`  [${index + 1}] ${feature.code} - ${feature.explain || '无说明'}`)

      const formattedCmds = feature.cmds
        .map((cmd: any) => {
          if (typeof cmd === 'string') {
            return cmd
          } else if (typeof cmd === 'object' && cmd !== null) {
            const type = cmd.type || 'unknown'
            const label = cmd.label || type
            return `[${type}] ${label}`
          }
          return String(cmd)
        })
        .join(', ')

      console.log(`      关键词: ${formattedCmds}`)
    })
    console.log('[Plugins] =========================\n')
  }
}
