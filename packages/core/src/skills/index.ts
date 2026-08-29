/**
 * Skill 系统（需求 9）。
 *
 * 四层：清单解析、目录加载与作用域覆盖、本地检索索引、门面与工具。
 *
 * 贯穿全部四层的一条约定：**技能不常驻上下文，且加载过什么必须留痕**。前者是
 * 上下文预算问题（三十几份 SKILL.md 合起来十几万字符），后者是可追溯问题——
 * 半年后回看一份结论时，「当时按的是哪套方法」必须答得出来。
 */

export {
  crossCheckFrontMatter,
  isValidSlug,
  parseFrontMatter,
  parseSkillManifest,
  SkillManifestError,
} from './manifest.js';
export type {
  FrontMatter,
  LoadedSkill,
  SkillManifest,
  SkillRequires,
  SkillScope,
} from './manifest.js';

export { loadSkill, loadSkillCatalog, readSkillReference } from './loader.js';
export type { BrokenSkill, LoadSkillsOptions, SkillCatalog } from './loader.js';

export {
  checkManyRequirements,
  checkRequirements,
  describeMissing,
  probeCommands,
  probePythonModules,
  probeRPackages,
} from './requirements.js';
export type {
  CheckRequirementsInput,
  MissingKind,
  MissingRequirement,
  ProbeResult,
  RequirementProbes,
  RequirementReport,
} from './requirements.js';

export { cosineSimilarity, createOllamaEmbedder, SkillSearchIndex, tokenize } from './search.js';
export type { Embedder, OllamaEmbedderOptions, SkillSearchHit } from './search.js';

export {
  countBuiltinSkills,
  findBuiltinSkillSource,
  installBuiltinSkills,
  isDirectory,
} from './install.js';
export type { InstallResult } from './install.js';

export { SkillManager } from './manager.js';
export type { SkillInjection, SkillManagerOptions, SkillSearchResult } from './manager.js';

export { createLoadSkillReferenceTool, createSearchSkillsTool } from './tools.js';
export type { LoadSkillReferenceInput, SearchSkillsInput, SkillToolOptions } from './tools.js';

/* ---------------- 创建与导入（任务 12.15）---------------- */

export {
  auditSkillContent,
  findSkillRoots,
  readSkillOrigin,
  readSkillTree,
  removeUserSkill,
  skillFingerprint,
  SKILL_LIMITS,
  validateSkillFiles,
  writeUserSkill,
} from './authoring.js';
export type {
  ReadTreeResult,
  SkillFileMap,
  SkillOrigin,
  SkillOriginKind,
  ValidateResult,
  WriteSkillInput,
  WriteSkillResult,
} from './authoring.js';

export { ARCHIVE_LIMITS, ArchiveError, findArchivedSkills, readArchive } from './archive.js';
export type { ArchiveLimits } from './archive.js';
export type { ArchivedSkill, ArchiveEntry, ArchiveResult } from './archive.js';

export {
  importSkillsFromArchive,
  importSkillsFromDirectory,
  importSkillsFromGitHub,
  parseGitHubSpec,
  skillSourceRef,
  userSkillExists,
} from './import.js';
export type {
  GitHubRepoSpec,
  ImportArchiveInput,
  ImportDirectoryInput,
  ImportedSkill,
  ImportGitHubInput,
  ImportOutcome,
} from './import.js';

export {
  buildDistillContext,
  collectToolUsage,
  distillSkill,
  distillSystemPrompt,
  distillUserPrompt,
  parseDistilledSkill,
} from './distill.js';
export type {
  DistilledDraft,
  DistillContext,
  DistillDeps,
  DistillParseResult,
  DistillRequest,
  DistillResult,
} from './distill.js';

export { createCreateSkillTool } from './authoring-tools.js';
export type { CreateSkillInput, CreateSkillToolOptions } from './authoring-tools.js';
