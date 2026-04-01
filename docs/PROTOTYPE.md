# 双向交互原型验证指南

> 本文档描述最小化原型验证流程，用于验证飞书 WebSocket 双向交互的核心功能。
> 
> 目标：用最少代码验证 "飞书用户回复 → OpenCode 继续执行" 这一核心流程。

---

## 一、原型目标

### 验证的核心流程

```
飞书用户回复 "继续" → WebSocket 接收 → 解析内容 → OpenCode session.prompt() → 会话继续
```

### 不包含的功能

| 功能 | 原型阶段 | 理由 |
|------|---------|------|
| 权限批准 | ❌ 不验证 | 流程类似，先验证最简单场景 |
| 问题回复 | ❌ 不验证 | 需额外解析逻辑 |
| 交互输入 | ❌ 不验证 | TUI API 调用不同 |
| 消息去重 | ❌ 简化 | 原型阶段可忽略 |
| 过期清理 | ❌ 简化 | 手动测试，不设 TTL |
| 错误处理 | ⚠️ 最简 | 仅打印日志 |

---

## 二、原型架构

### 最简化架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    原型最小化架构                            │
└─────────────────────────────────────────────────────────────┘

┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   OpenCode   │      │   原型脚本    │      │    飞书      │
│   Session    │      │ (standalone) │      │    用户      │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │
       │  1. 发送飞书通知     │                     │
       │ ──────────────────► │ ──────────────────► │
       │     (手动触发)       │     HTTP API       │
       │                     │                     │
       │                     │     2. 存储映射     │
       │                     │ ◄─────────────────  │
       │                     │                     │
       │                     │  3. 用户回复 "继续" │
       │                     │ ◄─────────────────  │
       │                     │    WebSocket 接收   │
       │                     │                     │
       │  4. session.prompt  │                     │
       │ ◄─────────────────  │                     │
       │                     │                     │
       │  5. 会话继续执行     │                     │
       │ ──────────────────► │ ──────────────────► │
       │                     │    发送确认消息      │
       │                     │                     │

关键点：
- 原型脚本是一个独立运行的 Node.js 程序
- 不依赖 OpenCode Plugin 机制，直接调用 OpenCode SDK
- 手动触发发送通知，验证完整链路
```

---

## 三、原型文件结构

### 文件清单

```
prototype/
├── package.json           # 原型脚本依赖
├── config.ts              # 配置加载
├── websocket.ts           # 飞书 WebSocket 客户端
├── store.ts               # 映射存储（内存 Map）
├── sender.ts              # 飞书通知发送
├── handler.ts             # 回复处理
├── sdk-client.ts          # OpenCode SDK 客户端
├── test-send.ts           # 测试脚本：发送通知
└── main.ts                # 主入口：启动 WebSocket
```

### 各文件职责

| 文件 | 职责 | 关键 API |
|------|------|---------|
| `websocket.ts` | 接收飞书消息 | `Lark.WSClient` |
| `store.ts` | 存储 sessionId 映射 | `Map<string, PendingAction>` |
| `sender.ts` | 发送飞书通知 | `Lark.Client.im.v1.message.create` |
| `handler.ts` | 处理回复，调用 OpenCode | 关键词匹配 + `session.prompt` |
| `sdk-client.ts` | OpenCode SDK 客户端 | `createOpencodeClient` |
| `test-send.ts` | 手动触发测试 | 发送通知 + 存储映射 |
| `main.ts` | 启动 WebSocket | 监听消息 + 处理回复 |

---

## 四、原型代码实现

### 4.1 `prototype/package.json`

```json
{
  "name": "feishu-websocket-prototype",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "start": "tsx main.ts",
    "test-send": "tsx test-send.ts"
  },
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.24.0",
    "@opencode-ai/sdk": "*"
  },
  "devDependencies": {
    "tsx": "^4.7.0"
  }
}
```

### 4.2 `prototype/config.ts`

```typescript
// 从环境变量或配置文件加载
export interface PrototypeConfig {
  // 飞书配置
  feishu: {
    appId: string;
    appSecret: string;
    receiverId: string;  // 测试用的飞书用户/群 ID
  };
  // OpenCode 配置
  opencode: {
    serverUrl: string;   // OpenCode server 地址，如 http://localhost:3000
    sessionId: string;   // 测试用的 session ID（需要提前获取）
  };
}

export function loadConfig(): PrototypeConfig {
  return {
    feishu: {
      appId: process.env.FEISHU_APP_ID || '',
      appSecret: process.env.FEISHU_APP_SECRET || '',
      receiverId: process.env.FEISHU_RECEIVER_ID || '',
    },
    opencode: {
      serverUrl: process.env.OPENCODE_SERVER_URL || 'http://localhost:3000',
      sessionId: process.env.OPENCODE_SESSION_ID || '',
    },
  };
}
```

### 4.3 `prototype/store.ts`

```typescript
// 最简映射存储（内存 Map）
export type PendingAction = {
  sessionId: string;
  feishuMessageId: string;
  createdAt: number;
};

// 飞书 message_id → PendingAction
const store = new Map<string, PendingAction>();

export function setMapping(feishuMessageId: string, sessionId: string): void {
  store.set(feishuMessageId, {
    sessionId,
    feishuMessageId,
    createdAt: Date.now(),
  });
  console.log(`[Store] 已存储映射: feishu=${feishuMessageId} → session=${sessionId}`);
}

export function getMapping(feishuMessageId: string): PendingAction | undefined {
  return store.get(feishuMessageId);
}

export function deleteMapping(feishuMessageId: string): void {
  store.delete(feishuMessageId);
  console.log(`[Store] 已删除映射: feishu=${feishuMessageId}`);
}

// 用于调试：查看当前所有映射
export function debugStore(): void {
  console.log(`[Store] 当前映射数: ${store.size}`);
  for (const [key, value] of store.entries()) {
    console.log(`  ${key} → session=${value.sessionId}`);
  }
}
```

### 4.4 `prototype/sdk-client.ts`

```typescript
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { PrototypeConfig } from './config';

// OpenCode SDK 客户端
export function createSdkClient(config: PrototypeConfig) {
  const client = createOpencodeClient({
    baseUrl: config.opencode.serverUrl,
  });
  return client;
}

// 向 session 发送消息
export async function promptSession(
  client: ReturnType<typeof createSdkClient>,
  sessionId: string,
  text: string
) {
  console.log(`[SDK] 向 session ${sessionId} 发送: "${text}"`);
  
  const response = await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text }],
    },
  });
  
  console.log(`[SDK] 响应收到，assistant message id: ${response?.id}`);
  return response;
}
```

### 4.5 `prototype/sender.ts`

```typescript
import * as Lark from '@larksuiteoapi/node-sdk';
import type { PrototypeConfig } from './config';
import { setMapping } from './store';

// 飞书 API 客户端
export function createFeishuApiClient(config: PrototypeConfig) {
  return new Lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });
}

// 发送飞书通知，并存储映射
export async function sendNotification(
  client: Lark.Client,
  config: PrototypeConfig,
  sessionId: string,
  message: string
): Promise<string> {
  console.log(`[Sender] 发送飞书通知: "${message}"`);
  
  const response = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },  // 或 'user_id'
    data: {
      receive_id: config.feishu.receiverId,
      content: JSON.stringify({ text: message }),
      msg_type: 'text',
    },
  });
  
  const feishuMessageId = response.data?.message_id || '';
  
  if (feishuMessageId) {
    // 存储映射
    setMapping(feishuMessageId, sessionId);
  }
  
  console.log(`[Sender] 飞书消息已发送，message_id: ${feishuMessageId}`);
  return feishuMessageId;
}
```

### 4.6 `prototype/websocket.ts`

```typescript
import * as Lark from '@larksuiteoapi/node-sdk';
import type { PrototypeConfig } from './config';
import type { ReplyHandler } from './handler';

// 飞书 WebSocket 客户端
export function createFeishuWebSocket(
  config: PrototypeConfig,
  handler: ReplyHandler
) {
  const wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.info,  // 原型阶段用 info 级别
  });
  
  return {
    wsClient,
    
    async start(): Promise<void> {
      console.log('[WebSocket] 启动飞书 WebSocket 客户端...');
      
      await wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data: any) => {
            console.log('[WebSocket] 收到消息事件');
            console.log(JSON.stringify(data, null, 2));
            await handler.handle(data);
          },
        }),
      });
      
      console.log('[WebSocket] WebSocket 已连接，等待消息...');
    },
    
    async stop(): Promise<void> {
      console.log('[WebSocket] 停止 WebSocket...');
      await (wsClient as any).stop?.();
    },
  };
}
```

### 4.7 `prototype/handler.ts`

```typescript
import type { ReturnType as SdkClient } from './sdk-client';
import type { ReturnType as FeishuApiClient } from './sender';
import { getMapping, deleteMapping } from './store';
import { promptSession } from './sdk-client';
import * as Lark from '@larksuiteoapi/node-sdk';

export interface ReplyHandler {
  handle(data: any): Promise<void>;
}

export function createReplyHandler(
  sdkClient: SdkClient,
  feishuApiClient: Lark.Client,
  config: PrototypeConfig
): ReplyHandler {
  return {
    async handle(data: any): Promise<void> {
      try {
        const msg = data?.event?.message;
        if (!msg) {
          console.log('[Handler] 无消息内容，跳过');
          return;
        }
        
        const messageId = msg.message_id;
        const parentId = msg.parent_id;  // 回复的原消息 ID
        const chatId = msg.chat_id;
        const content = msg.content;
        
        // 解析消息内容
        const text = parseContent(content);
        console.log(`[Handler] 收到回复: "${text}" (message_id: ${messageId})`);
        
        // 查找映射（用 parent_id 查找原通知消息）
        const mapping = getMapping(parentId);
        if (!mapping) {
          console.log(`[Handler] 未找到映射 (parent_id: ${parentId})，可能不是针对通知的回复`);
          
          // 发送提示
          await feishuApiClient.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ text: '这条消息不是针对 OpenCode 通知的回复' }),
              msg_type: 'text',
            },
          });
          return;
        }
        
        // 匹配关键词
        const normalizedText = text.toLowerCase().trim();
        
        if (normalizedText.match(/继续|continue|go/i)) {
          console.log(`[Handler] 识别为"继续执行"`);
          
          // 调用 OpenCode SDK
          await promptSession(sdkClient, mapping.sessionId, '继续执行');
          
          // 发送飞书确认
          await feishuApiClient.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ text: '已触发 OpenCode 继续执行...' }),
              msg_type: 'text',
            },
          });
          
          // 清除映射
          deleteMapping(parentId);
          
        } else {
          console.log(`[Handler] 无法识别关键词: "${text}"`);
          
          // 发送飞书提示
          await feishuApiClient.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ text: `无法识别，请回复 "继续" 以触发 OpenCode 继续执行` }),
              msg_type: 'text',
            },
          });
        }
        
      } catch (error: any) {
        console.error('[Handler] 处理出错:', error);
      }
    },
  };
}

// 解析飞书消息内容
function parseContent(content: string): string {
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj.text === 'string') {
      return obj.text;
    }
    return String(content);
  } catch {
    return String(content);
  }
}
```

### 4.8 `prototype/test-send.ts`

```typescript
/**
 * 测试脚本：手动发送飞书通知并存储映射
 * 
 * 用法：
 *   1. 先启动 OpenCode session（获取 sessionId）
 *   2. 设置环境变量：OPENCODE_SESSION_ID=<sessionId>
 *   3. 运行：npm run test-send
 *   4. 在飞书中回复 "继续"
 *   5. 观察 WebSocket 是否收到并处理
 */

import { loadConfig } from './config';
import { createFeishuApiClient, sendNotification } from './sender';
import { debugStore } from './store';

async function main() {
  const config = loadConfig();
  
  // 验证配置
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.error('请设置环境变量：FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_RECEIVER_ID');
    process.exit(1);
  }
  
  if (!config.opencode.sessionId) {
    console.error('请设置环境变量：OPENCODE_SESSION_ID（需要先启动一个 OpenCode session）');
    process.exit(1);
  }
  
  const feishuClient = createFeishuApiClient(config);
  
  // 发送通知
  const message = `【原型测试】OpenCode 会话已暂停。\n请回复 "继续" 以触发 OpenCode 继续执行。\n\nSession ID: ${config.opencode.sessionId}`;
  
  await sendNotification(feishuClient, config, config.opencode.sessionId, message);
  
  // 显示当前映射
  debugStore();
  
  console.log('\n下一步：');
  console.log('1. 在飞书中找到刚才发送的消息');
  console.log('2. 回复 "继续"');
  console.log('3. 运行 npm run start 启动 WebSocket 监听');
  console.log('4. 观察是否收到消息并触发 OpenCode 继续执行');
}

main().catch(console.error);
```

### 4.9 `prototype/main.ts`

```typescript
/**
 * 主入口：启动 WebSocket 监听飞书消息
 * 
 * 用法：
 *   npm run start
 */

import { loadConfig } from './config';
import { createSdkClient } from './sdk-client';
import { createFeishuApiClient } from './sender';
import { createFeishuWebSocket } from './websocket';
import { createReplyHandler } from './handler';
import { debugStore } from './store';

async function main() {
  const config = loadConfig();
  
  // 验证配置
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.error('请设置环境变量：FEISHU_APP_ID, FEISHU_APP_SECRET');
    process.exit(1);
  }
  
  console.log('='.repeat(60));
  console.log('飞书 WebSocket 双向交互原型');
  console.log('='.repeat(60));
  console.log(`飞书 App ID: ${config.feishu.appId}`);
  console.log(`OpenCode Server: ${config.opencode.serverUrl}`);
  console.log('='.repeat(60));
  
  // 创建客户端
  const sdkClient = createSdkClient(config);
  const feishuApiClient = createFeishuApiClient(config);
  
  // 创建处理器
  const handler = createReplyHandler(sdkClient, feishuApiClient, config);
  
  // 创建 WebSocket
  const ws = createFeishuWebSocket(config, handler);
  
  // 显示当前映射（如果有）
  debugStore();
  
  // 启动 WebSocket
  await ws.start();
  
  console.log('\n等待飞书用户回复...');
  console.log('提示：先运行 npm run test-send 发送测试通知');
  
  // 保持运行
  process.on('SIGINT', async () => {
    console.log('\n收到 SIGINT，停止 WebSocket...');
    await ws.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## 五、验证流程

### 5.1 准备工作

#### Step 1: 获取飞书应用配置

1. 登录 [飞书开发者后台](https://open.feishu.cn/app)
2. 创建或选择企业自建应用
3. 获取 `App ID` 和 `App Secret`
4. 在 **权限管理** 中开通：
   - `im:message`（获取与发送消息）
   - `im:message:send_as_bot`（以应用身份发消息）

#### Step 2: 配置飞书事件订阅

1. 进入 **事件与回调 > 事件配置**
2. 选择订阅方式：**使用长连接接收事件**
3. 添加订阅事件：`im.message.receive_v1`
4. **不要先保存**，等 WebSocket 启动后再保存

#### Step 3: 获取 OpenCode Session ID

```bash
# 启动 OpenCode（假设在本地运行）
opencode

# 在另一个终端，查询当前 session
curl http://localhost:3000/sessions | jq '.[0].id'

# 或者从 OpenCode TUI 中查看 session ID
```

将获取的 session ID 设置为环境变量：
```bash
export OPENCODE_SESSION_ID="<session_id>"
```

#### Step 4: 获取飞书接收者 ID

选择测试用的飞书用户或群聊：

- **单聊**: 使用用户的 `open_id` 或 `user_id`
- **群聊**: 使用群的 `chat_id`

```bash
export FEISHU_RECEIVER_ID="<receiver_id>"
```

### 5.2 运行原型

#### Step 1: 安装依赖

```bash
cd prototype
npm install
```

#### Step 2: 设置环境变量

```bash
export FEISHU_APP_ID="<your_app_id>"
export FEISHU_APP_SECRET="<your_app_secret>"
export FEISHU_RECEIVER_ID="<receiver_id>"
export OPENCODE_SERVER_URL="http://localhost:3000"  # 如果 OpenCode 在本地运行
export OPENCODE_SESSION_ID="<session_id>"
```

#### Step 3: 启动 WebSocket（先启动）

```bash
npm run start
```

输出：
```
============================================================
飞书 WebSocket 双向交互原型
============================================================
飞书 App ID: cli_xxx
OpenCode Server: http://localhost:3000
============================================================
[WebSocket] 启动飞书 WebSocket 客户端...
[WebSocket] WebSocket 已连接，等待消息...

等待飞书用户回复...
提示：先运行 npm run test-send 发送测试通知
```

**此时 WebSocket 已连接，可以回到飞书后台保存事件订阅配置了。**

#### Step 4: 发送测试通知（另开终端）

```bash
# 在另一个终端，同样设置环境变量
export FEISHU_APP_ID="..."
export FEISHU_APP_SECRET="..."
export FEISHU_RECEIVER_ID="..."
export OPENCODE_SESSION_ID="..."

# 发送测试通知
npm run test-send
```

输出：
```
[Sender] 发送飞书通知: "【原型测试】..."
[Sender] 飞书消息已发送，message_id: om_xxx
[Store] 已存储映射: feishu=om_xxx → session=abc123
[Store] 当前映射数: 1
  om_xxx → session=abc123

下一步：
1. 在飞书中找到刚才发送的消息
2. 回复 "继续"
3. 观察 WebSocket 是否收到消息并触发 OpenCode 继续执行
```

#### Step 5: 飞书用户回复

在飞书中：
1. 找到刚才发送的测试通知
2. 回复消息："继续"

#### Step 6: 观察 WebSocket 处理

WebSocket 终端输出：
```
[WebSocket] 收到消息事件
{
  "schema": "2.0",
  "header": { ... },
  "event": {
    "message": {
      "message_id": "om_reply_xxx",
      "parent_id": "om_xxx",  ← 原通知消息 ID
      "content": "{\"text\":\"继续\"}"
    }
  }
}
[Handler] 收到回复: "继续" (message_id: om_reply_xxx)
[Handler] 识别为"继续执行"
[SDK] 向 session abc123 发送: "继续执行"
[SDK] 响应收到，assistant message id: msg_xxx
[Sender] 飞书消息已发送，message_id: om_confirm_xxx
[Store] 已删除映射: om_xxx
```

#### Step 7: 观察 OpenCode 是否继续执行

在 OpenCode TUI 中，应该看到：
- 新的用户消息："继续执行"
- AI 响应并继续处理

---

## 六、验证检查清单

### 成功标志

| 检查项 | 预期结果 |
|--------|---------|
| WebSocket 启动 | 无错误，显示"已连接" |
| 飞书通知发送 | 返回 message_id，映射存储成功 |
| 飞书用户回复 | WebSocket 接收到消息事件 |
| 映射查找成功 | 根据 parent_id 找到 sessionId |
| 关键词识别 | "继续" 被识别 |
| SDK 调用成功 | session.prompt 返回响应 |
| 飞书确认发送 | 发送"已触发继续执行" |
| OpenCode 继续执行 | TUI 中看到新的 AI 响应 |

### 失败排查

| 问题 | 可能原因 | 解决方法 |
|------|---------|---------|
| WebSocket 启动失败 | App ID/Secret 错误 | 检查环境变量 |
| 飞书通知发送失败 | 权限未开通 | 检查飞书后台权限 |
| WebSocket 未收到消息 | 事件订阅未配置 | 配置 im.message.receive_v1 |
| 映射查找失败 | parent_id 不匹配 | 检查回复是否针对原消息 |
| SDK 调用失败 | session ID 错误或 session 不存在 | 检查 session 是否有效 |
| OpenCode 未继续 | SDK 调用失败或 session 已结束 | 查看 SDK 错误信息 |

---

## 七、调试技巧

### 7.1 查看飞书消息完整结构

在 `handler.ts` 中，消息事件会打印完整 JSON：
```typescript
console.log(JSON.stringify(data, null, 2));
```

### 7.2 查看 OpenCode Session 状态

```bash
curl http://localhost:3000/sessions/<session_id> | jq '.'
```

### 7.3 查看 OpenCode Session 消息

```bash
curl http://localhost:3000/sessions/<session_id>/messages | jq '.'
```

### 7.4 手动测试 SDK 调用

```typescript
// 在 test-send.ts 后添加
import { promptSession } from './sdk-client';

// 直接测试 SDK
await promptSession(sdkClient, config.opencode.sessionId, '测试消息');
```

---

## 八、原型成功标准

### 必须验证的核心流程

1. ✅ 飞书 WebSocket 能接收用户回复消息
2. ✅ 映射存储能正确关联飞书消息与 OpenCode session
3. ✅ 关键词 "继续" 能被正确识别
4. ✅ OpenCode SDK 的 `session.prompt()` 能成功调用
5. ✅ OpenCode session 能继续执行（AI 响应新消息）
6. ✅ 飞书能收到确认回复

### 验证完成后

原型验证成功后，可以：
1. 将原型代码整合到正式 Plugin 中
2. 添加其他场景支持（权限批准、问题回复）
3. 添加完整的错误处理和消息去重
4. 添加过期清理和配置持久化

---

## 九、常见问题

### Q1: 飞书 WebSocket 连接一直失败？

**检查**：
- App ID 和 App Secret 是否正确
- 应用是否是企业自建应用（商店应用不支持 WebSocket）
- 防火墙是否阻止了 WebSocket 连接

### Q2: 发送飞书消息失败？

**检查**：
- 权限是否开通（`im:message`, `im:message:send_as_bot`）
- receiverId 是否正确（用户 open_id 或群 chat_id）
- receiverIdType 是否匹配（`user_id` 或 `chat_id`）

### Q3: WebSocket 收不到消息？

**检查**：
- 飞书后台事件订阅是否配置并保存
- 订阅事件是否包含 `im.message.receive_v1`
- 用户回复是否是针对机器人发送的消息

### Q4: 映射查找失败？

**检查**：
- 飞书回复消息的 `parent_id` 是否指向原通知消息
- 是否先运行了 `test-send` 存储映射
- WebSocket 是否在 `test-send` 之后启动

### Q5: SDK 调用失败？

**检查**：
- session ID 是否有效（session 是否还存在）
- OpenCode server 是否在运行
- serverUrl 是否正确

---

## 十、下一步

原型验证成功后：

1. **阅读** [TECH.md](./TECH.md) 了解完整技术设计
2. **整合** 原型代码到 Plugin 主项目
3. **扩展** 支持更多场景（权限批准、问题回复）
4. **完善** 错误处理、消息去重、过期清理

---

**祝原型验证顺利！** 🚀