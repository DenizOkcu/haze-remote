import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FleetProject } from '../shared/fleet.js';
import type { SessionInfo } from '../shared/configuration.js';

const SESSIONS_LIMIT = 500;
type HazeSessionStore = typeof import('@denizokcu/haze/dist/core/session/sessionStore.js');
let storeModule: Promise<HazeSessionStore> | undefined;
function store() { storeModule ??= import('@denizokcu/haze/dist/core/session/sessionStore.js'); return storeModule; }

// Summary-only view of Haze's private per-workspace session store, exposed
// solely over the approved encrypted channel. Message content never leaves.
export class SessionCatalog {
  private dir: string;
  constructor(projects: FleetProject[], home = homedir()) {
    this.dir = join(home, '.haze', 'sessions');
    void projects;
  }
  private workspace(cwd: string) { return createHash('sha256').update(cwd).digest('hex').slice(0, 16); }
  async list(project: FleetProject): Promise<{ sessions: SessionInfo[]; warnings: string[]; canFork: boolean }> {
    const sessions: SessionInfo[] = [], warnings: string[] = [];
    let canFork = false;
    try {
      const module = await store();
      const summaries = await module.listSessions(project.cwd, this.dir);
      canFork = typeof module.forkSession === 'function';
      for (const summary of summaries.slice(0, SESSIONS_LIMIT)) {
        sessions.push({ id: summary.id, projectId: project.id, cwd: project.cwd,
          createdAt: summary.createdAt, updatedAt: summary.lastActivityAt, sizeBytes: summary.sizeBytes });
      }
    } catch { warnings.push('Session history is unavailable. Haze 1.5+ stores sessions per workspace.'); }
    return { sessions, warnings, canFork };
  }
  async fork(cwd: string, id: string): Promise<string> {
    const module = await store();
    const session = { id, file: join(this.dir, this.workspace(cwd), `${id}.jsonl`), cwd, sessionsDir: this.dir };
    const forked = await module.forkSession(session);
    return forked.session.id;
  }
}
