/**
 * M1 阶段的应用外壳。
 *
 * 目前只有布局骨架与后端连接状态——真正的会话视图、Artifacts、Plan、Reviewer
 * 与路由决策面板分别属于后续任务。
 */

import { useBackend } from './lib/useBackend.js';

const STATE_LABEL: Record<string, string> = {
  connecting: '连接中',
  ready: '已连接',
  unavailable: '暂时不可用',
  'no-bridge': '未通过桌面外壳启动',
};

function BackendPanel(): React.JSX.Element {
  const { state, status, error, attempts, retryNow } = useBackend();

  return (
    <section className="panel" aria-labelledby="backend-heading">
      <h2 id="backend-heading" className="panel__title">
        控制平面
        <span className={`badge badge--${state}`} role="status">
          {STATE_LABEL[state] ?? state}
        </span>
      </h2>

      {status !== null && (
        <dl className="kv">
          <dt>数据目录</dt>
          <dd>
            <code>{status.dataDir}</code>
          </dd>
          <dt>SQLite</dt>
          <dd>
            {status.sqlite}（schema v{status.schema}）
          </dd>
          <dt>后端 Node</dt>
          <dd>
            {status.node}，pid {status.pid}
          </dd>
        </dl>
      )}

      {state === 'unavailable' && (
        <p className="panel__error">
          {error ?? '未知错误'}
          <button type="button" className="btn" onClick={retryNow}>
            立即重试
          </button>
          <span className="panel__hint">已尝试 {attempts} 次</span>
        </p>
      )}

      {state === 'no-bridge' && (
        <p className="panel__hint">当前在浏览器中直接打开了渲染层。控制平面只在桌面外壳内可用。</p>
      )}
    </section>
  );
}

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
          <BackendPanel />
          <p className="app__hint">
            运行 <code>npm run doctor</code> 查看环境能力矩阵，
            <code>npm run verify:backend</code> 验证控制平面通道。
          </p>
        </main>
      </div>
    </div>
  );
}
