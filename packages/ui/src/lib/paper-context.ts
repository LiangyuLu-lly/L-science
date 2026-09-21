/**
 * 把文献页选中的条目编进发给助手的消息。没有这条前缀，模型不知道
 * 「当前在看哪篇」，抽断言就会凭记忆写 DOI。
 */

export type PaperFocus = {
  readonly id: string;
  readonly doi: string | null;
  readonly cite: string;
  readonly title: string | null;
  readonly abstract?: string | null;
};

export const EXTRACT_CLAIMS_PROMPT =
  '从当前文献抽取可核查断言（数值结论、比较、因果、引文支撑）。每条用 manage_claims 的 register 登记，并用 bind 把 evidenceKind=doi、evidenceRef 绑到上述 DOI。不要编造页码。';

export function formatPaperPrefix(ref: PaperFocus): string {
  const doi = ref.doi ?? '无 DOI';
  const title = ref.title ?? ref.cite;
  return (
    `【当前文献】\n题录：${ref.cite}\n标题：${title}\nDOI：${doi}\n` +
    '请基于这篇文献回答。若抽取断言，用 manage_claims register，bind 时 evidenceKind=doi、evidenceRef 用上述 DOI，不要编造页码。\n\n'
  );
}

export function withPaperContext(text: string, ref: PaperFocus | null): string {
  if (ref === null) return text;
  return `${formatPaperPrefix(ref)}${text}`;
}

export function literatureMarkdown(ref: PaperFocus & { readonly abstract?: string | null }): string {
  const title = ref.title ?? ref.cite;
  const doi = ref.doi === null ? '' : `DOI: ${ref.doi}`;
  const abs = ref.abstract === undefined || ref.abstract === null || ref.abstract === '' ? '' : ref.abstract;
  return [`# ${title}`, ref.cite, doi, '', abs].filter((line) => line !== '').join('\n');
}
