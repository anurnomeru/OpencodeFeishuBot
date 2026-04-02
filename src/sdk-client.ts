import type { OpencodeClient } from '@opencode-ai/sdk';

export async function promptSession(
  client: OpencodeClient,
  sessionId: string,
  text: string
): Promise<any> {
  try {
    const response = await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text }] },
    });
    return response;
  } catch (error: any) {
    console.error(`[Feishu] promptSession failed:`, error.message);
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

export type SessionInfo = {
  id: string;
  title: string;
  status: 'idle' | 'busy' | 'retry';
  todos?: Array<{
    content: string;
    status: string;
    priority: string;
  }>;
  progress?: {
    total: number;
    completed: number;
    inProgress: number;
    percentage: number;
  };
  currentAction?: string;
  recentActions?: string[];
};

export type OpenCodeStatus = {
  sessions: SessionInfo[];
  project?: {
    name?: string;
    branch?: string;
    worktree?: string;
  };
  agents: string[];
};

export async function getOpenCodeStatus(client: OpencodeClient): Promise<OpenCodeStatus> {
  const sessions: SessionInfo[] = [];
  const agents: string[] = [];
  let project: OpenCodeStatus['project'];

  try {
    const sessionListResponse = await client.session.list({});
    const sessionList = (sessionListResponse as any)?.data || sessionListResponse || [];
    
    if (Array.isArray(sessionList) && sessionList.length > 0) {
      const statusResponse = await client.session.status({});
      const statusMap = (statusResponse as any)?.data || statusResponse || {};
      
      for (const session of sessionList) {
        const s = session as any;
        const sessionId = s.id;
        const statusInfo = statusMap[sessionId];
        const statusType = statusInfo?.type || 'idle';
        
        let todos: SessionInfo['todos'] = undefined;
        let progress: SessionInfo['progress'] = undefined;
        let currentAction: string | undefined;
        let recentActions: string[] = [];
        
        try {
          const todoResponse = await client.session.todo({ path: { id: sessionId } });
          const todoList = (todoResponse as any)?.data || todoResponse || [];
          if (Array.isArray(todoList) && todoList.length > 0) {
            todos = todoList.map((t: any) => ({
              content: t.content || '',
              status: t.status || 'pending',
              priority: t.priority || 'medium',
            }));
            
            const total = todos.length;
            const completed = todos.filter(t => t.status === 'completed').length;
            const inProgress = todos.filter(t => t.status === 'in_progress').length;
            
            progress = {
              total,
              completed,
              inProgress,
              percentage: Math.round((completed / total) * 100)
            };
            
            const inProgressTodo = todos.find(t => t.status === 'in_progress');
            if (inProgressTodo) {
              currentAction = inProgressTodo.content;
            }
            
            const completedTodos = todos.filter(t => t.status === 'completed').slice(-3);
            recentActions = completedTodos.map(t => t.content);
          }
        } catch {}

        sessions.push({
          id: sessionId,
          title: s.title || sessionId,
          status: statusType,
          todos,
          progress,
          currentAction,
          recentActions: recentActions.length > 0 ? recentActions : undefined,
        });
      }
    }
  } catch (error: any) {
    console.error(`[Feishu SDK] Failed to get sessions:`, error.message);
  }

  try {
    const projectResponse = await client.project.current({});
    const projectData = (projectResponse as any)?.data || projectResponse;
    if (projectData) {
      const p = projectData as any;
      project = {
        name: p.name || p.worktree?.split('/').pop() || undefined,
        worktree: p.worktree || undefined,
      };
    }
  } catch (error: any) {
    console.error(`[Feishu SDK] Failed to get project:`, error.message);
  }

  try {
    const vcsResponse = await client.vcs.get({});
    const vcsData = (vcsResponse as any)?.data || vcsResponse;
    if (vcsData?.branch && project) {
      project.branch = vcsData.branch;
    }
  } catch (error: any) {
    console.error(`[Feishu SDK] Failed to get VCS:`, error.message);
  }

  try {
    const agentsResponse = await client.app.agents({});
    const agentsList = (agentsResponse as any)?.data || agentsResponse || [];
    if (Array.isArray(agentsList)) {
      agents.push(...agentsList.map((a: any) => a.name || a));
    }
  } catch (error: any) {
    console.error(`[Feishu SDK] Failed to get agents:`, error.message);
  }

  return { sessions, project, agents };
}