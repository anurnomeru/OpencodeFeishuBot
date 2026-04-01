import type { OpencodeClient } from '@opencode-ai/sdk';

export async function promptSession(
  client: OpencodeClient,
  sessionId: string,
  text: string
): Promise<any> {
  console.log(`[Feishu SDK] promptSession: sessionId=${sessionId}, text="${text}"`);
  try {
    const response = await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text }] },
    });
    console.log(`[Feishu SDK] promptSession success`);
    return response;
  } catch (error: any) {
    console.error(`[Feishu SDK] promptSession failed:`, error.message);
    throw error;
  }
}

export async function replyPermission(
  client: OpencodeClient,
  sessionId: string,
  permissionId: string,
  status: 'once' | 'always' | 'reject'
): Promise<void> {
  await client.postSessionIdPermissionsPermissionId({
    path: { id: sessionId, permissionID: permissionId },
    body: { response: status },
  });
}

export async function appendPrompt(
  client: OpencodeClient,
  text: string
): Promise<void> {
  await client.tui.appendPrompt({ body: { text } });
}

export async function submitPrompt(
  client: OpencodeClient
): Promise<void> {
  await client.tui.submitPrompt();
}