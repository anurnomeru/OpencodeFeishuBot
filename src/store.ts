import fs from "fs";
import path from "path";
import os from "os";

export type PendingAction = {
  sessionId: string;
  actionType: 'continue' | 'permission' | 'question' | 'input';
  permissionId?: string;
  questionOptions?: string[];
  createdAt: number;
};

const TTL_MS = 30 * 60 * 1000;

function getStorePath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "opencode", "feishu-mappings.json");
}

function loadStore(): Record<string, PendingAction> {
  const storePath = getStorePath();
  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, "utf8");
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

function saveStore(data: Record<string, PendingAction>): void {
  const storePath = getStorePath();
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

export function setMapping(feishuMessageId: string, action: PendingAction): void {
  const store = loadStore();
  store[feishuMessageId] = action;
  saveStore(store);
}

export function getMapping(feishuMessageId: string): PendingAction | undefined {
  const store = loadStore();
  const action = store[feishuMessageId];
  
  if (action && Date.now() - action.createdAt > TTL_MS) {
    deleteMapping(feishuMessageId);
    return undefined;
  }
  
  return action;
}

export function deleteMapping(feishuMessageId: string): void {
  const store = loadStore();
  delete store[feishuMessageId];
  saveStore(store);
}

export function getStoreSize(): number {
  return Object.keys(loadStore()).length;
}

const DEDUP_TTL_MS = 5 * 60 * 1000;

export function isMessageProcessed(messageId: string): boolean {
  const store = loadStore();
  const key = `processed:${messageId}`;
  const processedAt = store[key]?.createdAt;
  
  if (processedAt && Date.now() - processedAt < DEDUP_TTL_MS) {
    return true;
  }
  
  return false;
}

export function markMessageProcessed(messageId: string): void {
  const store = loadStore();
  store[`processed:${messageId}`] = {
    sessionId: '',
    actionType: 'continue',
    createdAt: Date.now(),
  };
  saveStore(store);
}

const CURRENT_PROJECT_KEY = '__currentProject';

export function setCurrentProject(projectPath: string): void {
  const store = loadStore();
  (store as any)[CURRENT_PROJECT_KEY] = projectPath;
  saveStore(store);
}

export function getCurrentProject(): string | undefined {
  const store = loadStore();
  return (store as any)[CURRENT_PROJECT_KEY];
}

const OVERVIEW_CARD_ID_KEY = '__overviewCardId';
const OVERVIEW_UPDATE_TIME_KEY = '__overviewUpdateTime';

export function setOverviewCardId(cardId: string): void {
  const store = loadStore();
  (store as any)[OVERVIEW_CARD_ID_KEY] = cardId;
  (store as any)[OVERVIEW_UPDATE_TIME_KEY] = Date.now();
  saveStore(store);
}

export function getOverviewCardId(): string | undefined {
  const store = loadStore();
  const cardId = (store as any)[OVERVIEW_CARD_ID_KEY];
  const updateTime = (store as any)[OVERVIEW_UPDATE_TIME_KEY];
  
  if (cardId && updateTime && Date.now() - updateTime < TTL_MS) {
    return cardId;
  }
  
  return undefined;
}

export function clearOverviewCardId(): void {
  const store = loadStore();
  delete (store as any)[OVERVIEW_CARD_ID_KEY];
  delete (store as any)[OVERVIEW_UPDATE_TIME_KEY];
  saveStore(store);
}

export function getLastOverviewUpdate(): number | undefined {
  const store = loadStore();
  return (store as any)[OVERVIEW_UPDATE_TIME_KEY];
}

const LOCK_KEY = '__wsLock';
const LOCK_TTL_MS = 60 * 1000;

export function tryAcquireWsLock(): boolean {
  const store = loadStore();
  const lockData = (store as any)[LOCK_KEY];
  const now = Date.now();
  
  if (lockData) {
    const { pid, timestamp } = lockData;
    
    if (now - timestamp < LOCK_TTL_MS) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        // 进程已退出，可以接管
      }
    }
  }
  
  (store as any)[LOCK_KEY] = {
    pid: process.pid,
    timestamp: now
  };
  saveStore(store);
  return true;
}

export function releaseWsLock(): void {
  const store = loadStore();
  const lockData = (store as any)[LOCK_KEY];
  
  if (lockData && lockData.pid === process.pid) {
    delete (store as any)[LOCK_KEY];
    saveStore(store);
  }
}

export function isWsLockHeld(): boolean {
  const store = loadStore();
  const lockData = (store as any)[LOCK_KEY];
  
  if (!lockData) return false;
  
  const { pid, timestamp } = lockData;
  const now = Date.now();
  
  if (now - timestamp >= LOCK_TTL_MS) {
    return false;
  }
  
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const EVENT_DEDUP_TTL_MS = 30 * 1000;

export function isEventProcessed(eventType: string, sessionId: string, statusType?: string): boolean {
  const store = loadStore();
  const key = `event:${eventType}:${sessionId}:${statusType || 'none'}`;
  const processedAt = store[key]?.createdAt;
  
  if (processedAt && Date.now() - processedAt < EVENT_DEDUP_TTL_MS) {
    return true;
  }
  
  return false;
}

export function markEventProcessed(eventType: string, sessionId: string, statusType?: string): void {
  const store = loadStore();
  const key = `event:${eventType}:${sessionId}:${statusType || 'none'}`;
  store[key] = {
    sessionId,
    actionType: 'continue' as const,
    createdAt: Date.now(),
  };
  saveStore(store);
}

const RECENT_PROJECTS_KEY = '__recentProjects';
const MAX_RECENT_PROJECTS = 10;

export type RecentProject = {
  path: string;
  name: string;
  lastUsed: number;
};

export function addRecentProject(projectPath: string): void {
  const store = loadStore();
  const projects: RecentProject[] = (store as any)[RECENT_PROJECTS_KEY] || [];
  
  const name = projectPath.split('/').pop() || projectPath;
  const existingIndex = projects.findIndex(p => p.path === projectPath);
  
  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1);
  }
  
  projects.unshift({ path: projectPath, name, lastUsed: Date.now() });
  
  (store as any)[RECENT_PROJECTS_KEY] = projects.slice(0, MAX_RECENT_PROJECTS);
  saveStore(store);
}

export function getRecentProjects(): RecentProject[] {
  const store = loadStore();
  return (store as any)[RECENT_PROJECTS_KEY] || [];
}