import fs from 'node:fs';
import path from 'node:path';

function workingFilePath(sessionDir: string): string {
  return path.join(sessionDir, 'working.jsonl');
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function ensureWorkingSession(sessionDir: string, sessionId: string): string {
  const filePath = workingFilePath(sessionDir);

  if (fs.existsSync(filePath)) {
    return filePath;
  }

  ensureDir(filePath);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      type: 'session',
      id: sessionId,
      timestamp: new Date().toISOString(),
      version: 3,
    })}\n`,
    'utf8',
  );

  return filePath;
}

export function appendWorkingMessage(sessionDir: string, sessionId: string, role: string, content: string): void {
  const filePath = ensureWorkingSession(sessionDir, sessionId);

  fs.appendFileSync(
    filePath,
    `${JSON.stringify({
      type: 'message',
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role, content },
    })}\n`,
    'utf8',
  );
}

export function buildWorkingContext(sessionDir: string): Array<{ role: string; content: string }> {
  const filePath = workingFilePath(sessionDir);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const messages: Array<{ role: string; content: string }> = [];

  for (const line of lines) {
    const parsed = JSON.parse(line) as {
      type?: string;
      message?: { role?: string; content?: string };
    };

    if (parsed.type === 'message' && parsed.message?.role && parsed.message?.content) {
      messages.push({ role: parsed.message.role, content: parsed.message.content });
    }
  }

  return messages;
}
