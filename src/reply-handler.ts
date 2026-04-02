import * as Lark from '@larksuiteoapi/node-sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { FeishuConfig } from './config';
import type { OverviewManager } from './overview-manager';
import { getMapping, deleteMapping, isMessageProcessed, markMessageProcessed, setCurrentProject, getCurrentProject, getRecentProjects, addRecentProject } from './store';
import { promptSession, replyPermission, appendPrompt, submitPrompt, getOpenCodeStatus } from './sdk-client';

export class ReplyHandler {
  private feishuClient: Lark.Client;
  private opencodeClient: OpencodeClient;
  private log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
  private overviewManager: OverviewManager | null = null;

  constructor(
    feishuConfig: FeishuConfig,
    opencodeClient: OpencodeClient,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void
  ) {
    this.feishuClient = new Lark.Client({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
    this.opencodeClient = opencodeClient;
    this.log = log;
  }

  setOverviewManager(manager: OverviewManager): void {
    this.overviewManager = manager;
  }

  async handle(data: any): Promise<void> {
    try {
      const msg = data?.message;
      if (!msg) return;

      const messageId = msg.message_id;
      
      // Acknowledge receipt immediately with reaction
      if (messageId) {
        await this.addReaction(messageId, 'OK');
      }
      
      if (messageId && isMessageProcessed(messageId)) {
        return;
      }
      
      if (messageId) {
        markMessageProcessed(messageId);
      }

      const parentId = msg.parent_id;
      const chatId = msg.chat_id;
      const content = msg.content;

      const text = this.parseContent(content);

      if (parentId) {
        await this.handleReplyToNotification(parentId, text, chatId);
      } else {
        await this.handleDirectMessage(text, chatId);
      }

    } catch (error) {
      console.error("[Feishu] Handler error:", error);
    }
  }

  private async handleReplyToNotification(parentId: string, text: string, chatId: string): Promise<void> {
    const mapping = getMapping(parentId);
    
    if (!mapping) {
      await this.handleDirectMessage(text, chatId);
      return;
    }

    console.log(`[Feishu] Reply: ${mapping.actionType} -> ${mapping.sessionId.slice(0, 8)}`);

    switch (mapping.actionType) {
      case 'continue':
        await this.handleContinue(mapping.sessionId, text, chatId);
        break;
      case 'permission':
        await this.handlePermission(mapping.sessionId, mapping.permissionId, text, chatId);
        break;
      case 'question':
        await this.handleQuestion(mapping.sessionId, mapping.questionOptions || [], text, chatId);
        break;
      case 'input':
        await this.handleInput(mapping.sessionId, text, chatId);
        break;
    }

    deleteMapping(parentId);
  }

  private async handleDirectMessage(text: string, chatId: string): Promise<void> {

    const trimmedText = text.trim();

    if (trimmedText.startsWith('/')) {
      await this.handleSlashCommand(trimmedText, chatId);
    } else {
      const status = await getOpenCodeStatus(this.opencodeClient);
      
      const message = this.formatStatusMessage(status);
      const sessionButtons = this.buildSessionButtons(status);
      const quickActionButtons = this.buildQuickActionButtons();
      const card = this.buildEnhancedStatusCard(message, sessionButtons, quickActionButtons);
      await this.sendEnhancedCard(chatId, card);
      
      const busySessions = status.sessions.filter(s => s.status === 'busy');
      for (const session of busySessions) {
        const sessionCard = this.buildSessionDetailCard(session);
        await this.sendEnhancedCard(chatId, sessionCard);
      }
    }
  }

  private async handleSlashCommand(text: string, chatId: string): Promise<void> {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    console.log(`[Feishu] Slash command: ${command}, args: ${args.join(', ')}`);

    switch (command) {
      case '/help':
        await this.sendReply(chatId, this.formatHelpMessage());
        break;
      case '/status':
        const status = await getOpenCodeStatus(this.opencodeClient);
        const sessionButtons = this.buildSessionButtons(status);
        const quickActionButtons = this.buildQuickActionButtons();
        const card = this.buildEnhancedStatusCard(this.formatStatusMessage(status), sessionButtons, quickActionButtons);
        await this.sendEnhancedCard(chatId, card);
        break;
      case '/sessions':
        await this.handleSessionsCommand(chatId);
        break;
      case '/session':
        if (args.length === 0) {
          await this.sendReply(chatId, '用法: /session <session_id>');
        } else {
          await this.handleSessionCommand(args[0], chatId);
        }
        break;
      case '/todos':
        if (args.length === 0) {
          await this.handleAllTodosCommand(chatId);
        } else {
          await this.handleTodosCommand(args[0], chatId);
        }
        break;
      case '/messages':
        if (args.length === 0) {
          await this.sendReply(chatId, '用法: /messages <session_id>');
        } else {
          await this.handleMessagesCommand(args[0], chatId);
        }
        break;
      case '/project':
        await this.handleProjectCommand(chatId);
        break;
      case '/git':
        await this.handleGitCommand(chatId);
        break;
      case '/agents':
        await this.handleAgentsCommand(chatId);
        break;
      case '/prompt':
        if (args.length < 2) {
          await this.sendReply(chatId, '用法: /prompt <session_id> <消息内容>');
        } else {
          const sessionId = args[0];
          const promptText = args.slice(1).join(' ');
          await this.handlePromptCommand(sessionId, promptText, chatId);
        }
        break;
      case '/switch':
        if (args.length === 0) {
          await this.sendReply(chatId, '用法: /switch <项目路径>\n\n示例: /switch /Users/admin/my-project');
        } else {
          const projectPath = args[0];
          await this.handleSwitchCommand(projectPath, chatId);
        }
        break;
      case '/current':
        await this.handleCurrentCommand(chatId);
        break;
      case '/overview':
        await this.handleOverviewCommand(chatId);
        break;
      default:
        await this.sendReply(chatId, `未知命令: ${command}\n\n输入 /help 查看可用命令`);
    }
  }

  private formatHelpMessage(): string {
    const lines: string[] = [];
    lines.push('## 📖 可用命令');
    lines.push('');
    lines.push('### 会话管理');
    lines.push('- `/status` - 显示状态概览');
    lines.push('- `/overview` - 刷新任务总览');
    lines.push('- `/todos` - 显示所有运行中的任务');
    lines.push('- `/todos <id>` - 显示指定会话的任务');
    lines.push('- `/sessions` - 列出所有会话');
    lines.push('- `/session <id>` - 显示会话详情');
    lines.push('- `/messages <id>` - 显示会话消息');
    lines.push('- `/prompt <id> <text>` - 向会话发送消息');
    lines.push('');
    lines.push('### 项目管理');
    lines.push('- `/project` - 显示项目信息');
    lines.push('- `/switch <path>` - 切换关注项目');
    lines.push('- `/current` - 显示当前关注项目');
    lines.push('- `/git` - 显示 Git 状态');
    lines.push('- `/agents` - 显示可用 Agents');
    lines.push('');
    lines.push('💡 **快捷操作**：发送任意消息，点击按钮即可触发命令');
    return lines.join('\n');
  }

  private async handleSessionsCommand(chatId: string): Promise<void> {
    try {
      const response = await this.opencodeClient.session.list({});
      const sessions = (response as any)?.data || response || [];
      
      if (!Array.isArray(sessions) || sessions.length === 0) {
        await this.sendReply(chatId, '暂无活跃会话');
        return;
      }

      const statusResponse = await this.opencodeClient.session.status({});
      const statusMap = (statusResponse as any)?.data || statusResponse || {};

      const lines: string[] = [];
      lines.push('## 💬 活跃会话');
      lines.push('');
      lines.push(`总数: **${sessions.length}** 个`);
      lines.push('');

      const buttons: Array<{ text: string; value: string }> = [];
      
      for (const session of sessions.slice(0, 10)) {
        const s = session as any;
        const statusInfo = statusMap[s.id];
        const status = statusInfo?.type || 'idle';
        const statusIcon = status === 'idle' ? '💤' : status === 'busy' ? '🔄' : '⚠️';
        
        lines.push(`**${statusIcon} ${s.title || s.id}**`);
        lines.push(`- ID: ${s.id}`);
        lines.push(`- 状态: ${status}`);
        lines.push('');
        
        const shortTitle = (s.title || s.id).slice(0, 12);
        buttons.push({
          text: `${statusIcon} ${shortTitle}`,
          value: `session:${s.id}`
        });
      }

      if (sessions.length > 10) {
        lines.push(`... 还有 ${sessions.length - 10} 个会话`);
      }

      lines.push('');
      lines.push('> 💡 点击按钮查看会话详情');

      await this.sendInteractiveCard(chatId, lines.join('\n'), buttons.slice(0, 6));
    } catch (error: any) {
      console.error('[Feishu] /sessions failed:', error.message);
      await this.sendReply(chatId, `❌ 获取会话列表失败: ${error.message}`);
    }
  }

  private async handleSessionCommand(sessionId: string, chatId: string): Promise<void> {
    try {
      const response = await this.opencodeClient.session.get({ path: { id: sessionId } });
      const session = (response as any)?.data || response;
      
      if (!session) {
        await this.sendReply(chatId, `会话 ${sessionId} 不存在`);
        return;
      }

      const s = session as any;
      const lines: string[] = [];
      lines.push('## 💬 会话详情');
      lines.push('');
      lines.push(`- **ID**: ${s.id}`);
      lines.push(`- **标题**: ${s.title || '无'}`);
      lines.push(`- **状态**: ${s.status || 'unknown'}`);
      if (s.agent) lines.push(`- **Agent**: ${s.agent}`);
      if (s.parentID) lines.push(`- **父会话**: ${s.parentID}`);
      if (s.worktree) lines.push(`- **工作目录**: ${s.worktree}`);
      lines.push('');
      lines.push('> 💡 点击下方按钮快速操作');
      
      const buttons = [
        { text: '▶️ 继续执行', value: `prompt:${sessionId}:继续执行` },
        { text: '📋 查看任务', value: `todos:${sessionId}` },
        { text: '📝 查看消息', value: `messages:${sessionId}` },
        { text: '🔄 刷新状态', value: `session:${sessionId}` },
      ];
      
      await this.sendInteractiveCard(chatId, lines.join('\n'), buttons);
    } catch (error: any) {
      console.error('[Feishu] /session failed:', error.message);
      await this.sendReply(chatId, `❌ 获取会话失败: ${error.message}`);
    }
  }

  private async handleTodosCommand(sessionId: string, chatId: string): Promise<void> {
    try {
      const response = await this.opencodeClient.session.todo({ path: { id: sessionId } });
      const todos = (response as any)?.data || response || [];
      
      if (!Array.isArray(todos) || todos.length === 0) {
        await this.sendReply(chatId, `会话 ${sessionId} 暂无任务`);
        return;
      }

      const lines: string[] = [];
      lines.push('## 📋 任务列表');
      lines.push('');
      lines.push(`会话: ${sessionId}`);
      lines.push('');

      const completed = todos.filter(t => (t as any).status === 'completed').length;
      const inProgress = todos.filter(t => (t as any).status === 'in_progress').length;
      
      for (const todo of todos) {
        const t = todo as any;
        const statusIcon = t.status === 'in_progress' ? '▶️' : t.status === 'completed' ? '✅' : '⏸️';
        const priorityIcon = t.priority === 'high' ? '🔥' : t.priority === 'medium' ? '📌' : '';
        lines.push(`${statusIcon} ${priorityIcon} ${t.content || '无内容'}`);
      }

      lines.push('');
      lines.push(`**进度**: ${completed}/${todos.length} 完成${inProgress > 0 ? ` | 正在执行 ${inProgress} 项` : ''}`);
      lines.push('');
      lines.push('> 💡 点击下方按钮继续执行');

      const buttons = [
        { text: '▶️ 继续执行', value: `prompt:${sessionId}:继续执行` },
      ];

      await this.sendInteractiveCard(chatId, lines.join('\n'), buttons);
    } catch (error: any) {
      console.error('[Feishu] /todos failed:', error.message);
      await this.sendReply(chatId, `❌ 获取任务失败: ${error.message}`);
    }
  }

  private async handleAllTodosCommand(chatId: string): Promise<void> {
    try {
      const status = await getOpenCodeStatus(this.opencodeClient);
      const busySessions = status.sessions.filter(s => s.status === 'busy');
      
      if (busySessions.length === 0) {
        await this.sendReply(chatId, '当前无运行中的任务');
        return;
      }

      const lines: string[] = [];
      lines.push('## 📋 所有运行中的任务');
      lines.push('');

      for (const session of busySessions) {
        lines.push(`### ${session.title}`);
        
        if (session.todos && session.todos.length > 0) {
          for (const todo of session.todos) {
            const statusIcon = todo.status === 'in_progress' ? '▶️' : todo.status === 'completed' ? '✅' : '⏸️';
            const priorityIcon = todo.priority === 'high' ? '🔥' : todo.priority === 'medium' ? '📌' : '';
            lines.push(`${statusIcon} ${priorityIcon} ${todo.content || '无内容'}`);
          }
          const completed = session.todos.filter(t => t.status === 'completed').length;
          lines.push(`\n进度: ${completed}/${session.todos.length} 完成`);
        } else {
          lines.push('⏸️ 无具体任务');
        }
        lines.push('');
      }

      const buttons = busySessions.slice(0, 3).map(s => ({
        text: `💬 ${s.title.slice(0, 10)}`,
        value: `session:${s.id}`
      }));

      await this.sendInteractiveCard(chatId, lines.join('\n'), buttons);
    } catch (error: any) {
      console.error('[Feishu] /todos all failed:', error.message);
      await this.sendReply(chatId, `❌ 获取任务失败: ${error.message}`);
    }
  }

  private async handleMessagesCommand(sessionId: string, chatId: string): Promise<void> {
    try {
      const response = await this.opencodeClient.session.messages({ path: { id: sessionId } });
      const messages = (response as any)?.data || response || [];
      
      if (!Array.isArray(messages) || messages.length === 0) {
        await this.sendReply(chatId, `会话 ${sessionId} 暂无消息`);
        return;
      }

      const lines: string[] = [];
      lines.push('## 📝 最近消息');
      lines.push('');
      lines.push(`会话: ${sessionId}`);
      lines.push('');

      for (const msg of messages.slice(-5)) {
        const m = msg as any;
        const role = m.info?.role || 'unknown';
        const roleIcon = role === 'user' ? '👤' : role === 'assistant' ? '🤖' : '📢';
        
        const textParts = (m.parts || [])
          .filter((p: any) => p.type === 'text' && p.text)
          .map((p: any) => p.text as string);
        const content = textParts.join('\n') || '无内容';
        
        const truncated = content.length > 100 ? content.slice(0, 100) + '...' : content;
        lines.push(`**${roleIcon} ${role}**`);
        lines.push(truncated);
        lines.push('');
      }

      await this.sendReply(chatId, lines.join('\n'));
    } catch (error: any) {
      console.error('[Feishu] /messages failed:', error.message);
      await this.sendReply(chatId, `❌ 获取消息失败: ${error.message}`);
    }
  }

  private async handleProjectCommand(chatId: string): Promise<void> {
    try {
      const currentResponse = await this.opencodeClient.project.current({});
      const currentProject = (currentResponse as any)?.data || currentResponse;
      
      const lines: string[] = [];
      lines.push('## 📂 项目管理');
      lines.push('');
      
      if (currentProject) {
        const p = currentProject as any;
        const name = p.worktree?.split('/').pop() || '未知';
        lines.push('### 当前项目');
        lines.push(`- **名称**: ${name}`);
        if (p.worktree) lines.push(`- **路径**: ${p.worktree}`);
        
        try {
          const vcsResponse = await this.opencodeClient.vcs.get({});
          const vcs = (vcsResponse as any)?.data || vcsResponse;
          if (vcs?.branch) lines.push(`- **分支**: ${vcs.branch}`);
        } catch {}
        
        lines.push('');
      }
      
      let projects: Array<{ worktree: string; time?: { created: number } }> = [];
      try {
        const listResponse = await this.opencodeClient.project.list({});
        projects = (listResponse as any)?.data || [];
      } catch {}
      
      const buttons: Array<{ text: string; value: string }> = [];
      
      if (projects.length > 0) {
        const sorted = [...projects].sort((a, b) => 
          (b.time?.created || 0) - (a.time?.created || 0)
        );
        
        lines.push('### 所有项目');
        lines.push(`共 ${projects.length} 个项目`);
        lines.push('');
        
        for (const p of sorted.slice(0, 5)) {
          const name = p.worktree.split('/').pop() || p.worktree;
          const isCurrent = currentProject && (currentProject as any).worktree === p.worktree;
          lines.push(`${isCurrent ? '✅' : '📁'} ${name}`);
          
          buttons.push({
            text: `${isCurrent ? '✅' : '📁'} ${name.slice(0, 10)}`,
            value: `switch:${p.worktree}`
          });
        }
        
        if (projects.length > 5) {
          lines.push(`... 还有 ${projects.length - 5} 个项目`);
        }
      }
      
      lines.push('');
      lines.push('> 💡 点击按钮切换项目');
      
      await this.sendInteractiveCard(chatId, lines.join('\n'), buttons.slice(0, 6));
    } catch (error: any) {
      console.error('[Feishu] /project failed:', error.message);
      await this.sendReply(chatId, `❌ 获取项目失败: ${error.message}`);
    }
  }

  private async handleGitCommand(chatId: string): Promise<void> {
    try {
      const response = await this.opencodeClient.vcs.get({});
      const vcs = (response as any)?.data || response;
      
      if (!vcs) {
        await this.sendReply(chatId, '暂无 Git 信息');
        return;
      }

      const lines: string[] = [];
      lines.push('## 🔀 Git 状态');
      lines.push('');
      if (vcs.branch) lines.push(`- **分支**: ${vcs.branch}`);
      if (vcs.status) lines.push(`- **状态**: ${vcs.status}`);
      if (vcs.remote) lines.push(`- **远程**: ${vcs.remote}`);
      
      await this.sendReply(chatId, lines.join('\n'));
    } catch (error: any) {
      console.error('[Feishu] /git failed:', error.message);
      await this.sendReply(chatId, `❌ 获取 Git 信息失败: ${error.message}`);
    }
  }

  private async handleAgentsCommand(chatId: string): Promise<void> {
    try {
      const response = await this.opencodeClient.app.agents({});
      const agents = (response as any)?.data || response || [];
      
      if (!Array.isArray(agents) || agents.length === 0) {
        await this.sendReply(chatId, '暂无可用 Agent');
        return;
      }

      const lines: string[] = [];
      lines.push('## 🧠 可用 Agents');
      lines.push('');
      lines.push(`总数: **${agents.length}** 个`);
      lines.push('');

      for (const agent of agents.slice(0, 10)) {
        const a = agent as any;
        const name = a.name || a;
        lines.push(`- ${name}`);
      }

      if (agents.length > 10) {
        lines.push('');
        lines.push(`... 还有 ${agents.length - 10} 个`);
      }

      await this.sendReply(chatId, lines.join('\n'));
    } catch (error: any) {
      console.error('[Feishu] /agents failed:', error.message);
      await this.sendReply(chatId, `❌ 获取 Agents 失败: ${error.message}`);
    }
  }

  private async handlePromptCommand(sessionId: string, promptText: string, chatId: string): Promise<void> {
    try {
      console.log(`[Feishu] /prompt: sessionId=${sessionId}, text="${promptText}"`);
      await promptSession(this.opencodeClient, sessionId, promptText);
      await this.sendReply(chatId, `✅ 已向会话 ${sessionId} 发送消息`);
    } catch (error: any) {
      console.error('[Feishu] /prompt failed:', error.message);
      await this.sendReply(chatId, `❌ 发送失败: ${error.message}`);
    }
  }

  private async handleSwitchCommand(projectPath: string, chatId: string): Promise<void> {
    try {
      setCurrentProject(projectPath);
      console.log(`[Feishu] Switched to project: ${projectPath}`);
      
      const name = projectPath.split('/').pop() || projectPath;
      await this.sendReply(chatId, `✅ 已切换关注项目: ${name}\n\n路径: ${projectPath}\n\n后续通知将关联到此项目`);
    } catch (error: any) {
      console.error('[Feishu] /switch failed:', error.message);
      await this.sendReply(chatId, `❌ 切换失败: ${error.message}`);
    }
  }

  private async handleCurrentCommand(chatId: string): Promise<void> {
    const currentPath = getCurrentProject();
    
    if (!currentPath) {
      await this.sendReply(chatId, '暂未设置关注项目\n\n使用 `/switch <路径>` 设置');
      return;
    }

    const name = currentPath.split('/').pop() || currentPath;
    const lines: string[] = [];
    lines.push('## 📂 当前关注项目');
    lines.push('');
    lines.push(`- **名称**: ${name}`);
    lines.push(`- **路径**: ${currentPath}`);
    
    await this.sendReply(chatId, lines.join('\n'));
  }

  private async handleOverviewCommand(chatId: string): Promise<void> {
    if (!this.overviewManager) {
      await this.sendReply(chatId, '总览卡片功能未初始化\n\n请等待插件加载完成后再试');
      return;
    }

    try {
      await this.overviewManager.refresh();
      await this.sendReply(chatId, '✅ 总览卡片已刷新\n\n请查看最新的任务总览消息');
    } catch (error: any) {
      console.error('[Feishu] /overview failed:', error.message);
      await this.sendReply(chatId, `❌ 刷新失败: ${error.message}`);
    }
  }

  private formatStatusMessage(status: { sessions: any[]; project?: any; agents: string[] }): string {
    const lines: string[] = [];
    
    lines.push('## 🤖 OpenCode 状态概览');
    lines.push('');
    
    if (status.project) {
      lines.push('### 📂 当前项目');
      if (status.project.name) {
        lines.push(`- **项目**: ${status.project.name}`);
      }
      if (status.project.branch) {
        lines.push(`- **分支**: ${status.project.branch}`);
      }
      lines.push('');
    }
    
    const busyCount = status.sessions.filter(s => s.status === 'busy').length;
    const idleCount = status.sessions.filter(s => s.status === 'idle').length;
    const retryCount = status.sessions.filter(s => s.status === 'retry').length;
    const totalCount = status.sessions.length;

    lines.push('### 💬 会话状态');
    lines.push(`总计 **${totalCount}** 个会话`);
    if (busyCount > 0) lines.push(`- 🔄 运行中: **${busyCount}**`);
    if (idleCount > 0) lines.push(`- 💤 等待中: **${idleCount}**`);
    if (retryCount > 0) lines.push(`- ⚠️ 需重试: **${retryCount}**`);
    lines.push('');

    const busySessions = status.sessions.filter(s => s.status === 'busy');
    if (busySessions.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('### 📋 正在执行');
      lines.push('');
      
      for (const session of busySessions) {
        const sessionId = session.id || '';
        
        if (session.progress) {
          const p = session.progress;
          const progressBar = this.buildProgressBar(p.percentage);
          lines.push(`**进度** ${progressBar} ${p.percentage}% (${p.completed}/${p.total})`);
        }
        
        if (session.currentAction) {
          lines.push(`**当前动作** ▶️ ${session.currentAction}`);
        }
        
        if (session.recentActions && session.recentActions.length > 0) {
          lines.push(`**已完成**`);
          for (const action of session.recentActions.slice(-3)) {
            lines.push(`  ✅ ${action}`);
          }
        }
        
        lines.push(`\n> 💡 回复「继续」或点击按钮查看详情`);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('📌 **提示**: 输入 `/help` 查看更多命令');
    
    return lines.join('\n');
  }

  private buildProgressBar(percentage: number): string {
    const filled = Math.round(percentage / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  private buildSessionButtons(status: { sessions: any[]; project?: any; agents: string[] }): Array<{ text: string; value: string }> {
    const buttons: Array<{ text: string; value: string }> = [];
    
    const busySessions = status.sessions.filter(s => s.status === 'busy');
    
    for (const session of busySessions.slice(0, 5)) {
      const sessionId = session.id || '';
      
      let buttonText: string;
      if (session.currentAction) {
        const action = session.currentAction.length > 12 
          ? session.currentAction.slice(0, 12) + '...' 
          : session.currentAction;
        buttonText = `▶️ ${action}`;
      } else if (session.progress) {
        buttonText = `📊 ${session.progress.percentage}%`;
      } else {
        const title = session.title || '未命名';
        buttonText = `💬 ${title.length > 10 ? title.slice(0, 10) + '...' : title}`;
      }
      
      buttons.push({
        text: buttonText,
        value: `session:${sessionId}`
      });
    }

    if (busySessions.length > 5) {
      buttons.push({
        text: `📋 查看全部 (${busySessions.length})`,
        value: 'action:sessions'
      });
    }

    return buttons;
  }

  private buildQuickActionButtons(): Array<{ text: string; value: string }> {
    return [
      { text: '🔄 刷新', value: 'action:status' },
      { text: '📋 任务', value: 'action:todos' },
      { text: '💬 会话', value: 'action:sessions' },
      { text: '📂 项目', value: 'action:project' }
    ];
  }

  private buildEnhancedStatusCard(
    message: string,
    sessionButtons: Array<{ text: string; value: string }>,
    quickActionButtons: Array<{ text: string; value: string }>
  ): any {
    const elements: any[] = [];

    elements.push({
      tag: 'markdown',
      content: message
    });

    if (sessionButtons.length > 0) {
      const sessionColumns = sessionButtons.slice(0, 5).map(btn => ({
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: btn.text },
          behaviors: [{
            type: 'callback',
            value: { action: btn.value }
          }]
        }]
      }));

      elements.push({
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_align: 'left',
        columns: sessionColumns
      });
    }

    elements.push({ tag: 'hr' });

    const quickColumns = quickActionButtons.map(btn => ({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        type: 'default',
        text: { tag: 'plain_text', content: btn.text },
        behaviors: [{
          type: 'callback',
          value: { action: btn.value }
        }]
      }]
    }));

    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_align: 'center',
      columns: quickColumns
    });

    return { elements };
  }

  private buildSessionDetailCard(session: any): any {
    const elements: any[] = [];
    
    if (session.progress) {
      const p = session.progress;
      const bar = this.buildProgressBar(p.percentage);
      elements.push({
        tag: 'markdown',
        content: `### 📋 进度 ${bar} ${p.percentage}%\n${p.completed}/${p.total} 完成`
      });
    } else {
      elements.push({
        tag: 'markdown',
        content: `### 📋 会话详情`
      });
    }
    
    if (session.currentAction) {
      elements.push({
        tag: 'markdown',
        content: `**当前动作** ▶️ ${session.currentAction}`
      });
    }
    
    if (session.recentActions && session.recentActions.length > 0) {
      const actionsText = session.recentActions.slice(-3).map((a: string) => `✅ ${a}`).join('\n');
      elements.push({
        tag: 'markdown',
        content: `**已完成**\n${actionsText}`
      });
    }
    
    elements.push({ tag: 'hr' });
    
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_align: 'center',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            type: 'primary_filled',
            text: { tag: 'plain_text', content: '▶️ 继续' },
            behaviors: [{
              type: 'callback',
              value: { action: `prompt:${session.id}:继续执行` }
            }]
          }]
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            type: 'default',
            text: { tag: 'plain_text', content: '📝 消息' },
            behaviors: [{
              type: 'callback',
              value: { action: `messages:${session.id}` }
            }]
          }]
        }
      ]
    });
    
    return { elements };
  }

  private async handleContinue(sessionId: string, text: string, chatId: string): Promise<void> {
    if (text.match(/继续|continue|go|下一步|next/i)) {
      try {
        console.log(`[Feishu] Triggering continue for session: ${sessionId}`);
        await promptSession(this.opencodeClient, sessionId, '继续执行');
        console.log(`[Feishu] Continue triggered`);
      } catch (error: any) {
        console.error("[Feishu] Continue failed:", error.message);
        await this.sendReply(chatId, `❌ 失败: ${error.message}`);
      }
    } else {
      try {
        console.log(`[Feishu] Forwarding to session ${sessionId}: "${text}"`);
        await promptSession(this.opencodeClient, sessionId, text);
        console.log(`[Feishu] Message forwarded`);
      } catch (error: any) {
        console.error("[Feishu] Forward failed:", error.message);
        await this.sendReply(chatId, `❌ 发送失败: ${error.message}`);
      }
    }
  }

  private async handlePermission(sessionId: string, permissionId: string | undefined, text: string, chatId: string): Promise<void> {
    if (!permissionId) {
      await this.sendReply(chatId, '❌ 权限 ID 缺失');
      return;
    }

    let status: 'once' | 'always' | 'reject' | null = null;

    if (text.match(/总是批准|always/i)) {
      status = 'always';
    } else if (text.match(/批准|允许|yes|approve|ok/i)) {
      status = 'once';
    } else if (text.match(/拒绝|no|reject|deny/i)) {
      status = 'reject';
    }

    if (status) {
      try {
        await replyPermission(this.opencodeClient, sessionId, permissionId, status);
        const msg = status === 'reject' ? '已拒绝' : status === 'always' ? '已永久批准' : '已批准';
        console.log(`[Feishu] Permission ${status}: ${permissionId}`);
      } catch (error) {
        await this.sendReply(chatId, `❌ 失败: ${error}`);
      }
    } else {
      await this.sendReply(chatId, '无法识别，请回复: 批准 / 拒绝');
    }
  }

  private async handleQuestion(sessionId: string, options: string[], text: string, chatId: string): Promise<void> {
    if (options.length === 0) {
      try {
        await promptSession(this.opencodeClient, sessionId, text);
        console.log(`[Feishu] Question answered with custom text: ${text}`);
        await this.sendReply(chatId, `✅ 已提交答案: ${text}`);
      } catch (error: any) {
        console.error("[Feishu] Question answer failed:", error);
        await this.sendReply(chatId, `❌ 提交失败: ${error.message}`);
      }
      return;
    }

    const numMatch = text.match(/^(\d+)$/);
    if (numMatch) {
      const index = parseInt(numMatch[1]) - 1;
      if (index >= 0 && index < options.length) {
        try {
          await promptSession(this.opencodeClient, sessionId, options[index]);
          console.log(`[Feishu] Question answered: ${options[index]}`);
          await this.sendReply(chatId, `✅ 已选择: ${options[index]}`);
        } catch (error: any) {
          await this.sendReply(chatId, `❌ 失败: ${error.message}`);
        }
        return;
      }
    }

    for (const option of options) {
      if (text.toLowerCase().includes(option.toLowerCase())) {
        try {
          await promptSession(this.opencodeClient, sessionId, option);
          console.log(`[Feishu] Question answered: ${option}`);
          await this.sendReply(chatId, `✅ 已选择: ${option}`);
        } catch (error: any) {
          await this.sendReply(chatId, `❌ 失败: ${error.message}`);
        }
        return;
      }
    }

    try {
      await promptSession(this.opencodeClient, sessionId, text);
      console.log(`[Feishu] Question answered with custom text: ${text}`);
      await this.sendReply(chatId, `✅ 已提交答案: ${text}`);
    } catch (error: any) {
      console.error("[Feishu] Question answer failed:", error);
      await this.sendReply(chatId, `❌ 提交失败: ${error.message}`);
    }
  }

  private async handleInput(sessionId: string, text: string, chatId: string): Promise<void> {
    try {
      await appendPrompt(this.opencodeClient, text);
      await submitPrompt(this.opencodeClient);
      console.log(`[Feishu] Input submitted: "${text}"`);
    } catch (error) {
      console.error("[Feishu] Input submit failed:", error);
      await this.sendReply(chatId, `❌ 提交失败: ${error}`);
    }
  }

  private async handleApproveButton(
    sessionId: string,
    permissionId: string,
    approveType: string,
    chatId: string
  ): Promise<void> {
    let status: 'once' | 'always' | 'reject' = 'once';
    
    if (approveType === 'always') {
      status = 'always';
    } else if (approveType === 'reject') {
      status = 'reject';
    }

    try {
      await replyPermission(this.opencodeClient, sessionId, permissionId, status);
      const msg = status === 'reject' ? '❌ 已拒绝' : status === 'always' ? '✅ 已永久批准' : '✅ 已批准';
      console.log(`[Feishu] Permission ${status} via button: ${permissionId}`);
      await this.sendReply(chatId, msg);
    } catch (error: any) {
      console.error("[Feishu] Permission approval failed:", error);
      await this.sendReply(chatId, `❌ 操作失败: ${error.message}`);
    }
  }

  private async handleSelectButton(
    sessionId: string,
    optionIndex: number,
    optionLabel: string,
    chatId: string
  ): Promise<void> {
    try {
      await promptSession(this.opencodeClient, sessionId, optionLabel);
      console.log(`[Feishu] Question answered via button: ${optionLabel}`);
      await this.sendReply(chatId, `✅ 已选择: ${optionLabel}`);
    } catch (error: any) {
      console.error("[Feishu] Select failed:", error);
      await this.sendReply(chatId, `❌ 选择失败: ${error.message}`);
    }
  }

  private async sendReply(chatId: string, message: string): Promise<void> {
    try {
      await this.feishuClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: message
                }
              }
            ]
          }),
        },
      });
    } catch (error) {
      console.error("[Feishu] Send reply failed:", error);
    }
  }

  private async sendEnhancedCard(chatId: string, card: any): Promise<void> {
    try {
      await this.feishuClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    } catch (error) {
      console.error("[Feishu] Send enhanced card failed:", error);
    }
  }

  private async sendInteractiveCard(chatId: string, message: string, buttons: Array<{ text: string; value: string }>): Promise<void> {
    try {
      const buttonElements = buttons.map(btn => ({
        tag: 'button',
        text: { tag: 'plain_text', content: btn.text },
        value: { action: btn.value },
        type: 'default' as const,
      }));

      await this.feishuClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: message
                }
              },
              {
                tag: 'action',
                actions: buttonElements
              }
            ]
          }),
        },
      });
    } catch (error) {
      console.error("[Feishu] Send interactive card failed:", error);
    }
  }

  private async sendStatusCard(chatId: string, message: string, buttons: Array<{ text: string; value: string }>): Promise<void> {
    try {
      const buttonElements = buttons.map(btn => ({
        tag: 'button',
        text: { tag: 'plain_text', content: btn.text },
        value: { action: btn.value },
        type: 'default' as const,
      }));

      await this.feishuClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: message
                }
              },
              {
                tag: 'action',
                actions: buttonElements
              }
            ]
          }),
        },
      });
    } catch (error) {
      console.error("[Feishu] Send status card failed:", error);
    }
  }

  private async addReaction(messageId: string, emojiType: string): Promise<void> {
    try {
      await this.feishuClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emojiType },
        },
      });
      console.log(`[Feishu] Reaction added: ${emojiType} to ${messageId}`);
    } catch (error) {
      console.error("[Feishu] Add reaction failed:", error);
    }
  }

  async handleCardAction(data: any): Promise<void> {
    try {
      const action = data?.action;
      const value = action?.value;
      const openChatId = data?.context?.open_chat_id || data?.open_chat_id;

      if (!openChatId) {
        console.error("[Feishu] Card callback missing openChatId");
        return;
      }

      if (!value?.action) {
        return;
      }

      const actionValue = value.action as string;
      console.log(`[Feishu] Card action: ${actionValue}`);

      if (actionValue.startsWith('action:')) {
        const actionType = actionValue.replace('action:', '');
        
        switch (actionType) {
          case 'sessions':
            await this.handleSessionsCommand(openChatId);
            break;
          case 'agents':
            await this.handleAgentsCommand(openChatId);
            break;
          case 'help':
            await this.sendReply(openChatId, this.formatHelpMessage());
            break;
          case 'status':
            const status = await getOpenCodeStatus(this.opencodeClient);
            await this.sendReply(openChatId, this.formatStatusMessage(status));
            break;
          case 'todos':
            await this.handleAllTodosCommand(openChatId);
            break;
          case 'project':
            await this.handleProjectCommand(openChatId);
            break;
          case 'git':
            await this.handleGitCommand(openChatId);
            break;
          case 'overview':
            await this.handleOverviewCommand(openChatId);
            break;
          default:
            console.log(`[Feishu Handler] Unknown action type: ${actionType}`);
        }
        return;
      }

      if (actionValue.startsWith('approve:')) {
        const approveType = actionValue.replace('approve:', '');
        const sessionId = value.sessionId as string;
        const permissionId = value.permissionId as string;
        await this.handleApproveButton(sessionId, permissionId, approveType, openChatId);
        return;
      }

      if (actionValue === 'select') {
        const sessionId = value.sessionId as string;
        const optionIndex = value.optionIndex as number;
        const optionLabel = value.optionLabel as string;
        await this.handleSelectButton(sessionId, optionIndex, optionLabel, openChatId);
        return;
      }

      const parts = actionValue.split(':');
      const actionType = parts[0];
      const actionParam = parts.slice(1).join(':');

      console.log(`[Feishu Handler] Action type: ${actionType}, param: ${actionParam}`);

      switch (actionType) {
        case 'switch':
          await this.handleSwitchCommand(actionParam, openChatId);
          break;
        case 'prompt':
          const [sessionId, ...promptParts] = actionParam.split(':');
          await this.handlePromptCommand(sessionId, promptParts.join(':'), openChatId);
          break;
        case 'session':
          await this.handleSessionCommand(actionParam, openChatId);
          break;
        case 'todos':
          await this.handleTodosCommand(actionParam, openChatId);
          break;
        case 'messages':
          await this.handleMessagesCommand(actionParam, openChatId);
          break;
        default:
          console.log(`[Feishu Handler] Unknown action type: ${actionType}`);
      }
    } catch (error) {
      console.error("[Feishu] Card action handler error:", error);
    }
  }

  private parseContent(content: string): string {
    try {
      const obj = JSON.parse(content);
      return obj?.text || String(content);
    } catch {
      return String(content);
    }
  }
}