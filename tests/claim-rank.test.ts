/**
 * 断言列表排序：无证据、矛盾必须压在最上面。投稿前才翻到它们算产品弱于 CS。
 */

import { describe, expect, it } from 'vitest';

import { rankClaims, type RankableClaim } from '../packages/ui/src/lib/claim-rank.js';

function claim(partial: Partial<RankableClaim> & Pick<RankableClaim, 'id'>): RankableClaim {
  return {
    text: partial.id,
    status: 'supported',
    unsupported: false,
    ...partial,
  };
}

describe('rankClaims', () => {
  it('puts unsupported and refuted before supported', () => {
    const ranked = rankClaims([
      claim({ id: 'ok', status: 'supported', unsupported: false }),
      claim({ id: 'bare', status: 'open', unsupported: true }),
      claim({ id: 'bad', status: 'refuted', unsupported: false }),
      claim({ id: 'open', status: 'open', unsupported: false }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['bare', 'bad', 'open', 'ok']);
  });
});
