import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from './config';

export type MessageHandler = (data: any) => Promise<void>;

export function createFeishuWebSocket(config: FeishuConfig) {
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });
  
  return {
    wsClient,
    
    async start(handler: MessageHandler): Promise<void> {
      console.log('[WebSocket] 启动中...');
      
      await wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data: any) => {
            console.log('\n[WebSocket] ========== 收到消息 ==========');
            console.log(JSON.stringify(data, null, 2));
            await handler(data);
          },
        }),
      });
      
      console.log('[WebSocket] 已连接，等待消息...');
    },
    
    async stop(): Promise<void> {
      console.log('[WebSocket] 停止...');
      try {
        await (wsClient as any).stop?.();
      } catch (e) {
        console.warn('[WebSocket] 停止出错:', e);
      }
    },
  };
}