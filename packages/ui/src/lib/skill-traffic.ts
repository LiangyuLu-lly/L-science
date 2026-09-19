/**
 * CS featured 技能的交通灯。目录里有条目不算能跑。
 */

export const FEATURED_SKILL_SLUGS = [
  'literature-review',
  'indication-dossier',
  'alphafold2',
  'boltz-2',
  'chai-1',
  'esmfold',
  'openfold3',
  'proteinmpnn',
  'diffdock',
  'esm2',
  'evo2',
  'borzoi',
  'scgpt',
  'scvi-tools',
] as const;

export type SkillTraffic = 'green' | 'yellow' | 'red';

export const SKILL_TRAFFIC_LABEL: Readonly<Record<SkillTraffic, string>> = {
  green: '可跑',
  yellow: '未探测',
  red: '不能跑',
};

export type SkillTrafficInput = {
  readonly enabled: boolean;
  readonly present: boolean;
  readonly requirementsSatisfied: boolean | null;
  readonly missing: readonly unknown[];
  readonly probeFailures: readonly unknown[];
};

export function skillTraffic(skill: SkillTrafficInput): SkillTraffic {
  if (!skill.present || !skill.enabled) return 'red';
  if (skill.probeFailures.length > 0) return 'yellow';
  if (skill.requirementsSatisfied === false || skill.missing.length > 0) return 'red';
  if (skill.requirementsSatisfied === true) return 'green';
  return 'yellow';
}

export function isFeaturedSkill(slug: string): boolean {
  return (FEATURED_SKILL_SLUGS as readonly string[]).includes(slug);
}
