import os from "os";

export type FeishuPostContent = {
  post: {
    zh_cn: {
      title: string
      content: Array<Array<{
        tag: string
        text?: string
        href?: string
        un_escape?: boolean
      }>>
    }
  }
}

export type NotificationResult = {
  title: string
  text: string
  richContent?: FeishuPostContent
}

export type NotificationType =
  | "interaction_required"
  | "permission_required"
  | "command_args_required"
  | "confirmation_required"
  | "session_idle"
  | "session_error"
  | "question_asked"
  | "setup_test"
  | "generic_event"

type EventPayload = {
  type?: string;
  payload?: unknown;
  properties?: Record<string, unknown>;
}

type SessionContext = {
  sessionID?: string;
  sessionTitle?: string;
  agentName?: string;
};

type SessionClient = {
  session?: {
    get?: (options: { path: { id: string } }) => Promise<{
      data?: {
        title?: string;
      };
    }>;
    messages?: (options: { path: { id: string }; query?: { limit?: number } }) => Promise<{
      data?: Array<{
        info: { role: string; id?: string };
        parts: Array<{ type: string; text?: string }>;
      }>;
    }>;
  };
};

const sessionTitleCache = new Map<string, string>();
const sessionAgentCache = new Map<string, string>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractEventPayload(event?: EventPayload): unknown {
  if (!event) {
    return undefined;
  }
  if (event.payload !== undefined) {
    return event.payload;
  }
  if (event.properties !== undefined) {
    return event.properties;
  }
  return undefined;
}

function extractEventProperties(event?: EventPayload): Record<string, unknown> | undefined {
  if (!event) {
    return undefined;
  }
  if (event.properties) {
    return asRecord(event.properties);
  }
  if (event.payload) {
    return asRecord(event.payload);
  }
  return undefined;
}

function extractSessionContext(event?: EventPayload): SessionContext {
  const properties = extractEventProperties(event);
  const info = asRecord(properties?.info);
  const part = asRecord(properties?.part);

  const sessionID =
    readString(properties?.sessionID) ??
    readString(info?.sessionID) ??
    readString(info?.id) ??
    readString(part?.sessionID);

  const sessionTitle = readString(info?.title);

  const agentName =
    readString(properties?.agent) ??
    readString(info?.agent) ??
    readString(part?.agent) ??
    readString(part?.name);

  return {
    sessionID,
    sessionTitle,
    agentName,
  };
}

export function extractSessionID(event?: EventPayload): string | undefined {
  return extractSessionContext(event).sessionID;
}

async function resolveSessionContext(
  event?: EventPayload,
  client?: SessionClient
): Promise<SessionContext> {
  const baseContext = extractSessionContext(event);
  if (!baseContext.sessionID) {
    return baseContext;
  }

  const cachedTitle = sessionTitleCache.get(baseContext.sessionID);
  const cachedAgent = sessionAgentCache.get(baseContext.sessionID);
  const mergedContext = {
    ...baseContext,
    sessionTitle: baseContext.sessionTitle ?? cachedTitle,
    agentName: baseContext.agentName ?? cachedAgent,
  };

  if (mergedContext.sessionTitle) {
    return mergedContext;
  }

  if (client?.session?.get) {
    try {
      const response = await client.session.get({
        path: { id: baseContext.sessionID },
      });
      const title = response?.data?.title;
      if (title) {
        sessionTitleCache.set(baseContext.sessionID, title);
        return {
          ...mergedContext,
          sessionTitle: title,
        };
      }
    } catch {
      // 忽略会话信息获取失败
    }
  }

  return mergedContext;
}

export function recordEventContext(event?: EventPayload): void {
  const context = extractSessionContext(event);
  if (!context.sessionID) {
    return;
  }

  if (context.sessionTitle) {
    sessionTitleCache.set(context.sessionID, context.sessionTitle);
  }

  if (context.agentName) {
    sessionAgentCache.set(context.sessionID, context.agentName);
  }
}

async function fetchLastAssistantReply(
  sessionID: string,
  client?: SessionClient
): Promise<string | undefined> {
  if (!client?.session?.messages) {
    return undefined;
  }

  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { limit: 5 },
    });

    const messages = response?.data;
    if (!messages || messages.length === 0) {
      return undefined;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info?.role === "assistant") {
        const textParts = msg.parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text as string);

        if (textParts.length > 0) {
          const fullText = textParts.join("\n");
          return fullText.length > 1500 ? fullText.slice(0, 1500) + "…" : fullText;
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// 保持向后兼容的标题映射
const titles: Record<NotificationType, string> = {
  interaction_required: "需要交互",
  permission_required: "需要权限确认",
  command_args_required: "需要补充参数",
  confirmation_required: "需要确认",
  session_idle: "OpenCode 闲暇",
  session_error: "会话结束",
  question_asked: "需要选择方案",
  setup_test: "Feishu 通知测试",
  generic_event: "OpenCode 事件"
}

/**
 * 构建结构化通知消息（新版本）
 * @param type 通知类型
 * @param event 事件数据
 * @param directory 工作目录（可选，默认当前目录）
 * @returns 包含标题和文本的消息对象
 */
export async function buildStructuredNotification(
  type: NotificationType,
  event?: EventPayload,
  directory?: string,
  client?: SessionClient
): Promise<NotificationResult> {
  const { buildStructuredMessage } = await import("./templates")

  const eventPayload = extractEventPayload(event);
  const sessionContext = await resolveSessionContext(event, client);

  let assistantReply: string | undefined;
  if (type === "session_idle" && sessionContext.sessionID) {
    assistantReply = await fetchLastAssistantReply(sessionContext.sessionID, client);
  }
  
  try {
    const text = await buildStructuredMessage(
      type,
      eventPayload,
      event?.type,
      directory,
      sessionContext,
      assistantReply
    )
    
    return {
      title: titles[type],
      text,
      richContent: textToPostContent(text, titles[type])
    }
  } catch (error) {
    return buildLegacyNotification(type, event)
  }
}

/**
 * 构建传统格式的通知消息（向后兼容）
 */
export function buildLegacyNotification(
  type: NotificationType,
  event?: EventPayload
): NotificationResult {
  const title = titles[type]
  if (type === "setup_test") {
    const text = `${title}\nFeishu 通知已启用。`
    return {
      title,
      text,
      richContent: textToPostContent(text, title)
    }
  }

  const payloadText = formatPayload(extractEventPayload(event))
  const sessionContext = extractSessionContext(event)
  const lines = [
    `[OpenCode] ${title}`,
    event?.type ? `事件类型: ${event.type}` : "",
    sessionContext.sessionTitle || sessionContext.sessionID
      ? `会话: ${sessionContext.sessionTitle ?? sessionContext.sessionID}`
      : "",
    sessionContext.agentName ? `Agent: ${sessionContext.agentName}` : "",
    `主机: ${os.hostname()}`,
    payloadText ? `详情: ${payloadText}` : ""
  ].filter(Boolean)

  const text = lines.join("\n")
  return {
    title,
    text,
    richContent: textToPostContent(text, title)
  }
}

/**
 * 格式化负载文本
 */
function formatPayload(payload: unknown): string {
  if (!payload) {
    return ""
  }

  const text = JSON.stringify(payload, null, 2)
  if (text.length > 1200) {
    return `${text.slice(0, 1200)}…`
  }

  return text
}

/**
 * 将文本转换为飞书富文本（post）格式
 * 使用 md tag 支持完整 Markdown 渲染（bold、list、quote、code 等）
 */
function textToPostContent(text: string, title: string = "OpenCode 通知"): FeishuPostContent {
  return {
    post: {
      zh_cn: {
        title,
        content: [
          [{ tag: "md", text }]
        ]
      }
    }
  }
}

/**
 * 构建通知消息（主入口，保持向后兼容）
 * 默认使用结构化消息，失败时回退
 */
export async function buildNotification(
  type: NotificationType,
  event?: EventPayload,
  directory?: string,
  client?: SessionClient
): Promise<NotificationResult> {
  // 默认使用结构化消息
  return buildStructuredNotification(type, event, directory, client)
}
