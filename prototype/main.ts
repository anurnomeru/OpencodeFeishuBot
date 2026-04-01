import { loadConfig } from './config';
import { createFeishuApiClient } from './sender';
import { createFeishuWebSocket } from './websocket';
import { createReplyHandler } from './handler';
import { debugStore } from './store';

async function main() {
  console.log('='.repeat(60));
  console.log('飞书 WebSocket 双向交互原型');
  console.log('='.repeat(60) + '\n');
  
  const config = loadConfig();
  
  const feishuApiClient = createFeishuApiClient(config.feishu);
  const handler = createReplyHandler(feishuApiClient, config);
  const ws = createFeishuWebSocket(config.feishu);
  
  debugStore();
  
  console.log('\n' + '='.repeat(60));
  console.log('启动 WebSocket...');
  console.log('='.repeat(60) + '\n');
  
  await ws.start(handler.handle);
  
  console.log('\n等待飞书用户回复...');
  console.log('先运行 npm run test-send 发送测试通知');
  console.log('\n按 Ctrl+C 停止');
  
  process.on('SIGINT', async () => {
    console.log('\n停止...');
    await ws.stop();
    debugStore();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await ws.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('\n❌ 出错:', error.message || error);
  process.exit(1);
});