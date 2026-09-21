/**
 * 隔离强度徽章（任务 9.4，需求 2.5、2.6）。
 *
 * 设计目标里的「诚实降级」全靠这个组件落地。它有两条硬要求：
 *
 * 1. **caveats 必须原文展示**，不做概括、不做美化。概括的过程就是弱化的过程——
 *    「文件系统边界仅靠工具层，内核内代码可绕过」被概括成「隔离较弱」之后，
 *    用户不再知道具体能被绕过什么。
 * 2. **不能只靠颜色传达状态**。徽章同时带文字标签，因为色盲用户、高对比模式、
 *    以及打印出来的截图都读不出颜色。
 */

import { useEffect, useState } from 'react';

import { loadIsolation, type IsolationInfo } from '../lib/api.js';
import { hasBackend } from '../lib/backend.js';

const STRENGTH_LABEL: Record<'strong' | 'weak', string> = {
  strong: '强隔离',
  weak: '弱隔离',
};

const BACKEND_LABEL: Record<string, string> = {
  native: '原生（Windows 作业对象）',
  wsl2: 'WSL2（命名空间）',
};

const FILESYSTEM_LABEL: Record<string, string> = {
  namespace: '命名空间隔离',
  acl: 'ACL 限制',
  advisory: '仅工具层约束',
};

const NETWORK_LABEL: Record<string, string> = {
  namespace: '命名空间隔离',
  proxy: '出口代理管控',
  none: '无管控',
};

const PROCESS_LABEL: Record<string, string> = {
  'job-object': 'Windows 作业对象',
  cgroup: 'cgroup 限额',
  monitor: '进程树监控（非硬限额）',
  container: '容器隔离',
  none: '无限额',
};

export function IsolationBadge(): React.JSX.Element {
  const [info, setInfo] = useState<IsolationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!hasBackend()) return;
    let disposed = false;

    void loadIsolation()
      .then((result) => {
        if (!disposed) setInfo(result);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      disposed = true;
    };
  }, []);

  if (!hasBackend()) {
    return (
      <span className="isolation isolation--unknown" role="status">
        隔离强度未知（请通过桌面外壳启动）
      </span>
    );
  }

  if (error !== null) {
    return (
      <span className="isolation isolation--unknown" role="status">
        {/* 探测失败时不假装是强隔离。未知就说未知 */}
        隔离强度未知（{error}）
      </span>
    );
  }

  if (info === null) {
    return (
      <span className="isolation isolation--unknown" role="status">
        正在探测隔离强度…
      </span>
    );
  }

  const caveatCount = info.isolation.caveats.length;

  return (
    <div className={`isolation isolation--${info.strength}`}>
      <button
        type="button"
        className="isolation__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* 折叠态说机制，不把「弱隔离」当吓词。强度文字仍走 STRENGTH_LABEL，给展开层与色盲用户 */}
        <span className="isolation__strength">本机用户态隔离（点击查看说明）</span>
        <span className="isolation__backend">{BACKEND_LABEL[info.backend] ?? info.backend}</span>
        {caveatCount > 0 && <span className="isolation__caveat-count">{caveatCount} 项限制</span>}
        <span aria-hidden="true" className="isolation__chevron">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div className="isolation__detail">
          <dl className="kv">
            <dt>隔离强度</dt>
            <dd>{STRENGTH_LABEL[info.strength]}</dd>
            <dt>文件系统</dt>
            <dd>{FILESYSTEM_LABEL[info.isolation.filesystem] ?? info.isolation.filesystem}</dd>
            <dt>网络</dt>
            <dd>{NETWORK_LABEL[info.isolation.network] ?? info.isolation.network}</dd>
            <dt>进程与资源</dt>
            <dd>{PROCESS_LABEL[info.isolation.process] ?? info.isolation.process}</dd>
          </dl>

          {/*
            出口管控的性质必须显式说明（需求 5.8）。proxy 级管控与命名空间隔离
            是两件事：前者靠环境变量引导，直接建 socket 的代码可以绕过。
            把它说成「网络隔离」是不诚实的。
          */}
          {info.isolation.network === 'proxy' && (
            <p className="isolation__proxy-note" role="note">
              网络出口按域名白名单管控，但这是<strong>代理级</strong>管控：它靠向内核注入 HTTP_PROXY
              环境变量生效。requests、urllib 这类会读取该变量的库受管控，而直接 建 socket
              的代码可以绕过它。它防的是无意的数据外泄，不防有意的绕过。真正的 网络隔离需要 WSL2
              后端的命名空间。
            </p>
          )}

          {caveatCount > 0 && (
            <section className="isolation__caveats">
              <h4>已知限制</h4>
              {/* 原文展示，不概括。概括的过程就是弱化的过程 */}
              <ul>
                {info.isolation.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </section>
          )}

          {/*
            平台缺口（需求 20.4.1）。在 Windows 上这一段不出现——那是权威实现，
            gaps 为空。在 Linux/macOS 上它回答的是「这个平台上哪几项能力是降级的」，
            与沙箱强度是两件不同的事：即便沙箱后端一样，凭据库能不能用也不一样。

            每条都展示「实际行为」而不只是「不支持」，理由同 caveats：概括的过程
            就是弱化的过程。
          */}
          {info.platform.gaps.length > 0 && (
            <section className="isolation__gaps">
              <h4>{info.platform.label} 上降级的能力</h4>
              <ul>
                {info.platform.gaps.map((gap) => (
                  <li key={gap.id}>
                    <strong>{gap.what}</strong>
                    <p className="isolation__gap-consequence">{gap.consequence}</p>
                    {gap.plan !== null && (
                      <p className="isolation__gap-plan">补齐方式：{gap.plan}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {info.platform.unknown && (
            <p className="isolation__proxy-note" role="note">
              当前平台（{info.platform.id}）不在已知平台列表里，按 POSIX 处理。路径与 shell
              应当可用，其余能力未经验证。
            </p>
          )}

          {info.skipped.length > 0 && (
            <section className="isolation__skipped">
              <h4>为什么没用更强的隔离</h4>
              <ul>
                {info.skipped.map((s) => (
                  <li key={s.id}>
                    <strong>{BACKEND_LABEL[s.id] ?? s.id}</strong>：{s.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
