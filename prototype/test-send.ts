import { loadConfig, validateSessionId } from './config';
import { createFeishuApiClient, sendNotification } from './sender';
import { debugStore } from './store';

async function main() {
  console.log('='.repeat(60));
  console.log('飞书 WebSocket 原型 - 测试发送');
  console.log('='.repeat(60) + '\n');
  
  const config = loadConfig();
  
  const sessionValidation = validateSessionId(config);
  if (!sessionValidation.valid) {
    console.error(`\n❌ ${sessionValidation.error}`);
    console.error('\n获取 Session ID:');
    console.error('  curl http://localhost:3000/sessions | jq \'.[0].id\'');
    console.error('\n然后:');
    console.error('  export OPENCODE_SESSION_ID=<session_id>');
    process.exit(1);
  }
  
  console.log(`  OpenCode Session:   ${config.opencode.sessionId}`);
  
  const feishuClient = createFeishuApiClient(config.feishu);
  
  const message = 
    `【原型测试】OpenCode 会话已暂停\n\n` +
    `Session ID: ${config.opencode.sessionId}\n` +
    `Server: ${config.opencode.serverUrl}\n\n` +
    `支持的回复:\n` +
    `  • "继续" - 触发继续执行\n` +
    `  • "状态" - 查询进度\n\n` +
    `⚠️ 请使用飞书的"回复"功能回复此消息`;
  
  console.log('\n发送飞书通知...');
  
  const feishuMessageId = await sendNotification(
    feishuClient,
    config.feishu,
    config.opencode.sessionId,
    message
  );
  
  if (!feishuMessageId) {
    console.error('\n❌ 发送失败');
    process.exit(1);
  }
  
  console.log('\n映射存储:');
  debugStore();
  
  console.log('\n' + '='.repeat(60));
  console.log('下一步:');
  console.log('='.repeat(60));
  console.log('1. 飞书中回复 "继续"');
  console.log('2. 另一终端运行: npm run start');
  console.log('3. 观察 WebSocket 输出');
  console.log('\n' + '='.repeat(60));
}

main().catch((error) => {
  console.error('\n❌ 出错:', error.message || error);
  process.exit(1);
});