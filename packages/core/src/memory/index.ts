/**
 * Memory Service（任务 12.9，需求 16.1-16.4）。
 *
 * 三层作用域、写入需理由、可审查编辑、一次性细节被确定性规则挡在外面。
 */

export {
  classifyEnvironmentNote,
  classifyMemoryCandidate,
  environmentNoteGuidance,
  memoryGuidance,
} from './classify.js';
export type { MemoryVerdict } from './classify.js';

export { MEMORY_LIMITS, MemoryService } from './service.js';
export type { MemoryServiceOptions, RememberResult } from './service.js';

export { createRecallMemoryTool, createRememberTool } from './tools.js';
export type { MemoryToolOptions, RecallInput, RememberInput } from './tools.js';
