import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import type { FleetProject } from '../shared/fleet.js';
import { MAX_SKILL_BYTES, type SkillCatalog, type SkillDocument, type SkillInfo, type SkillRequest, type SkillScope } from '../shared/skills.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function metadata(content: string) {
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new Error('SKILL.md exceeds the 256 KiB limit.');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('Start SKILL.md with YAML frontmatter delimited by ---.');
  let value;
  try { value = parse(match[1], { maxAliasCount: 50 }); } catch { throw new Error('Invalid YAML frontmatter.'); }
  if (!value || typeof value.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.name)) throw new Error('Frontmatter name must contain only letters, numbers, hyphens, or underscores.');
  if (typeof value.description !== 'string' || !value.description.trim()) throw new Error('Frontmatter requires a non-empty description.');
  return { name: value.name, description: value.description.trim() };
}

// Never load Haze settings (which may contain credentials), references, or arbitrary
// browser paths. Only regular SKILL.md files under server-owned scope roots.
export class SkillManager {
  readonly scopes: SkillScope[];
  private bases: Map<string, string>;
  private entries = new Map<string, SkillInfo>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(projects: FleetProject[], home = homedir()) {
    const roots = [{ id: 'global', name: 'Global · all projects', cwd: home }, ...projects];
    this.bases = new Map(roots.map(root => [root.id, root.cwd]));
    this.scopes = roots.map(root => ({ id: root.id, name: root.name, path: join(root.cwd, '.haze', 'skills') }));
  }
  private async root(scope: SkillScope, create = false) {
    let path = this.bases.get(scope.id)!;
    for (const part of ['.haze', 'skills']) {
      path = join(path, part);
      if (create) { try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Symlinked skill roots are not accessible remotely.');
    }
    return path;
  }
  private async read(info: SkillInfo): Promise<SkillDocument> {
    const scope = this.scopes.find(scope => scope.id === info.scopeId)!;
    const root = await this.root(scope);
    const dir = join(root, info.directory);
    if (!(await lstat(dir)).isDirectory()) throw new Error('Symlinked skill directories are not accessible remotely.');
    const file = await open(join(dir, 'SKILL.md'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Only regular, non-linked SKILL.md files are accessible.');
      if (stat.size > MAX_SKILL_BYTES) throw new Error('SKILL.md exceeds the 256 KiB limit.');
      const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_SKILL_BYTES) throw new Error('SKILL.md exceeds the 256 KiB limit.');
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      let fields: { name: string; description: string; error?: string };
      try { fields = metadata(content); } catch (error) { fields = { name: info.directory, description: '', error: (error as Error).message }; }
      return { ...info, ...fields, content, revision: hash(content) };
    } finally { await file.close(); }
  }
  async catalog(): Promise<SkillCatalog> {
    const skills: SkillInfo[] = [], warnings: string[] = [];
    const entries = new Map<string, SkillInfo>();
    for (const scope of this.scopes) {
      try {
        const root = await this.root(scope);
        const dirs = await readdir(root, { withFileTypes: true });
        if (dirs.length > 1000) throw new Error('Too many entries in skill root (maximum 1000).');
        for (const dir of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
          if (dir.isSymbolicLink()) { warnings.push(`${scope.name} / ${dir.name}: linked skill directories are not accessible remotely.`); continue; }
          if (!dir.isDirectory()) continue;
          const info: SkillInfo = { id: hash(scope.id + '/' + dir.name), scopeId: scope.id, directory: dir.name,
            path: join(root, dir.name, 'SKILL.md'), name: dir.name, description: '' };
          try {
            const { content: _content, revision: _revision, ...summary } = await this.read(info);
            summary.name = summary.name.slice(0, 160); summary.description = summary.description.slice(0, 1000);
            skills.push(summary); entries.set(info.id, summary);
          } catch (error) { if (!missing(error)) warnings.push(`${scope.name} / ${dir.name}: skill file is inaccessible or exceeds the size limit.`); }
        }
      } catch (error) { if (!missing(error)) warnings.push(`${scope.name}: skill root is inaccessible or unsafe.`); }
    }
    this.entries = entries;
    return { scopes: this.scopes, skills, warnings };
  }
  execute(request: SkillRequest, authorized: () => boolean) {
    const result = this.queue.then(async () => {
      if (!authorized()) throw new Error('Connection is no longer approved.');
      if (request.type === 'skills-list') return { catalog: await this.catalog() };
      if (request.type === 'skill-read' || request.type === 'skill-save') {
        await this.catalog();
        const info = this.entries.get(request.skillId);
        if (!info) throw new Error('Skill is no longer accessible. Refresh the catalog.');
        const document = await this.read(info);
        if (request.type === 'skill-read') return { document };
        metadata(request.content);
        if (request.revision !== document.revision) throw new Error('This skill changed on disk. Reopen it before saving; your draft has not been overwritten.');
        const temp = join(this.scopes.find(scope => scope.id === info.scopeId)!.path, info.directory, `.remote-${randomUUID()}`);
        const file = await open(temp, 'wx', 0o600);
        try {
          await file.writeFile(request.content, 'utf8'); await file.close();
          if (!authorized()) throw new Error('Connection is no longer approved.');
          if ((await this.read(info)).revision !== request.revision) throw new Error('This skill changed on disk. Reopen it before saving.');
          await rename(temp, info.path);
        } finally { await file.close(); await unlink(temp).catch(() => {}); }
        return { document: await this.read(info) };
      }
      metadata(request.content);
      const scope = this.scopes.find(scope => scope.id === request.scopeId);
      if (!scope) throw new Error('Unknown skill scope.');
      const root = await this.root(scope, true);
      const dir = join(root, request.directory);
      try { await mkdir(dir); } catch { throw new Error('A directory with this name already exists. Choose another name.'); }
      if (!authorized()) throw new Error('Connection is no longer approved.');
      const file = await open(join(dir, 'SKILL.md'), 'wx', 0o600);
      try { await file.writeFile(request.content, 'utf8'); } finally { await file.close(); }
      const info: SkillInfo = { id: hash(scope.id + '/' + request.directory), scopeId: scope.id, directory: request.directory,
        path: join(dir, 'SKILL.md'), name: request.directory, description: '' };
      return { document: await this.read(info) };
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
