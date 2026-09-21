/**
 * 首次运行遮罩的门闩。
 *
 * 会话级跳过存在内存里，不落盘：重启后若仍无供应商会再出现。持久记住「跳过」
 * 会让从未配过模型的人再也看不到登记入口。
 */

export const CONDA_ENV_NOTICE =
  '安装包不包含 conda 环境 lsci / lsci-r。可在本页一键下载 micromamba 并创建。' as const;

export type FirstRunGate = {
  readonly providerCount: number;
  readonly skippedThisSession: boolean;
  /** 当前主视图。跳过后只在设置页隐藏，其它视图继续挡住。 */
  readonly view: string;
};

export function shouldShowFirstRun(input: FirstRunGate): boolean {
  if (input.providerCount > 0) return false;
  if (input.view === 'settings') return false;
  return true;
}
