/**
 * 目录型网关（OpenRouter / 硅基流动 / Together）一次能列出上百个模型。
 * 全部默认启用会把路由打乱，也容易误打贵模型。新模型只开一小撮常用的。
 */

const CATALOG_CAP = 8;
const CATALOG_IDS = new Set(['openrouter', 'siliconflow', 'together']);

const NEEDLES = [
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'claude-sonnet',
  'gemini-2.5-flash',
  'gemini-flash',
  'deepseek',
  'qwen',
  'glm-4',
  'llama-3.3',
  'llama-3.1',
  'kimi',
  'moonshot',
] as const;

function isPreferred(id: string): boolean {
  const lower = id.toLowerCase();
  return NEEDLES.some((needle) => lower.includes(needle));
}

export function newModelsEnabledByDefault(
  providerId: string,
  ids: readonly string[],
): ReadonlySet<string> {
  if (!CATALOG_IDS.has(providerId)) return new Set(ids);
  const preferred = ids.filter(isPreferred);
  const picked = (preferred.length > 0 ? preferred : [...ids]).slice(0, CATALOG_CAP);
  return new Set(picked);
}
