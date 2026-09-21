/**
 * 首次运行：贴密钥就能进。计算环境后台装。DeepSeek / Ollama / conda 命令折在高级里。
 *
 * 可跳过。密钥不回显、提交后立刻清掉。安装包不含 conda 环境，这句话必须原文出现。
 */

import { useEffect, useState } from 'react';

import {
  bootstrapKernels,
  bootstrapKernelsStatus,
  loadEnvDoctor,
  provisionProviders,
  registerCompatProvider,
  type BootstrapKernelsReport,
  type EnvDoctor,
  type ProvisionProviderResult,
} from '../lib/api.js';
import { BackendError } from '../lib/backend.js';
import { CONDA_ENV_NOTICE } from '../lib/first-run.js';

const FIRST_RUN_PRESETS = [
  { id: 'openai', name: 'OpenAI', docsUrl: 'https://platform.openai.com/api-keys' },
  { id: 'groq', name: 'Groq', docsUrl: 'https://console.groq.com/keys' },
  { id: 'moonshot', name: 'Moonshot（Kimi）', docsUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'qwen', name: '通义千问', docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key' },
] as const;

type FirstRunPresetId = (typeof FIRST_RUN_PRESETS)[number]['id'];

function isFirstRunPreset(id: string): id is FirstRunPresetId {
  return FIRST_RUN_PRESETS.some((preset) => preset.id === id);
}

const SKIP_REASON_LABEL = {
  missing_key: '未提供密钥',
  health_failed: '健康检查失败',
  not_requested: '未请求检测',
} as const;

function errorText(err: unknown): string {
  if (err instanceof BackendError) {
    const parts = [err.message];
    if (err.detail !== undefined) parts.push(err.detail);
    if (err.remediation !== undefined) parts.push(err.remediation);
    return parts.join('　');
  }
  return err instanceof Error ? err.message : String(err);
}

function provisionLine(result: ProvisionProviderResult): string {
  switch (result.status) {
    case 'registered':
      return `${result.name}：已登记，${String(result.modelIds.length)} 个模型`;
    case 'skipped': {
      const reason = SKIP_REASON_LABEL[result.reason];
      return result.detail === undefined
        ? `${result.name}：已跳过（${reason}）`
        : `${result.name}：已跳过（${reason}：${result.detail}）`;
    }
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

export function EnvDoctorSection({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const [doctor, setDoctor] = useState<EnvDoctor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [boot, setBoot] = useState<BootstrapKernelsReport | null>(null);

  useEffect(() => {
    let disposed = false;
    void loadEnvDoctor()
      .then((report) => {
        if (!disposed) {
          setDoctor(report);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) setError(errorText(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    void bootstrapKernels()
      .then((report) => {
        if (!disposed) setBoot(report);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(errorText(err));
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (boot?.running !== true) return;
    const timer = setInterval(() => {
      void bootstrapKernelsStatus()
        .then((report) => {
          setBoot(report);
          if (!report.running) {
            void loadEnvDoctor(true).then((doc) => {
              setDoctor(doc);
            });
          }
        })
        .catch((err: unknown) => {
          setError(errorText(err));
        });
    }, 3000);
    return () => {
      clearInterval(timer);
    };
  }, [boot?.running]);

  return (
    <section className="panel" aria-labelledby="env-doctor-heading">
      <h2 id="env-doctor-heading" className="panel__title">
        {compact ? '环境体检' : '环境'}
      </h2>
      <p className="panel__hint">{CONDA_ENV_NOTICE}</p>
      <p className="panel__hint" role="status">
        {boot === null
          ? '正在准备计算环境…'
          : boot.running
            ? `正在安装内核（Python ${boot.python} / R ${boot.r}），可先去贴密钥。`
            : boot.error !== null
              ? `环境未装完：${boot.error}。点『一键安装 Python / R 内核』；装不上时再用手动命令`
              : '计算环境已就绪。'}
      </p>
      <button
        type="button"
        className="btn btn--small"
        disabled={boot?.running === true}
        onClick={() => {
          setError(null);
          void bootstrapKernels()
            .then((report) => {
              setBoot(report);
            })
            .catch((err: unknown) => {
              setError(errorText(err));
            });
        }}
      >
        一键安装 Python / R 内核
      </button>
      <p className="panel__hint">点『一键安装 Python / R 内核』；装不上时再用手动命令</p>
      {boot !== null && boot.log.length > 0 && (
        <pre className="tools__remediation">
          <code>{boot.log.slice(-8).join('\n')}</code>
        </pre>
      )}
      <details>
        <summary>手动命令</summary>
        <p className="panel__hint">装不上时再用：</p>
        <pre className="tools__remediation">
          <code>conda create -n lsci python=3.13</code>
        </pre>
        <pre className="tools__remediation">
          <code>conda create -n lsci-r -c conda-forge r-base r-irkernel</code>
        </pre>
        <p className="panel__hint">也可在仓库跑 scripts/bootstrap-kernels.ps1（不把 conda 打进安装包）。</p>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            void navigator.clipboard.writeText(
              'conda create -n lsci python=3.13\nconda create -n lsci-r -c conda-forge r-base r-irkernel',
            );
          }}
        >
          复制 lsci 命令
        </button>
      </details>
      {loading && (
        <p className="pcard__busy" role="status">
          正在检查环境…
        </p>
      )}
      {error !== null && (
        <p className="view__error" role="alert">
          {error}
        </p>
      )}
      {!loading && doctor !== null && (
        <>
          <dl className="kv">
            <dt>数据目录</dt>
            <dd>
              <code>{doctor.dataDirLabel}</code>
            </dd>
          </dl>
          {doctor.capabilities.split('\n').map((line) => (
            <p key={line} className="panel__hint">
              {line}
            </p>
          ))}
          {doctor.blockers.length > 0 && (
            <ul>
              {doctor.blockers.map((blocker) => (
                <li key={blocker.id}>
                  <strong>{blocker.what}</strong>
                  <p className="panel__hint">{blocker.consequence}</p>
                  {blocker.command !== '' && (
                    <pre className="tools__remediation">
                      <code>{blocker.command}</code>
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
          {doctor.gaps.length > 0 && (
            <ul>
              {doctor.gaps.map((gap) => (
                <li key={gap.id}>
                  <strong>{gap.what}</strong>
                  <p className="panel__hint">{gap.consequence}</p>
                  {gap.plan !== null && <p className="panel__hint">补齐方式：{gap.plan}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="pcard__actions">
        <button
          type="button"
          className="btn btn--small"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(null);
            void loadEnvDoctor(true)
              .then((report) => {
                setDoctor(report);
                setError(null);
              })
              .catch((err: unknown) => {
                setError(errorText(err));
              })
              .finally(() => {
                setLoading(false);
              });
          }}
        >
          重新检查
        </button>
      </div>
    </section>
  );
}

export function FirstRunOverlay({
  onSkip,
  onDone,
}: {
  onSkip: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const [deepseekKey, setDeepseekKey] = useState('');
  const [presetId, setPresetId] = useState<FirstRunPresetId>('moonshot');
  const [compatKey, setCompatKey] = useState('');
  const [compatOk, setCompatOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly ProvisionProviderResult[] | null>(null);

  const registered =
    compatOk || (results?.some((item) => item.status === 'registered') ?? false);
  const selectedPreset =
    FIRST_RUN_PRESETS.find((item) => item.id === presetId) ?? FIRST_RUN_PRESETS[0];

  const runProvision = async (input: {
    readonly deepseekKey?: string;
    readonly detectOllama?: boolean;
  }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await provisionProviders(input);
      setResults(outcome.providers);
      if (input.deepseekKey !== undefined) setDeepseekKey('');
    } catch (err) {
      if (err instanceof BackendError || err instanceof Error) {
        setError(errorText(err));
      } else {
        setError(String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void provisionProviders({ detectOllama: true })
      .then((outcome) => {
        setResults(outcome.providers);
      })
      .catch(() => {
        // 本机没有 Ollama 时不必报错
      });
  }, []);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <div className="overlay__stack">
      <section className="panel">
        <h2 id="first-run-title" className="panel__title">
          开始使用
        </h2>
        <p className="panel__hint">
          把密钥贴进去就能对话。计算环境在后台安装，不用等。默认 Kimi，也可改通义 / OpenAI / Groq。
        </p>

        <form
          className="cred-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (compatKey === '') return;
            setBusy(true);
            setError(null);
            void registerCompatProvider({ presetId, apiKey: compatKey })
              .then(() => {
                setCompatKey('');
                setCompatOk(true);
                onDone();
              })
              .catch((err: unknown) => {
                setError(errorText(err));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <div className="cred-form__field">
            <label htmlFor="first-run-preset">云端接口</label>
            <select
              id="first-run-preset"
              value={presetId}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value;
                if (isFirstRunPreset(next)) setPresetId(next);
              }}
            >
              {FIRST_RUN_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </div>
          <div className="cred-form__field">
            <label htmlFor="first-run-compat-key">API 密钥</label>
            <input
              id="first-run-compat-key"
              type="password"
              value={compatKey}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={busy}
              onChange={(event) => setCompatKey(event.target.value)}
            />
            <span className="cred-form__hint">提交后立刻从界面清除，不会回显。</span>
            <a
              className="cred-form__hint"
              href={selectedPreset.docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              获取 {selectedPreset.name} 密钥
            </a>
          </div>
          <button type="submit" className="btn" disabled={busy || compatKey === ''}>
            开始使用
          </button>
        </form>

        <details>
          <summary>其他方式（DeepSeek / Ollama）</summary>
        <form
          className="cred-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (deepseekKey === '') return;
            void runProvision({ deepseekKey, detectOllama: false });
          }}
        >
          <div className="cred-form__field">
            <label htmlFor="first-run-deepseek">DeepSeek API 密钥</label>
            <input
              id="first-run-deepseek"
              type="password"
              value={deepseekKey}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setDeepseekKey(event.target.value)}
            />
            <span className="cred-form__hint">提交后立刻从界面清除，不会回显。</span>
            <a
              className="cred-form__hint"
              href="https://platform.deepseek.com"
              target="_blank"
              rel="noreferrer"
            >
              获取 DeepSeek API 密钥
            </a>
          </div>
          <button type="submit" className="btn" disabled={busy || deepseekKey === ''}>
            登记 DeepSeek
          </button>
        </form>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => void runProvision({ detectOllama: true })}
          >
            检测本机 Ollama
          </button>
        </details>
        <div className="pcard__actions">
          <button type="button" className="btn btn--small" disabled={busy} onClick={onSkip}>
            本次跳过，可在设置里再打开
          </button>
          {busy && (
            <span className="pcard__busy" role="status">
              处理中…
            </span>
          )}
        </div>

        {error !== null && (
          <p className="view__error" role="alert">
            {error}
          </p>
        )}

        {results !== null && (
          <ul className="panel__hint">
            {results.map((item) => (
              <li key={item.id}>{provisionLine(item)}</li>
            ))}
          </ul>
        )}

        {registered && (
          <>
            <p className="pcard__notice">已登记至少一个供应商，可以开始使用。</p>
            <button type="button" className="btn" onClick={onDone}>
              开始使用
            </button>
          </>
        )}
      </section>
        <EnvDoctorSection />
      </div>
    </div>
  );
}
