/**
 * M0 阶段的应用外壳。
 *
 * 现在只有布局骨架与运行时自检显示——真正的会话视图、Artifacts、Plan、Reviewer
 * 与路由决策面板分别属于 M1-M4。
 */

export function App(): React.JSX.Element {
  return (
    <div className="app">
      <header className="app__header">
        <span className="app__brand">L-science</span>
        <span className="app__tag">本地优先 AI 科研工作台</span>
      </header>

      <div className="app__body">
        <nav className="app__nav" aria-label="主导航">
          <ul>
            <li aria-current="page">会话</li>
            <li className="is-pending">Artifacts</li>
            <li className="is-pending">Plan</li>
            <li className="is-pending">Reviewer</li>
            <li className="is-pending">路由决策</li>
            <li className="is-pending">设置</li>
          </ul>
        </nav>

        <main className="app__main">
          <h1>骨架已就绪</h1>
          <p>
            工具链与运行时环境已配置完成。下一步按分期路线进入 M1：接入 Jupyter 内核协议、 Shell
            Runner、<code>native</code> 沙箱与 Artifact 存储。
          </p>
          <p className="app__hint">
            运行 <code>npm run doctor</code> 可查看当前环境能力矩阵。
          </p>
        </main>
      </div>
    </div>
  );
}
