import type { Plugin } from "@opencode-ai/plugin";
import { loadConfigWithSource } from "./config";
import { sendMarkdownMessage, sendTextMessage, sendRichTextMessage, sendInteractiveCard, buildPermissionCard, buildQuestionCard } from "./feishu/client";
import { buildNotification, recordEventContext, extractSessionID } from "./feishu/messages";
import { mapEventToNotification } from "./hooks";
import { FeishuWebSocket } from "./websocket";
import { ReplyHandler } from "./reply-handler";
import { OverviewManager } from "./overview-manager";
import { setMapping, tryAcquireWsLock, releaseWsLock, isEventProcessed, markEventProcessed } from "./store";

const serviceName = "opencode-feishu-notifier";

const FeishuNotifierPlugin: Plugin = async ({ client, directory }) => {
  let configCache: ReturnType<typeof loadConfigWithSource> | null = null;
  let configError: Error | null = null;
  let wsClient: FeishuWebSocket | null = null;
  let replyHandler: ReplyHandler | null = null;
  let overviewManager: OverviewManager | null = null;

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>
  ) => {
    const payload = {
      body: {
        service: serviceName,
        level,
        message,
        extra,
      },
    };
    void client.app.log(payload).catch(() => undefined);
  };

  const logDebug = (message: string, extra?: Record<string, unknown>) => {
    log("debug", message, extra);
  };

  const logInfo = (message: string, extra?: Record<string, unknown>) => {
    log("info", message, extra);
  };

  const logError = (message: string, extra?: Record<string, unknown>) => {
    log("error", message, extra);
  };

  logInfo("Feishu notifier plugin loading", { directory });

  const ensureConfig = () => {
    if (configCache || configError) {
      return;
    }

    try {
      configCache = loadConfigWithSource({ directory });
      logInfo("Feishu notifier plugin initialized", { sources: configCache.sources.map(s => s.type) });
      logDebug("Loaded Feishu config", { sources: configCache.sources });
    } catch (error) {
      configError = error instanceof Error ? error : new Error(String(error));
      logError("Feishu config error", { error: configError.message });
    }
  };

  const startWebSocket = async () => {
    if (!configCache || wsClient) return;
    
    if (!tryAcquireWsLock()) {
      console.log("[Feishu] Another instance is already handling WebSocket, skipping...");
      logInfo("Skipped WebSocket startup (another instance is active)");
      return;
    }
    
    try {
      console.log("[Feishu] Starting WebSocket...");
      replyHandler = new ReplyHandler(configCache.config, client, log);
      wsClient = new FeishuWebSocket(configCache.config);
      
      await wsClient.start(
        async (data) => {
          console.log("[Feishu] WebSocket message received");
          if (replyHandler) {
            await replyHandler.handle(data);
          }
        },
        async (data) => {
          console.log("[Feishu] WebSocket card action received");
          if (replyHandler) {
            await replyHandler.handleCardAction(data);
          }
        }
      );
      
      console.log("[Feishu] WebSocket started successfully");
      logInfo("WebSocket started for bidirectional interaction");
    } catch (error) {
      console.error("[Feishu] WebSocket start failed:", error);
      logError("WebSocket start failed", { error: String(error) });
      releaseWsLock();
    }
  };

  const initOverview = async () => {
    if (!configCache || overviewManager) return;
    
    try {
      console.log("[Feishu] Initializing overview card...");
      overviewManager = new OverviewManager(configCache.config, client, log);
      await overviewManager.init();
      
      if (replyHandler) {
        replyHandler.setOverviewManager(overviewManager);
      }
      
      console.log("[Feishu] Overview card initialized");
      logInfo("Overview card initialized");
    } catch (error) {
      console.error("[Feishu] Overview init failed:", error);
      logError("Overview init failed", { error: String(error) });
    }
  };

ensureConfig();

  if (configCache && !wsClient) {
    console.log("[Feishu] Plugin loaded, starting WebSocket in background...");
    
    void (async () => {
      try {
        await startWebSocket();
      } catch (error) {
        console.error("[Feishu] Background startup error:", error);
      }
    })();
  }

  return {
    event: async ({ event }) => {
      recordEventContext(event);
      logDebug("Event received", { eventType: event.type });

      if (event.type === "server.connected") {
        logInfo("Server connected, starting WebSocket");
        await startWebSocket();
        await initOverview();
        return;
      }

      if (event.type === "session.status" && overviewManager) {
        logDebug("Session status changed, triggering overview update");
        void overviewManager.refresh();
      }

      const sessionId = extractSessionID(event);
      const statusType = (event.properties as any)?.status?.type;
      
      if (sessionId && isEventProcessed(event.type, sessionId, statusType)) {
        logDebug("Event already processed, skipping", { eventType: event.type, sessionId, statusType });
        return;
      }
      
      if (sessionId) {
        markEventProcessed(event.type, sessionId, statusType);
      }

      let notificationType = mapEventToNotification(event.type);

      if (
        event.type === "session.status" &&
        event.properties?.status?.type === "idle"
      ) {
        const sessionID = extractSessionID(event);
        if (sessionID && client.session?.get) {
          try {
            const sessionResponse = await client.session.get({
              path: { id: sessionID },
            });
            const session = sessionResponse?.data;
            logDebug("Session check for parentID", {
              sessionID,
              hasData: !!session,
              parentID: session?.parentID ?? null,
              allKeys: session ? Object.keys(session) : [],
            });
            if (session?.parentID) {
              logDebug("Skipping subagent session idle notification", {
                sessionID,
                parentID: session.parentID,
              });
              return;
            }
          } catch (e) {
            logDebug("Failed to check session parentID, proceeding with notification", {
              sessionID,
              error: String(e),
            });
          }
        }
        notificationType = "session_idle";
      }

      if (event.type === "session.error") {
        const sessionID = extractSessionID(event);
        if (sessionID && client.session?.get) {
          try {
            const sessionResponse = await client.session.get({
              path: { id: sessionID },
            });
            const session = sessionResponse?.data;
            logDebug("Session error check for parentID", {
              sessionID,
              hasData: !!session,
              parentID: session?.parentID ?? null,
            });
            if (session?.parentID) {
              logDebug("Skipping subagent session error notification", {
                sessionID,
                parentID: session.parentID,
              });
              return;
            }
          } catch (e) {
            logDebug("Failed to check session parentID for error event", {
              sessionID,
              error: String(e),
            });
          }
        }
        notificationType = "session_error";
      }

      if (!notificationType) {
        logDebug("Event ignored", { eventType: event.type });
        return;
      }
      logDebug("Event mapped to notification", {
        eventType: event.type,
        notificationType,
      });

      ensureConfig();
      if (configError) {
        logError("Feishu config error (cached)", { error: configError.message });
        return;
      }
      if (!configCache) {
        logError("Feishu config not loaded");
        return;
      }

      await startWebSocket();

      const { text, title, richContent } = await buildNotification(
        notificationType,
        event,
        directory,
        { session: client.session }
      );
       logDebug("Sending Feishu notification", {
        eventType: event.type,
        notificationType,
        directory,
        hasRichContent: !!richContent,
      });

try {
        let response;
        
        const sessionId = extractSessionID(event);
        
        if (notificationType === 'permission_required' && sessionId) {
          const perm = (event.properties as any)?.permission;
          const permissionId = perm?.id || '';
          const permissionType = perm?.type || '';
          const pattern = perm?.pattern || '';
          const paths = Array.isArray(pattern) ? pattern : pattern ? [pattern] : [];
          
          const card = buildPermissionCard({
            title: '需要权限确认',
            message: 'OpenCode 需要访问文件权限才能继续',
            sessionId,
            permissionId,
            permissionType,
            paths
          });
          
          response = await sendInteractiveCard(configCache.config, card);
          logDebug("Feishu permission card sent", {
            messageId: response.data?.message_id ?? null,
          });
        } else if (notificationType === 'question_asked' && sessionId) {
          const props = event.properties as any;
          
          logDebug("Question event properties", { 
            props: JSON.stringify(props, null, 2),
            keys: props ? Object.keys(props) : []
          });
          
          let options = props?.options || [];
          if (!Array.isArray(options) || options.length === 0) {
            options = props?.question?.options || [];
          }
          if (!Array.isArray(options) || options.length === 0) {
            options = props?.choices || [];
          }
          if (!Array.isArray(options) || options.length === 0) {
            options = (event as any).payload?.options || [];
          }
          
          const questionText = props?.question?.text || props?.text || props?.message || props?.prompt || '请选择一个选项继续';
          
          logDebug("Question extracted", { 
            optionsCount: Array.isArray(options) ? options.length : 0,
            questionText
          });
          
          const card = buildQuestionCard({
            title: '请做选择',
            message: questionText,
            sessionId,
            options: Array.isArray(options) ? options.map((opt: any) => ({
              label: opt.label || opt.text || (typeof opt === 'string' ? opt : `选项`),
              description: opt.description
            })) : []
          });
          
          response = await sendInteractiveCard(configCache.config, card);
          logDebug("Feishu question card sent", {
            messageId: response.data?.message_id ?? null,
          });
        } else {
          try {
            response = await sendMarkdownMessage(configCache.config, text);
            logDebug("Feishu markdown notification sent", {
              messageId: response.data?.message_id ?? null,
            });
          } catch (markdownError) {
            logDebug("Markdown message failed, falling back to text", {
              error: markdownError instanceof Error ? markdownError.message : String(markdownError),
            });
            response = await sendTextMessage(configCache.config, text);
            logDebug("Feishu text notification sent (fallback)", {
              messageId: response.data?.message_id ?? null,
            });
          }
        }

        const messageId = response.data?.message_id;
        
        if (messageId && sessionId) {
          const actionType = mapNotificationToAction(notificationType);
          if (actionType) {
            const mapping: {
              sessionId: string;
              actionType: 'continue' | 'permission' | 'question' | 'input';
              permissionId?: string;
              questionOptions?: string[];
              createdAt: number;
            } = {
              sessionId,
              actionType,
              createdAt: Date.now(),
            };

            if (notificationType === 'permission_required') {
              const perm = (event.properties as any)?.permission;
              if (perm?.id) {
                mapping.permissionId = perm.id;
              }
            }

            if (notificationType === 'question_asked') {
              const props = event.properties as any;
              let options = props?.options || props?.question?.options || props?.choices || [];
              if (Array.isArray(options) && options.length > 0) {
                mapping.questionOptions = options.map((opt: any) => opt.label || opt.text || (typeof opt === 'string' ? opt : '')).filter(Boolean);
              }
            }

            setMapping(messageId, mapping);
            logDebug("Mapping stored", { messageId, sessionId, actionType, hasOptions: !!mapping.questionOptions?.length });
          }
        }
      } catch (error) {
        logError("Failed to send Feishu notification", {
          error: String(error),
        });
      }
    },
  };
};

function mapNotificationToAction(notificationType: string): 'continue' | 'permission' | 'question' | 'input' | null {
  switch (notificationType) {
    case 'session_idle':
    case 'session_error':
      return 'continue';
    case 'permission_required':
      return 'permission';
    case 'question_asked':
      return 'question';
    case 'interaction_required':
      return 'input';
    default:
      return null;
  }
}

export default FeishuNotifierPlugin;
