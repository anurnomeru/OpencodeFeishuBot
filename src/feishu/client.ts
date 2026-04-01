import type { FeishuConfig } from "../config"

type TenantTokenResponse = {
  code: number
  msg: string
  tenant_access_token?: string
  expire?: number
}

interface TokenCacheEntry {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, TokenCacheEntry>()

function clearTokenCache(config: FeishuConfig) {
  const cacheKey = `${config.appId}:${config.appSecret}`
  tokenCache.delete(cacheKey)
}

function isTokenExpiredError(code: number): boolean {
  return code === 99991663 || code === 99991664 || code === 99991668
}

type MessageResponse = {
  code: number
  msg: string
  data?: {
    message_id?: string
  }
}

type FeishuPostContent = {
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

type InteractiveContent = {
  elements: Array<{
    tag: 'markdown' | 'div' | 'note'
    content?: string
    text?: string
  }>
}

function ensureFetch(): typeof fetch {
  if (typeof fetch === "undefined") {
    throw new Error("Global fetch is not available. Use Node.js 18+.")
  }
  return fetch
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) {
    throw new Error(`Empty response from Feishu API (${response.status}).`)
  }
  return JSON.parse(text) as T
}

export async function getTenantAccessToken(config: FeishuConfig): Promise<string> {
  const cacheKey = `${config.appId}:${config.appSecret}`
  const now = Date.now()
  
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > now + 60000) {
    return cached.token
  }
  
  const fetchImpl = ensureFetch()
  const response = await fetchImpl(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret
      })
    }
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => `Failed to read error response`)
    throw new Error(`Feishu auth request failed: ${response.status} - ${errorText}`)
  }

  const payload = await readJson<TenantTokenResponse>(response)
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`Feishu auth failed: ${payload.msg} (${payload.code})`)
  }

  const expiresIn = payload.expire ? payload.expire * 1000 : 2 * 60 * 60 * 1000
  const expiresAt = now + expiresIn - 60000
  
  tokenCache.set(cacheKey, {
    token: payload.tenant_access_token,
    expiresAt
  })
  
  return payload.tenant_access_token
}

async function sendMessage(
  config: FeishuConfig,
  msgType: "text" | "post" | "interactive",
  content: unknown
): Promise<MessageResponse> {
  const fetchImpl = ensureFetch()
  
  const sendWithToken = async (retryOnTokenExpired = true): Promise<MessageResponse> => {
    const token = await getTenantAccessToken(config)
    const response = await fetchImpl(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${config.receiverType}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          receive_id: config.receiverId,
          msg_type: msgType,
          content: JSON.stringify(content)
        })
      }
    )

    if (!response.ok) {
      const errorText = await response.text().catch(() => `Failed to read error response`)
      throw new Error(`Feishu message request failed: ${response.status} - ${errorText}`)
    }

    const payload = await readJson<MessageResponse>(response)
    if (payload.code !== 0) {
      if (retryOnTokenExpired && isTokenExpiredError(payload.code)) {
        clearTokenCache(config)
        return sendWithToken(false)
      }
      throw new Error(`Feishu message failed: ${payload.msg} (${payload.code})`)
    }

    return payload
  }
  
  return sendWithToken()
}

export async function sendTextMessage(
  config: FeishuConfig,
  text: string
): Promise<MessageResponse> {
  return sendMessage(config, "text", { text })
}

export async function sendMarkdownMessage(
  config: FeishuConfig,
  content: string
): Promise<MessageResponse> {
  const interactiveContent: InteractiveContent = {
    elements: [
      {
        tag: 'markdown',
        content
      }
    ]
  }
  return sendMessage(config, "interactive", interactiveContent)
}

function textToPostContent(text: string, title: string = "OpenCode 通知"): FeishuPostContent {
  const cleanedText = text.split('\n').filter(line => line.trim().length > 0).join('\n')
  
  return {
    post: {
      zh_cn: {
        title,
        content: [
          [
            {
              tag: 'text',
              text: cleanedText,
              un_escape: true
            }
          ]
        ]
      }
    }
  }
}

export async function sendRichTextMessage(
  config: FeishuConfig,
  text: string,
  title?: string,
  richContent?: FeishuPostContent
): Promise<MessageResponse> {
  const postContent = richContent || textToPostContent(text, title)
  return sendMessage(config, "post", postContent)
}
