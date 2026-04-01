import type { PrototypeConfig } from './config';

export async function promptSession(
  config: PrototypeConfig,
  sessionId: string,
  text: string
): Promise<any> {
  console.log(`[SDK] 发送到 session ${sessionId}: "${text}"`);
  
  const url = `${config.opencode.serverUrl}/sessions/${sessionId}/prompt`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SDK 失败: ${response.status} ${errorText}`);
  }
  
  const data = await response.json();
  console.log(`[SDK] 响应:`, JSON.stringify(data, null, 2));
  return data;
}

export async function getSession(
  config: PrototypeConfig,
  sessionId: string
): Promise<any> {
  const url = `${config.opencode.serverUrl}/sessions/${sessionId}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`获取失败: ${response.status}`);
  return response.json();
}

export async function getSessionMessages(
  config: PrototypeConfig,
  sessionId: string
): Promise<any[]> {
  const url = `${config.opencode.serverUrl}/sessions/${sessionId}/messages`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`获取失败: ${response.status}`);
  return response.json();
}