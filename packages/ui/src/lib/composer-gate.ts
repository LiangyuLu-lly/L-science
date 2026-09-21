/**
 * 输入区门闩：控制平面、项目、会话、以及「一个模型都没有」。
 *
 * 首次运行遮罩可以跳过。跳过之后如果注册表仍空，发送只会得到「没有可用模型」。
 * 把输入区关掉，比让用户发一条注定失败的消息更诚实。
 */

export type ComposerBackendState = 'connecting' | 'ready' | 'unavailable' | 'no-bridge';

export type ComposerBlockCode =
  | 'no-bridge'
  | 'unavailable'
  | 'connecting'
  | 'no-project'
  | 'no-conversation'
  | 'no-model';

export type ComposerBlockInput = {
  readonly backendState: ComposerBackendState;
  readonly backendError: string | null;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly enabledModelCount: number | null;
};

export type ComposerBlock = {
  readonly code: ComposerBlockCode;
  readonly message: string;
};

export function composerBlockedReason(input: ComposerBlockInput): ComposerBlock | null {
  switch (input.backendState) {
    case 'no-bridge':
      return {
        code: 'no-bridge',
        message: '当前在浏览器里直接打开了渲染层，控制平面只在桌面外壳内可用。',
      };
    case 'unavailable':
      return {
        code: 'unavailable',
        message: `控制平面暂时不可用：${input.backendError ?? '未知错误'}`,
      };
    case 'connecting':
      return { code: 'connecting', message: '正在连接控制平面…' };
    case 'ready':
      break;
    default: {
      const unreachable: never = input.backendState;
      return unreachable;
    }
  }

  if (input.projectId === null) {
    return { code: 'no-project', message: '还没有项目。请先创建一个项目。' };
  }
  if (input.conversationId === null) {
    return { code: 'no-conversation', message: '正在准备会话…' };
  }
  if (input.enabledModelCount === 0) {
    return { code: 'no-model', message: '没有可用模型。请先登记模型。' };
  }
  return null;
}
