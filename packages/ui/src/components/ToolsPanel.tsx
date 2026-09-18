/**
 * 工具与环境面板（需求 9.6）。
 *
 * 不可用的工具要**显示出来并带上安装指引**，而不是从列表里消失。消失的话用户
 * 会问「为什么不能跑 R」而界面上没有任何线索；显示出来并附上 conda 命令，
 * 他自己就能解决。
 *
 * 这与「不把不可用的工具暴露给模型」不矛盾：模型看到的是工具清单（不含它们），
 * 用户看到的是环境状态（含它们与原因）。两个受众要的信息不同。
 */

import { useEffect, useState } from 'react';

import { listTools, type ToolListing } from '../lib/api.js';

import { EnvDoctorSection } from './FirstRunOverlay.js';

const CAPABILITY_LABEL: Record<string, string> = {
  'kernel:python': 'Python 内核',
  'kernel:r': 'R 内核',
  'shell:powershell': 'PowerShell',
  'shell:bash': 'bash（WSL2）',
  filesystem: '文件系统',
};

export function ToolsPanel({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [listing, setListing] = useState<ToolListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === null) return;
    let disposed = false;

    void listTools(projectId)
      .then((r) => {
        if (!disposed) {
          setListing(r);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      disposed = true;
    };
  }, [projectId]);

  if (projectId === null) {
    return (
      <div className="view">
        <EnvDoctorSection compact />
        <p className="view__empty">请先选择一个项目。</p>
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="view">
        <EnvDoctorSection compact />
        <p className="view__error">{error}</p>
      </div>
    );
  }
  if (listing === null) {
    return (
      <div className="view">
        <EnvDoctorSection compact />
        <p>加载中…</p>
      </div>
    );
  }

  return (
    <div className="view">
      <EnvDoctorSection compact />
      <section className="panel" aria-labelledby="env-heading">
        <h2 id="env-heading" className="panel__title">
          运行时环境
        </h2>
        <dl className="kv">
          <dt>Python 环境</dt>
          <dd>{listing.pythonEnv ?? <span className="is-missing">未检测到</span>}</dd>
          <dt>R 环境</dt>
          <dd>{listing.rEnv ?? <span className="is-missing">未检测到</span>}</dd>
          <dt>可用能力</dt>
          <dd>
            {listing.capabilities.length === 0
              ? '无'
              : listing.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join('、')}
          </dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="tools-heading">
        <h2 id="tools-heading" className="panel__title">
          可用工具（{listing.available.length}）
        </h2>
        <ul className="tools">
          {listing.available.map((tool) => (
            <li key={tool.name} className="tools__item">
              <code className="tools__name">{tool.name}</code>
              <p className="tools__desc">{tool.description}</p>
            </li>
          ))}
        </ul>
      </section>

      {listing.unavailable.length > 0 && (
        <section className="panel panel--warn" aria-labelledby="unavailable-heading">
          <h2 id="unavailable-heading" className="panel__title">
            不可用的工具（{listing.unavailable.length}）
          </h2>
          <p className="panel__hint">
            这些工具没有暴露给模型——注册一个一调用就失败的工具只会让它反复重试。
            装好依赖并重启后端即可启用。
          </p>
          <ul className="tools">
            {listing.unavailable.map((tool) => (
              <li key={tool.name} className="tools__item tools__item--unavailable">
                <code className="tools__name">{tool.name}</code>
                <ul className="tools__missing">
                  {tool.missing.map((m) => (
                    <li key={m.capability}>
                      <span className="tools__capability">
                        {CAPABILITY_LABEL[m.capability] ?? m.capability}
                      </span>
                      {/* 指引可复制粘贴。「请安装 R」帮不了任何人 */}
                      <pre className="tools__remediation">
                        <code>{m.remediation}</code>
                      </pre>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
