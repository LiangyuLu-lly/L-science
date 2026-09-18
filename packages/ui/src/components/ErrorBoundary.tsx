/**
 * 渲染层未捕获错误的回退界面。
 *
 * 没有它时，任意子树抛错会让整页白屏，用户看不到原因也无法继续。样式复用
 * `.view__error`，不另起一套。
 */

import { Component, type ReactNode } from 'react';

type Props = {
  readonly children: ReactNode;
};

type State = {
  readonly error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  public constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="view" role="alert" aria-label="界面发生错误">
        <p className="view__error">{this.state.error.message}</p>
      </div>
    );
  }
}
