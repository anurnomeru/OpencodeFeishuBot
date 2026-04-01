import * as Lark from '@larksuiteoapi/node-sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { FeishuConfig } from './config';
import { getMapping, deleteMapping } from './store';
import { promptSession, replyPermission, appendPrompt, submitPrompt } from './sdk-client';

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
      console.log("[Feishu] ReplyHandler.handle called");
      const msg = data?.message;
      if (!msg) {
        console.log("[Feishu] No message in data");
        return;
      }

      const parentId = msg.parent_id;
      const chatId = msg.chat_id;
      const content = msg.content;

      const text = this.parseContent(content);
      console.log(`[Feishu] Message: parentId=${parentId}, text="${text}"`);
      this.log('info', 'Message received', { parentId, text });

      if (parentId) {
        await this.handleReplyToNotification(parentId, text, chatId);
      } else {
        await this.handleDirectMessage(text, chatId);
      }

    } catch (error) {
      console.error("[Feishu] Handler error:", error);
      this.log('error', 'Handler error', { error: String(error) });
    }
  }

  private async handleReplyToNotification(parentId: string, text: string, chatId: string): Promise<void> {
    console.log(`[Feishu] handleReplyToNotification: parentId=${parentId}`);
    const mapping = getMapping(parentId);
    console.log(`[Feishu] Mapping result:`, mapping);
    
    if (!mapping) {
      console.log("[Feishu] Mapping not found, fallback to direct message");
      this.log('warn', 'Mapping not found, fallback to direct message', { parentId });
      await this.handleDirectMessage(text, chatId);
      return;
    }

    console.log(`[Feishu] Found mapping: sessionId=${mapping.sessionId}`);
    this.log('info', 'Found mapping', { sessionId: mapping.sessionId, actionType: mapping.actionType });

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
    this.log('info', 'Direct message', { text });

    try {
      const response = await this.opencodeClient.session.list({});
      const sessionList = Array.isArray(response) 
        ? response 
        : (response as any)?.data || [];
      
      this.log('debug', 'Session list result', { 
        isArray: Array.isArray(response),
        dataLength: sessionList.length 
      });
      
      if (sessionList.length === 0) {
        await this.sendReply(chatId, '❌ 没有活跃的 OpenCode session');
        return;
      }

      const latestSession = sessionList[0];
      const sessionId = latestSession.id;

      this.log('info', 'Forward to session', { sessionId });

      await promptSession(this.opencodeClient, sessionId, text);
      await this.sendReply(chatId, `✅ 已发送到 OpenCode\n\n> ${text}`);

    } catch (error: any) {
      this.log('error', 'Direct message failed', { error: error.message });
      await this.sendReply(chatId, `❌ 发送失败: ${error.message}`);
    }
  }

  private async handleContinue(sessionId: string, text: string, chatId: string): Promise<void> {
    this.log('info', 'handleContinue called', { sessionId, text });
    
    if (text.match(/继续|continue|go|下一步|next/i)) {
      try {
        this.log('info', 'Triggering continue', { sessionId });
        await promptSession(this.opencodeClient, sessionId, '继续执行');
        await this.sendReply(chatId, `✅ 已触发继续执行`);
        this.log('info', 'Continue triggered', { sessionId });
      } catch (error: any) {
        this.log('error', 'Continue failed', { error: error.message });
        await this.sendReply(chatId, `❌ 失败: ${error.message}`);
      }
    } else {
      try {
        this.log('info', 'Forwarding message to session', { sessionId, text });
        await promptSession(this.opencodeClient, sessionId, text);
        await this.sendReply(chatId, `✅ 已发送到 OpenCode\n\n> ${text}`);
        this.log('info', 'Message forwarded', { sessionId });
      } catch (error: any) {
        this.log('error', 'Forward failed', { error: error.message });
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
        await this.sendReply(chatId, `✅ ${msg}`);
        this.log('info', 'Permission replied', { sessionId, permissionId, status });
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
          await this.sendReply(chatId, `✅ 已选择: ${options[index]}`);
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
          await this.sendReply(chatId, `✅ 已选择: ${option}`);
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
      await this.sendReply(chatId, `✅ 已提交输入`);
      this.log('info', 'Input submitted', { sessionId });
    } catch (error) {
      this.log('error', 'Input submit failed', { error: String(error) });
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
      this.log('error', 'Send reply failed', { error: String(error) });
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