export const MAX_SKILL_BYTES = 256 * 1024;
export type SkillScope = { id: string; name: string; path: string };
export type SkillInfo = { id: string; scopeId: string; directory: string; path: string; name: string; description: string; error?: string };
export type SkillDocument = SkillInfo & { content: string; revision: string };
export type SkillCatalog = { scopes: SkillScope[]; skills: SkillInfo[]; warnings: string[] };
export type SkillRequest =
  | { type: 'skills-list'; requestId: string }
  | { type: 'skill-read'; requestId: string; skillId: string }
  | { type: 'skill-save'; requestId: string; skillId: string; revision: string; content: string }
  | { type: 'skill-create'; requestId: string; scopeId: string; directory: string; content: string };
export type SkillResponse =
  | { type: 'skills-result'; requestId: string; catalog?: SkillCatalog; document?: SkillDocument }
  | { type: 'skills-error'; requestId: string; message: string };
export function isSkillRequest(value: any): value is SkillRequest {
  if (!value || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.requestId)) return false;
  if (value.type === 'skills-list') return true;
  if (typeof value.skillId === 'string' && /^[a-f0-9]{64}$/.test(value.skillId)) {
    if (value.type === 'skill-read') return true;
    if (value.type === 'skill-save') return typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)
      && typeof value.content === 'string' && value.content.length <= MAX_SKILL_BYTES;
  }
  return value.type === 'skill-create' && typeof value.scopeId === 'string' && /^(global|project-\d+)$/.test(value.scopeId)
    && typeof value.directory === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.directory)
    && typeof value.content === 'string' && value.content.length <= MAX_SKILL_BYTES;
}
