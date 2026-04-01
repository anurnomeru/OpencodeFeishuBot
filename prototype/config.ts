import fs from "fs"
import os from "os"
import path from "path"

export type ReceiverType = "user_id" | "open_id" | "chat_id"

export interface FeishuConfig {
  appId: string
  appSecret: string
  receiverType: ReceiverType
  receiverId: string
}

export interface PrototypeConfig {
  feishu: FeishuConfig
  opencode: {
    serverUrl: string
    sessionId: string
  }
}

const receiverTypes: ReceiverType[] = ["user_id", "open_id", "chat_id"]

function getConfigPaths(): string[] {
  const paths: string[] = []
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  paths.push(path.join(xdgConfig, "opencode", "feishu-notifier.json"))
  return paths
}

function readConfigFile(filePath: string): Partial<FeishuConfig> | null {
  if (!fs.existsSync(filePath)) {
    return null
  }
  const raw = fs.readFileSync(filePath, "utf8").trim()
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as Partial<FeishuConfig>
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`)
  }
}

function readEnvConfig(): Partial<FeishuConfig> {
  return {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    receiverType: process.env.FEISHU_RECEIVER_TYPE as ReceiverType | undefined,
    receiverId: process.env.FEISHU_RECEIVER_ID
  }
}

function resolveFeishuConfig(): { config: Partial<FeishuConfig>; sources: string[] } {
  let mergedConfig: Partial<FeishuConfig> = {}
  const sources: string[] = []

  for (const configPath of getConfigPaths()) {
    const config = readConfigFile(configPath)
    if (config) {
      mergedConfig = { ...mergedConfig, ...config }
      sources.push(`file: ${configPath}`)
    }
  }

  const envConfig = readEnvConfig()
  if (envConfig.appId || envConfig.appSecret || envConfig.receiverType || envConfig.receiverId) {
    mergedConfig = { ...mergedConfig, ...envConfig }
    sources.push("env: FEISHU_*")
  }

  return { config: mergedConfig, sources }
}

function finalizeFeishuConfig(mergedConfig: Partial<FeishuConfig>, sources: string[]): FeishuConfig {
  if (sources.length === 0) {
    throw new Error(
      "Missing Feishu configuration. Create ~/.config/opencode/feishu-notifier.json or set FEISHU_* env vars."
    )
  }

  const missing: string[] = []
  if (!mergedConfig.appId) missing.push("appId")
  if (!mergedConfig.appSecret) missing.push("appSecret")
  if (!mergedConfig.receiverType) missing.push("receiverType")
  if (!mergedConfig.receiverId) missing.push("receiverId")

  if (missing.length > 0) {
    throw new Error(`Missing config fields: ${missing.join(", ")}`)
  }

  const receiverType = mergedConfig.receiverType as ReceiverType
  if (!receiverTypes.includes(receiverType)) {
    throw new Error(`Invalid receiverType: ${mergedConfig.receiverType}`)
  }

  return {
    appId: mergedConfig.appId!,
    appSecret: mergedConfig.appSecret!,
    receiverType,
    receiverId: mergedConfig.receiverId!
  }
}

export function loadFeishuConfig(): { config: FeishuConfig; sources: string[] } {
  const { config: mergedConfig, sources } = resolveFeishuConfig()
  return {
    config: finalizeFeishuConfig(mergedConfig, sources),
    sources
  }
}

export function loadConfig(sessionId?: string): PrototypeConfig {
  const { config: feishuConfig, sources } = loadFeishuConfig()
  
  const serverUrl = process.env.OPENCODE_SERVER_URL || 'http://localhost:3000'
  const sid = sessionId || process.env.OPENCODE_SESSION_ID || ''
  
  console.log(`[Config] 配置来源: ${sources.join(', ')}`)
  console.log(`[Config] 飞书 App ID: ${feishuConfig.appId}`)
  console.log(`[Config] 接收者: ${feishuConfig.receiverType}=${feishuConfig.receiverId}`)
  console.log(`[Config] OpenCode Server: ${serverUrl}`)
  
  return {
    feishu: feishuConfig,
    opencode: {
      serverUrl,
      sessionId: sid,
    },
  }
}

export function validateSessionId(config: PrototypeConfig): { valid: boolean; error?: string } {
  if (!config.opencode.sessionId) {
    return {
      valid: false,
      error: "请设置 OPENCODE_SESSION_ID 环境变量，或在运行时传入 --session 参数"
    }
  }
  return { valid: true }
}