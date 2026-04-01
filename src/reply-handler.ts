import * as Lark from '@larksuiteoapi/node-sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { FeishuConfig } from './config';
import { getMapping, deleteMapping, isMessageProcessed, markMessageProcessed } from './store';
import { promptSession, replyPermission, appendPrompt, submitPrompt, getOpenCodeStatus } from './sdk-client';

export class ReplyHandler {
  private feishuClient: Lark.Client;
  private opencodeClient: OpencodeClient;
  private log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;

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

  async handle(data: any): Promise<void> {
    try {
      const msg = data?.message;
      if (!msg) return;

      const messageId = msg.message_id;
      if (messageId && isMessageProcessed(messageId)) {
        console.log(`[Feishu] Message already processed, skipping: ${messageId}`);
        return;
      }
      
      if (messageId) {
        markMessageProcessed(messageId);
      }

      const parentId = msg.parent_id;
      const chatId = msg.chat_id;
      const content = msg.content;

      const text = this.parseContent(content);
      console.log(`[Feishu] Message: parentId=${parentId}, text="${text}"`);

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
      console.log("[Feishu] Mapping not found, fallback to direct message");
      await this.handleDirectMessage(text, chatId);
      return;
    }

    console.log(`[Feishu] Found mapping: sessionId=${mapping.sessionId}`);

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
    console.log(`[Feishu] Direct message received (not forwarded to OpenCode): "${text}"`);
    
    const status = await getOpenCodeStatus(this.opencodeClient);
    const message = this.formatStatusMessage(status);
    await this.sendReply(chatId, message);
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
      if (status.project.worktree) {
        lines.push(`- **路径**: ${status.project.worktree}`);
      }
      lines.push('');
    }
    
    if (status.sessions.length > 0) {
      lines.push('### 💬 活跃会话');
      lines.push(`- **总数**: ${status.sessions.length} 个会话`);
      lines.push('');
      
      const idleCount = status.sessions.filter(s => s.status === 'idle').length;
      const busyCount = status.sessions.filter(s => s.status === 'busy').length;
      const retryCount = status.sessions.filter(s => s.status === 'retry').length;
      
      if (idleCount > 0) lines.push(`  - 💤 空闲: ${idleCount}`);
      if (busyCount > 0) lines.push(`  - 🔄 运行中: ${busyCount}`);
      if (retryCount > 0) lines.push(`  - ⚠️ 重试: ${retryCount}`);
      lines.push('');
      
      const busySessions = status.sessions.filter(s => s.status === 'busy' && s.todos?.length > 0);
      if (busySessions.length > 0) {
        lines.push('### 📋 正在执行的任务');
        for (const session of busySessions.slice(0, 3)) {
          lines.push(`\n**${session.title}**`);
          if (session.todos) {
            for (const todo of session.todos) {
              const statusIcon = todo.status === 'in_progress' ? '▶️' : todo.status === 'completed' ? '✅' : '⏸️';
              const priorityIcon = todo.priority === 'high' ? '🔥' : todo.priority === 'medium' ? '📌' : '';
              lines.push(`  ${statusIcon} ${priorityIcon} ${todo.content}`);
            }
          }
        }
        lines.push('');
      }
    } else {
      lines.push('### 💬 会话状态');
      lines.push('- 暂无活跃会话');
      lines.push('');
    }
    
    if (status.agents.length > 0) {
      lines.push('### 🧠 可用 Agent');
      const agentList = status.agents.slice(0, 5);
      lines.push(`- ${agentList.join(' · ')}`);
      if (status.agents.length > 5) {
        lines.push(`- 还有 ${status.agents.length - 5} 个...`);
      }
      lines.push('');
    }
    
    lines.push('---');
    lines.push('');
    lines.push('📌 **使用提示**');
    lines.push('- 回复通知卡片可与 OpenCode 交互');
    lines.push('- 普通聊天消息仅展示状态');
    lines.push('');
    lines.push(`⏰ ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
    
    return lines.join('\n');
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
    const numMatch = text.match(/^(\d+)$/);
    if (numMatch) {
      const index = parseInt(numMatch[1]) - 1;
      if (index >= 0 && index < options.length) {
        try {
          await promptSession(this.opencodeClient, sessionId, options[index]);
          console.log(`[Feishu] Question answered: ${options[index]}`);
          return;
        } catch (error) {
          await this.sendReply(chatId, `❌ 失败: ${error}`);
        }
        return;
      }
    }

    for (const option of options) {
      if (text.toLowerCase().includes(option.toLowerCase())) {
        try {
          await promptSession(this.opencodeClient, sessionId, option);
          console.log(`[Feishu] Question answered: ${option}`);
          return;
        } catch (error) {
          await this.sendReply(chatId, `❌ 失败: ${error}`);
        }
        return;
      }
    }

    await this.sendReply(chatId, `无法识别选项，请回复选项编号或名称`);
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

  private async sendReply(chatId: string, message: string): Promise<void> {
    try {
      await this.feishuClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            elements: [
              { tag: 'markdown', content: message }
            ]
          }),
        },
      });
    } catch (error) {
      console.error("[Feishu] Send reply failed:", error);
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