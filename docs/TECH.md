# 飞书 WebSocket 双向交互技术调研

> 本文档记录实现 OpenCode 与飞书双向交互的技术调研结果。
> 
> 调研日期：2026-04-01

---

## 一、核心结论

| 方向 | 技术方案 | 可行性 | 状态 |
|------|---------|--------|------|
| **OpenCode → 飞书** | HTTP API 发送通知 | ✅ 可行 | 已实现 |
| **飞书 → OpenCode** | WebSocket 接收 + SDK 反向调用 | ✅ 可行 | 待开发 |

**双向交互可行**，关键技术点：
- 飞书支持 WebSocket 长连接接收用户消息
- OpenCode Plugin 提供完整的反向调用 API

---

## 二、飞书 WebSocket 技术细节

### 2.1 SDK 信息

- **包名**: `@larksuiteoapi/node-sdk`
- **版本要求**: ≥ 1.24.0
- **官方文档**: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case

### 2.2 核心组件

| 组件 | 用途 | 说明 |
|------|------|------|
| `Lark.WSClient` | WebSocket 客户端 | 接收飞书推送的事件 |
| `Lark.Client` | HTTP API 客户端 | 发送消息、调用 OpenAPI |
| `Lark.EventDispatcher` | 事件分发器 | 注册事件处理器 |

### 2.3 WebSocket 客户端初始化

```typescript
import * as Lark from '@larksuiteoapi/node-sdk';

const wsClient = new Lark.WSClient({
  appId: 'YOUR_APP_ID',
  appSecret: 'YOUR_APP_SECRET',
  loggerLevel: Lark.LoggerLevel.warn,  // info, debug, warn, error
  domain: Lark.Domain.Feishu,          // 默认 open.feishu.cn
});
```

### 2.4 HTTP API 客户端初始化

```typescript
const apiClient = new Lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
  appType: Lark.AppType.SelfBuild,  // 企业自建应用
  domain: Lark.Domain.Feishu,
});
```

### 2.5 消息接收事件结构

**事件类型**: `im.message.receive_v1`

**完整 JSON 结构**:

```json
{
  "schema": "2.0",
  "header": {
    "event_id": "5e3702a84e847582be8db7fb73283c02",
    "event_type": "im.message.receive_v1",
    "create_time": "1608725989000",
    "token": "rvaYgkND1GOiu5MM0E1rncYC6PLtF7JV",
    "app_id": "cli_9f5343c580712544",
    "tenant_key": "2ca1d211f64f6438"
  },
  "event": {
    "sender": {
      "sender_id": {
        "union_id": "on_8ed6aa67826108097d9ee143816345",
        "user_id": "e33ggbyz",
        "open_id": "ou_84aad35d084aa403a838cf73ee18467"
      },
      "sender_type": "user",
      "tenant_key": "736588c9260f175e"
    },
    "message": {
      "message_id": "om_5ce6d572455d361153b7cb51da133945",
      "root_id": "om_5ce6d572455d361153b7cb5xxfsdfsdfdsf",
      "parent_id": "om_5ce6d572455d361153b7cb5xxfsdfsdfdsf",
      "create_time": "1609073151345",
      "chat_id": "oc_5ce6d572455d361153b7xx51da133945",
      "thread_id": "omt_d4be107c616",
      "chat_type": "group",
      "message_type": "text",
      "content": "{\"text\":\"@_user_1 hello\"}",
      "mentions": [...]
    }
  }
}
```

**关键字段说明**:

| 字段路径 | 类型 | 说明 | 用途 |
|---------|------|------|------|
| `header.event_id` | string | 事件唯一 ID | 日志追踪 |
| `event.message.message_id` | string | 消息唯一 ID | 去重、回复引用 |
| `event.message.chat_id` | string | 会话 ID | 发送回复 |
| `event.message.content` | string (JSON) | 消息内容 | 解析用户输入 |
| `event.sender.sender_id.open_id` | string | 发送者 ID | 身份识别 |
| `event.message.chat_type` | string | 会话类型 | `p2p` / `group` |
| `event.message.message_type` | string | 消息类型 | `text` / `post` / `image` |

### 2.6 消息内容解析

飞书消息的 `content` 字段是 JSON 字符串，需要解析：

```typescript
function parseFeishuTextContent(content: string): string {
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj.text === "string") {
      return obj.text;
    }
    return String(content);
  } catch {
    return String(content);
  }
}
```

### 2.7 发送回复消息

```typescript
// 发送文本消息
await apiClient.im.v1.message.create({
  params: { receive_id_type: "chat_id" },
  data: {
    receive_id: chatId,
    content: JSON.stringify({ text: "回复内容" }),
    msg_type: "text",
  },
});

// 发送富文本消息
await apiClient.im.v1.message.create({
  params: { receive_id_type: "chat_id" },
  data: {
    receive_id: chatId,
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: "标题" } },
      elements: [
        { tag: "markdown", content: "内容" }
      ],
    }),
    msg_type: "interactive",
  },
});
```

### 2.8 消息去重机制

飞书可能在特殊场景下重复推送同一条消息，需做幂等处理：

```typescript
const PROCESSED_MESSAGE_IDS = new Map<string, number>();
const PROCESSED_TTL_MS = 5 * 60 * 1000;  // 5分钟

function isMessageAlreadyProcessed(messageId: string): boolean {
  const now = Date.now();
  if (PROCESSED_MESSAGE_IDS.has(messageId)) {
    const ts = PROCESSED_MESSAGE_IDS.get(messageId)!;
    if (now - ts < PROCESSED_TTL_MS) {
      return true;
    }
    PROCESSED_MESSAGE_IDS.delete(messageId);
  }
  return false;
}

function markMessageProcessed(messageId: string): void {
  PROCESSED_MESSAGE_IDS.set(messageId, Date.now());
}
```

### 2.9 事件处理器注册

```typescript
const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data: any) => {
    try {
      const msg = data?.message;
      const messageId = msg?.message_id;
      
      // 去重检查
      if (messageId && isMessageAlreadyProcessed(messageId)) {
        return;
      }
      if (messageId) {
        markMessageProcessed(messageId);
      }
      
      // 解析内容
      const content = JSON.parse(msg?.content || '{}');
      const text = content.text || '';
      if (!text.trim()) return;
      
      // 处理消息
      await handleMessage({
        messageId,
        chatId: msg.chat_id,
        text,
        senderId: data?.sender?.sender_id?.open_id,
      });
    } catch (err) {
      console.error('处理消息出错:', err);
    }
  },
});

await wsClient.start({ eventDispatcher });
```

### 2.10 官方限制与约束

| 限制项 | 说明 | 影响 |
|--------|------|------|
| 应用类型 | 仅支持企业自建应用 | 不支持商店应用 |
| 连接数上限 | 每个应用最多 50 个连接 | 单实例足够 |
| 消息推送模式 | 集群模式（不广播） | 多实例时只有一个收到 |
| 处理时限 | 必须在 3 秒内完成 | 需快速处理或异步 |
| 网络要求 | 需能访问公网 | 无需公网 IP |

---

## 三、OpenCode Plugin 反向调用能力

### 3.1 Plugin Input 结构

```typescript
type PluginInput = {
  client: OpencodeClient,    // ✅ 完整 API 客户端
  project: Project,          // 项目元数据
  directory: string,         // 工作目录
  worktree: string,          // Worktree 路径
  serverUrl: URL,            // Server URL
  $: BunShell                // Shell 执行助手
}
```

### 3.2 反向调用 API 列表

| API | 用途 | 参数 | 说明 |
|-----|------|------|------|
| `client.session.prompt()` | 发送消息到会话 | `{ path: { id }, body: { parts } }` | 触发 AI 响应 |
| `client.session.promptAsync()` | 异步发送 | 同上 | 立即返回，自动启动会话 |
| `client.session.command()` | 执行命令 | `{ path: { id }, body: { command } }` | 如 `/refactor` |
| `client.session.shell()` | 执行 Shell | `{ path: { id }, body: { script } }` | 在会话中执行 |
| `client.tui.appendPrompt()` | 填充输入框 | `{ body: { text } }` | 模拟用户输入 |
| `client.tui.submitPrompt()` | 提交输入 | 无参数 | 触发执行 |
| `client.tui.showToast()` | 显示通知 | `{ body: { message, variant } }` | 反馈用户 |
| `client.tui.executeCommand()` | 执行 TUI 命令 | `{ body: { command } }` | TUI 内部命令 |
| `client.tui.clearPrompt()` | 清空输入框 | 无参数 | 清除当前输入 |
| `client.postSessionIdPermissionsPermissionId()` | 回复权限请求 | `{ path, body: { status } }` | `"once"` / `"always"` / `"reject"` |

### 3.3 session.prompt 详细用法

```typescript
// 发送消息并触发 AI 响应
const response = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [
      { type: "text", text: "用户在飞书回复：继续执行" }
    ]
  }
});
// 返回: AssistantMessage（AI 的响应）

// 仅注入上下文，不触发响应（静默注入）
await client.session.prompt({
  path: { id: sessionId },
  body: {
    noReply: true,  // ✅ 关键参数
    parts: [
      { type: "text", text: "上下文信息..." }
    ]
  }
});
// 返回: 立即完成，不等待 AI 响应
```

### 3.4 权限回复用法

```typescript
// 批准一次
await client.postSessionIdPermissionsPermissionId({
  path: {
    sessionId: sessionId,
    permissionId: permissionId
  },
  body: {
    status: "once"  // 或 "always" 或 "reject"
  }
});
```

### 3.5 TUI 控制用法

```typescript
// 填充输入框
await client.tui.appendPrompt({
  body: { text: "用户回复的内容" }
});

// 提交（触发 OpenCode 处理）
await client.tui.submitPrompt();

// 显示通知
await client.tui.showToast({
  body: {
    message: "已收到飞书回复",
    variant: "success",  // info, success, warning, error
    title: "飞书通知",
    duration: 3000
  }
});
```

### 3.6 当前限制

| 限制 | 说明 | 解决方案 |
|------|------|---------|
| `session.idle` 时机 | 循环已停止后触发 | 使用 `promptAsync` 自动重启 |
| 无 `session.stopping` hook | Issue #16626 仍在提案 | 使用 `prompt` 重新进入 |
| 无静默消息注入显示 | `noReply` 消息不显示 | 可接受，纯上下文注入 |

---

## 四、支持场景设计

### 4.1 场景总览

| 场景 | OpenCode 事件 | 飞书通知内容 | 预期用户回复 | 反向调用 API |
|------|--------------|-------------|-------------|-------------|
| **继续执行** | `session.status` (idle) | 会话已完成/等待 | "继续" | `session.prompt()` |
| **权限批准** | `permission.asked` | 需要文件访问权限 | "批准" / "拒绝" | `postSessionIdPermissionsPermissionId()` |
| **问题回复** | `question.asked` | 需要选择方案 | 选项内容 | `session.prompt()` |
| **交互输入** | `tui.prompt.append` | 需要输入内容 | 输入文本 | `tui.appendPrompt()` + `tui.submitPrompt()` |

### 4.2 场景一：继续执行

**触发条件**: OpenCode 会话进入 idle 状态

**流程设计**:

```
┌─────────────────────────────────────────────────────────────────┐
│  继续执行场景流程                                                │
└─────────────────────────────────────────────────────────────────┘

1. OpenCode → idle 状态
   └─ Plugin 监听 session.status 事件
   └─ 发送飞书通知："任务已完成，是否继续？"
   └─ 存储: sessionId + feishuMessageId

2. 飞书用户回复 "继续" 或 "继续执行"
   └─ WebSocket 接收消息
   └─ 解析内容，匹配关键词
   └─ 根据映射找到 sessionId

3. 调用 OpenCode API
   └─ client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: "继续" }] }
      })
   └─ OpenCode 重新启动会话处理

4. 发送飞书确认
   └─ "已继续执行..."
```

**关键词匹配规则**:
- `继续` / `继续执行` / `go` / `continue` → 继续执行
- `停止` / `结束` / `stop` / `abort` → 终止会话

**代码示例**:

```typescript
// 处理继续执行回复
async function handleContinueReply(sessionId: string, text: string) {
  const normalizedText = text.toLowerCase().trim();
  
  if (normalizedText.match(/继续|continue|go/i)) {
    // 继续执行
    await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: "继续执行" }] }
    });
    await sendFeishuReply(chatId, "已继续执行...");
    
  } else if (normalizedText.match(/停止|stop|abort/i)) {
    // 终止会话
    await client.session.abort({ path: { id: sessionId } });
    await sendFeishuReply(chatId, "已终止会话");
  }
}
```

### 4.3 场景二：权限批准

**触发条件**: OpenCode 请求文件访问权限

**流程设计**:

```
┌─────────────────────────────────────────────────────────────────┐
│  权限批准场景流程                                                │
└─────────────────────────────────────────────────────────────────┘

1. OpenCode → permission.asked 事件
   └─ Plugin 监听事件
   └─ 发送飞书通知："需要访问文件 /path/to/file"
   └─ 存储: sessionId + permissionId + feishuMessageId

2. 飞书用户回复 "批准" 或 "拒绝"
   └─ WebSocket 接收消息
   └─ 解析内容，匹配关键词
   └─ 根据映射找到 sessionId + permissionId

3. 调用 OpenCode API
   └─ client.postSessionIdPermissionsPermissionId({
        path: { sessionId, permissionId },
        body: { status: "once" 或 "reject" }
      })

4. 发送飞书确认
   └─ "已批准文件访问" / "已拒绝权限请求"
```

**关键词匹配规则**:
- `批准` / `允许` / `yes` / `approve` / `ok` → 批准 (`once`)
- `总是批准` / `always` → 永久批准 (`always`)
- `拒绝` / `no` / `reject` / `deny` → 拒绝 (`reject`)

**代码示例**:

```typescript
// 处理权限批准回复
async function handlePermissionReply(
  sessionId: string,
  permissionId: string,
  text: string
) {
  const normalizedText = text.toLowerCase().trim();
  
  let status: "once" | "always" | "reject";
  
  if (normalizedText.match(/总是批准|always/i)) {
    status = "always";
  } else if (normalizedText.match(/批准|允许|yes|approve|ok/i)) {
    status = "once";
  } else if (normalizedText.match(/拒绝|no|reject|deny/i)) {
    status = "reject";
  } else {
    // 无法识别，请求用户重新回复
    await sendFeishuReply(chatId, "无法识别，请回复：批准 / 拒绝");
    return;
  }
  
  await client.postSessionIdPermissionsPermissionId({
    path: { sessionId, permissionId },
    body: { status }
  });
  
  const message = status === "reject" 
    ? "已拒绝权限请求" 
    : status === "always" 
      ? "已永久批准文件访问"
      : "已批准本次文件访问";
  await sendFeishuReply(chatId, message);
}
```

### 4.4 场景三：问题回复（选择方案）

**触发条件**: OpenCode 需要用户选择方案（如重构方案选择）

**流程设计**:

```
┌─────────────────────────────────────────────────────────────────┐
│  问题回复场景流程                                                │
└─────────────────────────────────────────────────────────────────┘

1. OpenCode → question.asked 事件
   └─ Plugin 监听事件
   └─ 发送飞书通知："请选择方案：\n1. 方案A\n2. 方案B\n3. 方案C"
   └─ 存储: sessionId + questionId + feishuMessageId

2. 飞书用户回复 "1" 或 "方案A" 或 "A"
   └─ WebSocket 接收消息
   └─ 解析内容，匹配选项
   └─ 根据映射找到 sessionId

3. 调用 OpenCode API
   └─ client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: "选择方案A" }] }
      })

4. 发送飞书确认
   └─ "已选择方案A，继续执行..."
```

**关键词匹配规则**:
- 数字: `1` / `2` / `3` → 对应选项
- 方案名: `方案A` / `A` / `a` → 方案A
- 具体内容: 根据问题选项内容匹配

**代码示例**:

```typescript
// 处理问题回复
async function handleQuestionReply(
  sessionId: string,
  questionOptions: string[],
  text: string
) {
  const normalizedText = text.trim();
  
  // 尝试匹配数字选项
  const numMatch = normalizedText.match(/^(\d+)$/);
  if (numMatch) {
    const index = parseInt(numMatch[1]) - 1;
    if (index >= 0 && index < questionOptions.length) {
      const selectedOption = questionOptions[index];
      await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: selectedOption }] }
      });
      await sendFeishuReply(chatId, `已选择: ${selectedOption}`);
      return;
    }
  }
  
  // 尝试匹配方案名
  for (const option of questionOptions) {
    if (normalizedText.toLowerCase().includes(option.toLowerCase())) {
      await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: option }] }
      });
      await sendFeishuReply(chatId, `已选择: ${option}`);
      return;
    }
  }
  
  // 无法匹配
  await sendFeishuReply(chatId, 
    `无法识别选项，请回复选项编号或名称\n可用选项:\n${questionOptions.map((o, i) => `${i+1}. ${o}`).join('\n')}`
  );
}
```

### 4.5 场景四：交互式输入

**触发条件**: OpenCode TUI 需要用户输入（如命令参数）

**流程设计**:

```
┌─────────────────────────────────────────────────────────────────┐
│  交互式输入场景流程                                              │
└─────────────────────────────────────────────────────────────────┘

1. OpenCode → tui.prompt.append 事件
   └─ Plugin 监听事件
   └─ 发送飞书通知："请输入命令参数..."
   └─ 存储: sessionId + feishuMessageId

2. 飞书用户回复输入内容
   └─ WebSocket 接收消息
   └─ 解析内容
   └─ 根据映射找到 sessionId

3. 调用 OpenCode TUI API
   └─ client.tui.appendPrompt({ body: { text: userInput } })
   └─ client.tui.submitPrompt()
   └─ 触发 OpenCode 处理

4. 发送飞书确认
   └─ "已提交输入..."
```

**代码示例**:

```typescript
// 处理交互式输入回复
async function handleInputReply(sessionId: string, text: string) {
  // 填充到 TUI 输入框
  await client.tui.appendPrompt({
    body: { text }
  });
  
  // 提交，触发执行
  await client.tui.submitPrompt();
  
  // 发送飞书确认
  await sendFeishuReply(chatId, "已提交输入，正在处理...");
}
```

---

## 五、架构设计

### 5.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          双向交互整体架构                                │
└─────────────────────────────────────────────────────────────────────────┘

                           ┌──────────────┐
                           │   OpenCode   │
                           │   Server     │
                           └──────┬───────┘
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
                  ▼               ▼               ▼
           Plugin Events    client.session    client.tui
           (监听状态)        .prompt()        .submitPrompt()
                  │               │               │
                  └───────────────┴───────────────┘
                                  │
                           ┌──────┴───────┐
                           │   Plugin     │
                           │   Core Logic │
                           │              │
                           │ ┌──────────┐ │
                           │ │ Mapping  │ │ ← Session-Message 映射存储
                           │ │  Store   │ │   (内存 Map)
                           │ └──────────┘ │
                           └──────┬───────┘
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
                  ▼               ▼               ▼
           HTTP API          WebSocket          Reply Parser
           (发送通知)         (接收回复)         (内容解析)
                  │               │               │
                  └───────────────┴───────────────┘
                                  │
                           ┌──────┴───────┐
                           │   飞书平台    │
                           │              │
                           │  ┌────────┐  │
                           │  │ 用户   │  │
                           │  └────────┘  │
                           └──────┬───────┘
                                  │
                           用户回复消息
```

### 5.2 核心模块设计

#### 模块一：WebSocket 客户端 (`src/feishu/websocket.ts`)

```typescript
// 职责：接收飞书消息，分发到处理器
export class FeishuWebSocket {
  private wsClient: Lark.WSClient;
  private apiClient: Lark.Client;
  
  constructor(config: FeishuConfig) {
    this.wsClient = new Lark.WSClient({ ...config });
    this.apiClient = new Lark.Client({ ...config });
  }
  
  async start(handler: MessageHandler): Promise<void> {
    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data) => handler.handle(data),
      }),
    });
  }
  
  async stop(): Promise<void> {
    await this.wsClient.stop?.();
  }
}
```

#### 模块二：消息映射存储 (`src/store/mapping.ts`)

```typescript
// 职责：存储 session/message 映射关系
export type PendingAction = {
  sessionId: string;
  actionType: 'continue' | 'permission' | 'question' | 'input';
  permissionId?: string;
  questionOptions?: string[];
  createdAt: number;
};

export class MappingStore {
  private mappings: Map<string, PendingAction> = new Map();
  private ttlMs: number = 30 * 60 * 1000; // 30分钟
  
  // 飞书 message_id → PendingAction
  set(feishuMessageId: string, action: PendingAction): void {
    this.mappings.set(feishuMessageId, action);
    this.cleanupExpired();
  }
  
  get(feishuMessageId: string): PendingAction | undefined {
    this.cleanupExpired();
    return this.mappings.get(feishuMessageId);
  }
  
  delete(feishuMessageId: string): void {
    this.mappings.delete(feishuMessageId);
  }
  
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, action] of this.mappings.entries()) {
      if (now - action.createdAt > this.ttlMs) {
        this.mappings.delete(key);
      }
    }
  }
}
```

#### 模块三：回复处理器 (`src/handler/reply.ts`)

```typescript
// 职责：解析回复内容，调用对应的 OpenCode API
export class ReplyHandler {
  constructor(
    private client: OpencodeClient,
    private store: MappingStore,
    private feishu: FeishuWebSocket
  ) {}
  
  async handle(data: any): Promise<void> {
    const msg = data?.message;
    const messageId = msg?.message_id;
    const content = parseFeishuTextContent(msg?.content);
    
    // 查找映射
    const action = this.store.get(messageId);
    if (!action) {
      // 不是针对我们通知的回复，忽略
      return;
    }
    
    // 根据场景类型处理
    switch (action.actionType) {
      case 'continue':
        await this.handleContinue(action.sessionId, content);
        break;
      case 'permission':
        await this.handlePermission(
          action.sessionId,
          action.permissionId!,
          content
        );
        break;
      case 'question':
        await this.handleQuestion(
          action.sessionId,
          action.questionOptions!,
          content
        );
        break;
      case 'input':
        await this.handleInput(action.sessionId, content);
        break;
    }
    
    // 清除映射
    this.store.delete(messageId);
  }
  
  private async handleContinue(sessionId: string, text: string): Promise<void> {
    // ... 见场景一实现
  }
  
  private async handlePermission(...): Promise<void> {
    // ... 见场景二实现
  }
  
  private async handleQuestion(...): Promise<void> {
    // ... 见场景三实现
  }
  
  private async handleInput(...): Promise<void> {
    // ... 见场景四实现
  }
}
```

#### 模块四：通知发送改造 (`src/feishu/messages.ts`)

```typescript
// 改造：发送通知时，同时存储映射关系
export async function buildNotification(
  client: OpencodeClient,
  event: Event,
  store: MappingStore
): Promise<Notification | null> {
  const sessionId = event.properties?.info?.id;
  
  // 根据事件类型构建通知和 PendingAction
  switch (event.name) {
    case 'session.status':
      if (event.properties?.status === 'idle') {
        return {
          message: '任务已完成，是否继续？',
          action: {
            sessionId,
            actionType: 'continue',
            createdAt: Date.now(),
          },
        };
      }
      break;
      
    case 'permission.asked':
      const permissionId = event.properties?.permission?.id;
      return {
        message: `需要访问文件权限，是否批准？`,
        action: {
          sessionId,
          actionType: 'permission',
          permissionId,
          createdAt: Date.now(),
        },
      };
      
    // ... 其他场景
  }
  
  return null;
}

// 发送通知后存储映射
export async function sendNotification(
  feishu: FeishuClient,
  notification: Notification,
  store: MappingStore
): Promise<void> {
  const feishuMessageId = await feishu.sendMessage(notification.message);
  
  if (notification.action) {
    store.set(feishuMessageId, notification.action);
  }
}
```

### 5.3 插件入口改造 (`src/index.ts`)

```typescript
export default async ({ client, ... }: PluginInput) => {
  // 初始化组件
  const config = loadFeishuConfig();
  const store = new MappingStore();
  const websocket = new FeishuWebSocket(config);
  const handler = new ReplyHandler(client, store, websocket);
  
  // 启动 WebSocket
  await websocket.start(handler);
  
  return {
    event: async ({ event }) => {
      // 构建通知
      const notification = await buildNotification(client, event, store);
      
      // 发送通知并存储映射
      if (notification) {
        await sendNotification(websocket.apiClient, notification, store);
      }
    },
    
    // 清理
    destroy: async () => {
      await websocket.stop();
    },
  };
};
```

---

## 六、数据流详解

### 6.1 完整数据流图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           数据流详解                                     │
└─────────────────────────────────────────────────────────────────────────┘

时间线 ↓

T0: OpenCode 触发事件
┌──────────────────────────────────────────────────────────────┐
│  OpenCode Session (sessionId: abc123)                        │
│  Event: permission.asked                                      │
│  Properties: { permissionId: perm456, path: /src/file.ts }   │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  Plugin Event Handler                                         │
│  1. 构建 Notification { message, action }                     │
│  2. action = { sessionId: abc123, actionType: 'permission',  │
│               permissionId: perm456, createdAt: T0 }          │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  HTTP API 发送飞书通知                                         │
│  POST /open-apis/im/v1/messages                               │
│  返回: { message_id: feishu789 }                              │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  MappingStore 存储                                            │
│  mappings.set('feishu789', action)                            │
│  Map: {                                                       │
│    'feishu789' → {                                            │
│      sessionId: 'abc123',                                     │
│      actionType: 'permission',                                │
│      permissionId: 'perm456',                                 │
│      createdAt: T0                                            │
│    }                                                          │
│  }                                                            │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  飞书用户收到通知                                              │
│  "需要访问文件 /src/file.ts 的权限，是否批准？"                │
└──────────────────────────────────────────────────────────────┘


T1: 飞书用户回复
┌──────────────────────────────────────────────────────────────┐
│  飞书用户回复："批准"                                          │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  飞书 WebSocket 推送事件                                       │
│  Event: im.message.receive_v1                                 │
│  Data: {                                                      │
│    message: {                                                 │
│      message_id: 'feishu_reply_999',                          │
│      parent_id: 'feishu789',  ← 关联原通知                    │
│      chat_id: 'oc_xxx',                                        │
│      content: '{"text":"批准"}'                               │
│    }                                                          │
│  }                                                            │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  Plugin WebSocket Handler                                     │
│  1. 解析 content: "批准"                                       │
│  2. 查找映射: 根据 parent_id 'feishu789' 找到 action          │
│  3. actionType = 'permission'                                 │
│  4. sessionId = 'abc123', permissionId = 'perm456'            │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  调用 OpenCode API                                            │
│  client.postSessionIdPermissionsPermissionId({                │
│    path: { sessionId: 'abc123', permissionId: 'perm456' },    │
│    body: { status: 'once' }                                   │
│  })                                                           │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  OpenCode 处理权限                                            │
│  权限批准，继续执行                                            │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  飞书发送确认                                                  │
│  "已批准文件访问，继续执行..."                                  │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  清除映射                                                      │
│  store.delete('feishu789')                                    │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 关键数据结构

```typescript
// 映射存储键值结构
type MappingKey = string;  // 飞书 message_id

type MappingValue = PendingAction;

type PendingAction = {
  sessionId: string;            // OpenCode session ID
  actionType: ActionType;       // 场景类型
  permissionId?: string;        // 权限 ID（仅 permission 场景）
  questionOptions?: string[];   // 问题选项（仅 question 场景）
  createdAt: number;            // 创建时间戳
};

type ActionType = 'continue' | 'permission' | 'question' | 'input';

// 飞书消息解析结构
type FeishuMessage = {
  messageId: string;            // 消息 ID
  parentId?: string;            // 父消息 ID（回复关联）
  chatId: string;               // 会话 ID
  content: string;              // 消息内容（JSON字符串）
  senderId: string;             // 发送者 ID
  chatType: 'p2p' | 'group';    // 会话类型
};
```

---

## 七、错误处理设计

### 7.1 错误场景

| 错误场景 | 处理方式 |
|---------|---------|
| WebSocket 连接断开 | SDK 自动重连，无需手动处理 |
| 映射不存在（回复过期） | 发送飞书提示："操作已过期，请重新开始" |
| 关键词无法识别 | 发送飞书提示："无法识别，请回复：批准/拒绝" |
| OpenCode API 调用失败 | 发送飞书提示："操作失败，请重试" |
| 消息处理超时（>3秒） | 异步处理，立即返回飞书确认，后台继续 |

### 7.2 错误处理代码

```typescript
async function handleReplyWithErrorHandling(
  data: any,
  handler: ReplyHandler
): Promise<void> {
  try {
    const msg = data?.message;
    const parentId = msg?.parent_id;  // 回复的原消息 ID
    
    // 查找映射
    const action = store.get(parentId);
    if (!action) {
      // 映射不存在，可能已过期
      await sendFeishuReply(msg.chat_id, 
        "操作已过期（超过30分钟），请在 OpenCode 中重新开始。"
      );
      return;
    }
    
    // 处理回复
    await handler.handle(data);
    
  } catch (error) {
    console.error('处理飞书回复出错:', error);
    
    // 发送错误提示
    await sendFeishuReply(msg?.chat_id, 
      `处理失败: ${error.message}\n请重试或在 OpenCode 中手动操作。`
    );
  }
}
```

---

## 八、飞书后台配置

### 8.1 配置步骤

1. 登录 [飞书开发者后台](https://open.feishu.cn/app)
2. 选择企业自建应用
3. 进入 **事件与回调 > 事件配置**
4. 选择订阅方式：**使用长连接接收事件**
5. 添加订阅事件：
   - `im.message.receive_v1`（接收消息）
   - `im.message.message_read_v1`（可选，已读回执）
6. 确保 WebSocket 客户端已启动，才能保存配置成功

### 8.2 权限配置

在 **权限管理** 中开通以下权限：

| 权限名称 | 权限代码 | 用途 |
|---------|---------|------|
| 获取与发送单聊、群聊消息 | `im:message` | 发送通知、接收回复 |
| 获取用户基本信息 | `contact:user.base:readonly` | 获取发送者信息 |
| 以应用身份读取群消息 | `im:message.group_msg:readonly` | 接收群消息 |

---

## 九、参考资源

### 9.1 官方文档

- [飞书 WebSocket 长连接文档](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- [Node.js SDK 文档](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)
- [消息接收事件文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)

### 9.2 实际项目代码

- [openclawx 飞书适配器](https://github.com/next-open-ai/openclawx/blob/main/src/gateway/channel/adapters/feishu.ts) - 完整的双向交互实现
- [飞书官方 SDK](https://github.com/larksuite/node-sdk) - SDK 源码和示例

### 9.3 OpenCode 相关

- [OpenCode Plugin 文档](https://opencode.ai/docs/plugins/)
- [OpenCode SDK 文档](https://opencode.ai/docs/sdk/)
- [Issue #16626: session.stopping hook](https://github.com/anomalyco/opencode/issues/16626)

---

## 十、总结

### 10.1 技术可行性结论

| 问题 | 答案 |
|------|------|
| 飞书是否支持 WebSocket？ | ✅ 支持，用于接收事件 |
| OpenCode Plugin 能反向调用？ | ✅ 能，有完整的 API |
| 双向交互是否可行？ | ✅ 可行 |
| 所有场景是否支持？ | ✅ 支持（继续执行、权限批准、问题回复、交互输入） |

### 10.2 实现要点

1. **飞书 WebSocket**: 接收用户回复消息
2. **映射存储**: 关联飞书消息与 OpenCode session/permission
3. **回复解析**: 识别用户意图（关键词匹配）
4. **反向调用**: 根据场景调用对应的 OpenCode API
5. **错误处理**: 处理过期、无法识别、API失败等情况

### 10.3 下一步

参见 [PROTOTYPE.md](./PROTOTYPE.md) - 最小化原型验证流程。