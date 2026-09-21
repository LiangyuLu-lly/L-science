/**
 * 首次运行遮罩门闩。
 *
 * 两条曾经打架的诉求，现在分开处理：
 *
 * - **用户说了跳过就跳过。** 遮罩是模态的，跳过之后如果还在其它页面反复弹回来，
 *   第一次用的人会被直接拦在门外——他可能只是想先贴几个 DOI 看看。
 *   文献、断言、手稿都不需要模型，没有理由被「还没配密钥」挡住。
 * - **但不能让人找不到登记入口。** 常驻提醒交给输入框：没有可用模型时输入框自己
 *   会说明原因并给出「去登记模型」（`composerBlockedReason` 的 no-model 分支）。
 *   那条提示在用户每次想说话时都会出现，比模态框更持久，也不打断阅读。
 *
 * 会话级跳过存在内存里，不落盘：重启后若仍无供应商会再出现。
 */

export const CONDA_ENV_NOTICE =
  '安装包不包含 conda 环境 lsci / lsci-r。可在本页一键下载 micromamba 并创建。' as const;

export type FirstRunGate = {
  readonly providerCount: number;
  /**
   * 本次会话用户已经选过「跳过」。
   *
   * 为真时不再用遮罩拦人。重新打开入口的方式是显式动作（输入框的「去登记模型」
   * 会把 App 的 skippedThisSession 清回 false），而不是靠遮罩自己回来。
   */
  readonly skippedThisSession: boolean;
  /** 当前主视图。设置页始终不弹——用户正在那里登记。 */
  readonly view: string;
};

export function shouldShowFirstRun(input: FirstRunGate): boolean {
  if (input.providerCount > 0) return false;
  if (input.view === 'settings') return false;
  if (input.skippedThisSession) return false;
  return true;
}
