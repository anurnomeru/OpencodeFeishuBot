import type { FeishuConfig } from "./config"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { sendInteractiveCard, updateCard } from "./feishu/client"
import { getOverviewCardId, setOverviewCardId, clearOverviewCardId } from "./store"
import { getOpenCodeStatus, type SessionInfo } from "./sdk-client"

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogFn = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void

export class OverviewManager {
  private config: FeishuConfig
  private client: OpencodeClient
  private log: LogFn
  private initialized = false

  constructor(
    config: FeishuConfig,
    client: OpencodeClient,
    log: LogFn
  ) {
    this.config = config
    this.client = client
    this.log = log
  }

  async init(): Promise<void> {
    if (this.initialized) return
    
    console.log("[Overview] Initializing...")
    
    const existingCardId = getOverviewCardId()
    if (existingCardId) {
      console.log("[Overview] Found existing card, updating...")
      try {
        await this.updateCard(existingCardId)
      } catch {
        console.log("[Overview] Failed to update existing card, creating new one")
        clearOverviewCardId()
        await this.createCard()
      }
    } else {
      await this.createCard()
    }
    
    this.initialized = true
    console.log("[Overview] Initialized successfully")
  }

  private async createCard(): Promise<void> {
    const status = await getOpenCodeStatus(this.client)
    const card = this.buildCard(status)
    
    const response = await sendInteractiveCard(this.config, card)
    const cardId = response.data?.message_id
    
    if (cardId) {
      setOverviewCardId(cardId)
      console.log("[Overview] Card created:", cardId)
      this.log('info', 'Overview card created', { cardId })
    }
  }

  private async updateCard(cardId: string): Promise<void> {
    const status = await getOpenCodeStatus(this.client)
    const card = this.buildCard(status)
    
    await updateCard(this.config, cardId, card)
    console.log("[Overview] Card updated:", cardId)
    this.log('debug', 'Overview card updated', { cardId })
  }

  async refresh(): Promise<void> {
    console.log("[Overview] Refresh requested")
    
    const existingCardId = getOverviewCardId()
    if (existingCardId) {
      try {
        await this.updateCard(existingCardId)
        this.log('info', 'Overview card refreshed')
        return
      } catch {
        console.log("[Overview] Failed to update existing card, creating new one")
        clearOverviewCardId()
      }
    }
    
    await this.createCard()
    this.log('info', 'Overview card created')
  }

  private buildCard(status: { sessions: SessionInfo[]; project?: any; agents: string[] }): unknown {
    const busySessions = status.sessions.filter(s => s.status === 'busy')
    const idleSessions = status.sessions.filter(s => s.status === 'idle')
    const retrySessions = status.sessions.filter(s => s.status === 'retry')
    
    const elements: any[] = []
    
    elements.push({
      tag: 'markdown',
      content: '## 🤖 **OpenCode 任务总览**'
    })
    
    elements.push({
      tag: 'markdown',
      content: `更新时间: ${new Date().toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    })
    
    if (status.project?.name) {
      elements.push({
        tag: 'markdown',
        content: `📂 **项目**: ${status.project.name}${status.project.branch ? ` (${status.project.branch})` : ''}`
      })
    }
    
    elements.push({ tag: 'hr' })
    
    if (busySessions.length > 0) {
      elements.push({
        tag: 'markdown',
        content: `### 🔄 运行中 (${busySessions.length})`
      })
      
      for (const session of busySessions.slice(0, 3)) {
        const sessionTitle = session.title || '未命名会话';
        let content = `**${sessionTitle}**\n`;
        
        if (session.progress) {
          const p = session.progress;
          const bar = this.buildProgressBar(p.percentage);
          content += `进度: ${bar} ${p.percentage}% (${p.completed}/${p.total})\n`;
        }
        
        if (session.currentAction) {
          content += `当前: ▶️ ${session.currentAction.slice(0, 40)}\n`;
        }
        
        if (session.recentActions && session.recentActions.length > 0) {
          const actions = session.recentActions.slice(-2).map(a => `✅ ${a.slice(0, 25)}`).join('\n');
          content += `已完成:\n${actions}`;
        }
        
        elements.push({
          tag: 'markdown',
          content
        });
        elements.push({ tag: 'hr' });
      }
      
      if (busySessions.length > 3) {
        elements.push({
          tag: 'markdown',
          content: `... 还有 ${busySessions.length - 3} 个任务运行中`
        })
      }
    }
    
    if (retrySessions.length > 0) {
      elements.push({ tag: 'hr' })
      elements.push({
        tag: 'markdown',
        content: `### ⚠️ 重试中 (${retrySessions.length})`
      })
      
      for (const session of retrySessions.slice(0, 3)) {
        elements.push({
          tag: 'markdown',
          content: `**${session.title}**`
        })
      }
    }
    
    if (idleSessions.length > 0 && busySessions.length === 0) {
      elements.push({ tag: 'hr' })
      elements.push({
        tag: 'markdown',
        content: `### 💤 等待中 (${idleSessions.length})`
      })
      
      for (const session of idleSessions.slice(0, 3)) {
        elements.push({
          tag: 'markdown',
          content: `- ${session.title}`
        })
      }
    }
    
    if (status.sessions.length === 0) {
      elements.push({ tag: 'hr' })
      elements.push({
        tag: 'markdown',
        content: '### ✅ 当前无活跃任务'
      })
      elements.push({
        tag: 'markdown',
        content: '所有任务已完成或等待新任务开始'
      })
    }
    
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'note',
      elements: [{
        tag: 'plain_text',
        content: '💡 发送 /overview 刷新 | 回复通知卡片可交互'
      }]
    })
    
    return { elements }
  }

  private formatProgress(todos?: SessionInfo['todos']): string {
    if (!todos || todos.length === 0) {
      return '无具体任务'
    }
    
    const completed = todos.filter(t => t.status === 'completed').length
    const inProgress = todos.filter(t => t.status === 'in_progress').length
    const pending = todos.filter(t => t.status === 'pending').length
    const total = todos.length
    
    if (completed === total) {
      return `✅ ${completed}/${total} 完成`
    }
    
    if (inProgress > 0) {
      const currentTask = todos.find(t => t.status === 'in_progress')
      return `⏳ ${completed}/${total} 完成 | 正在: ${currentTask?.content?.slice(0, 30) || '...'}`
    }
    
    return `⏸️ ${completed}/${total} 完成 | ${pending} 待执行`
  }

  private buildProgressBar(percentage: number): string {
    const filled = Math.round(percentage / 10)
    const empty = 10 - filled
    return '█'.repeat(filled) + '░'.repeat(empty)
  }
}