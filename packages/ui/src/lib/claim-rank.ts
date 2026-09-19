/**
 * 断言列表排序。无证据与矛盾必须压过「看起来已经支持」的条目。
 */

export type RankableClaim = {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly unsupported: boolean;
};

export function rankClaims<T extends RankableClaim>(claims: readonly T[]): T[] {
  const rank = (claim: RankableClaim): number => {
    if (claim.unsupported) return 0;
    if (claim.status === 'refuted') return 1;
    if (claim.status === 'insufficient' || claim.status === 'open') return 2;
    return 3;
  };
  return [...claims].sort((a, b) => rank(a) - rank(b));
}

/** 把粘贴框拆成 DOI / PMID / 链接。空白、逗号、分号都当分隔符。 */
export function splitIdentifiers(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/u)) {
    const trimmed = part.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}
