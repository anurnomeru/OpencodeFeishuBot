import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from './config';
import { setMapping } from './store';

export function createFeishuApiClient(config: FeishuConfig) {
  return new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });
}

export async function sendNotification(
  client: Lark.Client,
  config: FeishuConfig,
  sessionId: string,
  message: string
): Promise<string> {
  console.log(`[Sender] 发送到 ${config.receiverType}=${config.receiverId}`);
  
  try {
    const response = await client.im.v1.message.create({
      params: { receive_id_type: config.receiverType },
      data: {
        receive_id: config.receiverId,
        content: JSON.stringify({ text: message }),
        msg_type: 'text',
      },
    });
    
    const feishuMessageId = response.data?.message_id || '';
    
    if (feishuMessageId) {
      setMapping(feishuMessageId, sessionId);
    }
    
    console.log(`[Sender] 已发送，message_id: ${feishuMessageId}`);
    return feishuMessageId;
    
  } catch (error: any) {
    console.error('[Sender] 失败:', error.message || error);
    throw error;
  }
}

export async function sendReply(
  client: Lark.Client,
  chatId: string,
  message: string
): Promise<void> {
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: message }),
        msg_type: 'text',
      },
    });
    console.log(`[Sender] 回复已发送`);
  } catch (error: any) {
    console.error('[Sender] 回复失败:', error.message || error);
  }
}