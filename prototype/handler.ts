import type { PrototypeConfig } from './config';
import { getMapping, deleteMapping } from './store';
import { promptSession } from './sdk-client';
import { sendReply } from './sender';
import * as Lark from '@larksuiteoapi/node-sdk';

export function createReplyHandler(
  feishuApiClient: Lark.Client,
  config: PrototypeConfig
) {
  return {
    async handle(data: any): Promise<void> {
      try {
        const msg = data?.message;
        if (!msg) return;
        
        const messageId = msg.message_id;
        const parentId = msg.parent_id;
        const chatId = msg.chat_id;
        const content = msg.content;
        
        console.log(`[Handler] message_id: ${messageId}`);
        console.log(`[Handler] parent_id: ${parentId}`);
        console.log(`[Handler] chat_id: ${chatId}`);
        
        const text = parseContent(content);
        console.log(`[Handler] 内容: "${text}"`);
        
        if (!parentId) {
          console.log('[Handler] 无 parent_id，跳过');
          return;
        }
        
        const mapping = getMapping(parentId);
        if (!mapping) {
          console.log(`[Handler] 未找到映射: ${parentId}`);
          await sendReply(feishuApiClient, chatId, 
            '未找到对应的通知消息。请回复 OpenCode 发送的通知消息。'
          );
          return;
        }
        
        console.log(`[Handler] 映射: session=${mapping.sessionId}`);
        
        const normalizedText = text.toLowerCase().trim();
        
        if (normalizedText.match(/继续|continue|go|下一步|next/i)) {
          console.log('[Handler] ✅ 继续');
          
          try {
            await promptSession(config, mapping.sessionId, '继续执行');
            await sendReply(feishuApiClient, chatId, 
              `✅ 已触发继续执行\nSession: ${mapping.sessionId}`
            );
            deleteMapping(parentId);
          } catch (sdkError: any) {
            console.error('[Handler] SDK 失败:', sdkError.message);
            await sendReply(feishuApiClient, chatId, 
              `❌ 失败: ${sdkError.message}`
            );
          }
          
        } else if (normalizedText.match(/状态|status|查询|query/i)) {
          console.log('[Handler] ✅ 查询状态');
          
          try {
            await promptSession(config, mapping.sessionId, '简要说明当前进度');
            await sendReply(feishuApiClient, chatId, '📊 已查询，请查看 TUI');
          } catch (sdkError: any) {
            await sendReply(feishuApiClient, chatId, `❌ 失败: ${sdkError.message}`);
          }
          
        } else {
          console.log(`[Handler] ❌ 无法识别: "${text}"`);
          await sendReply(feishuApiClient, chatId, 
            `❓ 无法识别 "${text}"\n\n支持: "继续", "状态"`
          );
        }
        
      } catch (error: any) {
        console.error('[Handler] 出错:', error.message);
      }
    },
  };
}

function parseContent(content: string): string {
  try {
    const obj = JSON.parse(content);
    return obj?.text || String(content);
  } catch {
    return String(content);
  }
}