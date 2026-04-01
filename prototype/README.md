# 飞书 WebSocket 双向交互原型

验证飞书 WebSocket 与 OpenCode 双向交互的最小化原型。

## 快速开始

### 1. 配置飞书应用

1. 登录 [飞书开发者后台](https://open.feishu.cn/app)
2. 创建或选择企业自建应用
3. 获取 `App ID` 和 `App Secret`
4. 开通权限：`im:message`（获取与发送消息）
5. 配置事件订阅：`im.message.receive_v1`（使用长连接接收事件）

### 2. 设置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入实际值
```

或直接设置：

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export FEISHU_RECEIVER_ID="ou_xxx"        # 用户 open_id
export FEISHU_RECEIVER_TYPE="user_id"     # 或 "chat_id"
export OPENCODE_SERVER_URL="http://localhost:3000"
export OPENCODE_SESSION_ID="sess_xxx"     # 先获取
```

### 3. 获取 OpenCode Session ID

```bash
# OpenCode 运行时，查询当前 session
curl http://localhost:3000/sessions | jq '.[0].id'
```

### 4. 运行原型

**终端 1 - 启动 WebSocket 监听：**
```bash
npm run start
```

**终端 2 - 发送测试通知：**
```bash
npm run test-send
```

### 5. 验证流程

1. 飞书收到测试通知
2. 使用飞书的"回复"功能回复 "继续"
3. WebSocket 接收消息并处理
4. OpenCode session 继续执行
5. 飞书收到确认消息

## 目录结构

```
prototype/
├── main.ts          # WebSocket 主程序
├── test-send.ts     # 发送测试通知脚本
├── config.ts        # 配置加载
├── store.ts         # 映射存储（内存）
├── websocket.ts     # 飞书 WebSocket 客户端
├── sender.ts        # 飞书消息发送
├── handler.ts       # 回复处理
├── sdk-client.ts    # OpenCode API 调用
├── package.json
└── .env.example
```

## 支持的回复关键词

| 关键词 | 触发动作 |
|--------|---------|
| 继续 / continue / go / 下一步 / next | 触发 OpenCode 继续执行 |
| 状态 / status / 查询 / query | 查询当前进度 |

## 调试

WebSocket 会打印完整的消息事件 JSON，便于分析飞书消息结构。