/**
 * 把兼容网关的登记失败翻成能修的中文。401 / 缺 /v1 / 连不上是最常见的三种。
 */

export function explainCompatFailure(err: unknown, baseUrl: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api') ||
    lower.includes('incorrect api')
  ) {
    return new Error(
      `密钥被拒绝（401）。核对 ${baseUrl} 对应控制台里的密钥是否复制完整、是否过期。原文：${raw}`,
    );
  }
  if (lower.includes('404') || lower.includes('not found')) {
    return new Error(`基地址可能少了 /v1 或路径不对。当前：${baseUrl}。原文：${raw}`);
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return new Error(`连不上 ${baseUrl}。检查网络、区域节点、是否要开代理。原文：${raw}`);
  }
  return new Error(`登记失败：${raw}`);
}
