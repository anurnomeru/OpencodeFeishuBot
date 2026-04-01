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