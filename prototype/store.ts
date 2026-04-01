export type PendingAction = {
  sessionId: string;
  feishuMessageId: string;
  createdAt: number;
};

const store = new Map<string, PendingAction>();

export function setMapping(feishuMessageId: string, sessionId: string): void {
  store.set(feishuMessageId, {
    sessionId,
    feishuMessageId,
    createdAt: Date.now(),
  });
  console.log(`[Store] 映射: ${feishuMessageId} → ${sessionId}`);
}

export function getMapping(feishuMessageId: string): PendingAction | undefined {
  return store.get(feishuMessageId);
}

export function deleteMapping(feishuMessageId: string): void {
  store.delete(feishuMessageId);
  console.log(`[Store] 删除: ${feishuMessageId}`);
}

export function debugStore(): void {
  console.log(`[Store] 当前映射数: ${store.size}`);
  for (const [key, value] of store.entries()) {
    console.log(`  ${key} → session=${value.sessionId}`);
  }
}

export function getStoreSize(): number {
  return store.size;
}