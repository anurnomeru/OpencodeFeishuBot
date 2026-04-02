import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from './config';

export type MessageHandler = (data: any) => Promise<void>;
export type CardActionHandler = (data: any) => Promise<void>;

export class FeishuWebSocket {
  private wsClient: Lark.WSClient | null = null;
  private config: FeishuConfig;
  private started = false;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  async start(handler: MessageHandler, cardActionHandler?: CardActionHandler): Promise<void> {
    if (this.started) return;
    
    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.error,
    });

    const eventHandlers: Record<string, (data: any) => Promise<void>> = {
      'im.message.receive_v1': async (data: any) => {
        await handler(data);
      },
    };

    if (cardActionHandler) {
      eventHandlers['card.action.trigger'] = async (data: any) => {
        await cardActionHandler(data);
      };
    }
    
    try {
      await this.wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register(eventHandlers),
      });
      console.log("[Feishu] WebSocket connected");
    } catch (error) {
      console.error("[Feishu] WebSocket failed:", error);
      throw error;
    }
    
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.wsClient && this.started) {
      try {
        await (this.wsClient as any).stop?.();
      } catch {}
    }
    this.started = false;
    this.wsClient = null;
  }

  isRunning(): boolean {
    return this.started;
  }
}