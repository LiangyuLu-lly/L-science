/**
 * 审批卡片（任务 9.4，需求 17.1、17.2、17.5、20.5.2）。
 *
 * 三条设计要求都来自「用户要能做出知情决定」：
 *
 * 1. **影响范围与可逆性单独显示**，不埋在正文里。用户在扫读时会跳过长段落，
 *    但不会跳过一个标着「不可逆」的醒目标记。
 * 2. **不可逆操作需要更强的确认**。可逆的直接给按钮；不可逆的要求先勾选一个
 *    确认框——这不是形式主义，它把「手滑点到」与「决定要做」区分开。
 * 3. **键盘可完整操作**。审批是阻塞流程的关键交互，只能用鼠标点意味着依赖
 *    键盘的用户根本无法继续工作。
 */

import { useId, useState } from 'react';

import type { ApprovalRequest, GrantScope } from '../lib/api.js';

const SCOPE_LABEL: Record<GrantScope, string> = {
  once: '仅这一次',
  session: '本次会话内',
  project: '本项目内',
  always: '始终允许',
};

const SCOPE_HINT: Record<GrantScope, string> = {
  once: '这一次放行，不建立持久授权。下次还会再问。',
  session: '当前会话内不再询问，会话结束后失效。',
  project: '本项目内不再询问，其他项目仍会询问。',
  always: '所有项目内都不再询问。可随时在设置里撤销。',
};

const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  'artifact-delete': '删除制品',
  'host-access': '访问沙箱外的路径',
  'compute-target': '登记算力目标',
  'ssh-command': '在远程主机执行命令',
  'compute-job': '提交算力作业',
  'compute-provider': '使用算力凭据',
  'domain-allowlist': '新增域名白名单',
  'skill-write': '写入技能',
  'package-install': '安装或卸载依赖包',
};

/** 有效期档位的标签（需求 17.5）。 */
function expiryLabel(ms: number | null): string {
  if (ms === null) return '不过期';
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${String(Math.round(hours))} 小时`;
  return `${String(Math.round(hours / 24))} 天`;
}

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  onDecide: (
    decision: 'approve' | 'deny',
    options: { note?: string; scope?: GrantScope; expiresInMs?: number | null },
  ) => Promise<void>;
}

export function ApprovalCard({ approval, onDecide }: ApprovalCardProps): React.JSX.Element {
  const titleId = useId();
  const confirmId = useId();
  const noteId = useId();
  const expiryId = useId();

  const hasScopes = approval.scopeOptions.length > 0;
  // 默认取最保守的可选项。默认到 always 会让惯性点击建立一个用户没想给的长期授权
  const [scope, setScope] = useState<GrantScope>(
    (['once', 'session', 'project', 'always'] as const).find((s) =>
      approval.scopeOptions.includes(s),
    ) ?? 'once',
  );

  /*
   * 有效期只在选了持久作用域时才有意义（需求 17.5）。
   *
   * 默认取**最短**的档位而不是「不过期」：与作用域同一条理由——惯性点击不该建立一个
   * 用户没想给的长期授权。想要长期的人会去改这个下拉框，而想要短期的人不会想到去检查
   * 一个默认成永久的选项。
   */
  const expiryOptions = approval.expiryOptions ?? [];
  const [expiresInMs, setExpiresInMs] = useState<number | null>(
    expiryOptions.find((v): v is number => v !== null) ?? null,
  );
  const showExpiry = expiryOptions.length > 0 && scope !== 'once';

  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  // 不可逆操作要求先确认。可逆的不要求——每次都强制勾选会训练用户机械性勾选，
  // 反而让这个机制在真正需要时失效
  const needsAck = !approval.reversible;
  const canApprove = !busy && (!needsAck || acknowledged);

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    setBusy(true);
    try {
      await onDecide(decision, {
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        ...(hasScopes && decision === 'approve' ? { scope } : {}),
        ...(showExpiry && decision === 'approve' ? { expiresInMs } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`approval approval--${approval.reversible ? 'reversible' : 'irreversible'}`}
      // alertdialog 而不是 dialog：这是需要用户响应才能继续的阻塞交互，
      // 屏幕阅读器应当打断当前朗读来通报它
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-impact`}
    >
      <header className="approval__head">
        <span className="approval__kind">{KIND_LABEL[approval.kind]}</span>
        {/* 可逆性用文字而不是只用颜色或图标 */}
        <span
          className={`approval__reversible approval__reversible--${approval.reversible ? 'yes' : 'no'}`}
        >
          {approval.reversible ? '可撤销' : '不可撤销'}
        </span>
      </header>

      <h3 id={titleId} className="approval__title">
        {approval.title}
      </h3>

      {approval.detail !== '' && <pre className="approval__detail">{approval.detail}</pre>}

      <div id={`${titleId}-impact`} className="approval__impact">
        <h4>影响范围</h4>
        <p>{approval.impact}</p>
      </div>

      {approval.undoHint !== null && (
        <p className="approval__undo">
          <strong>撤销方式：</strong>
          {approval.undoHint}
        </p>
      )}

      {hasScopes && (
        <fieldset className="approval__scopes">
          <legend>授权范围</legend>
          {approval.scopeOptions.map((option) => (
            <label key={option} className="approval__scope">
              <input
                type="radio"
                name={`${titleId}-scope`}
                value={option}
                checked={scope === option}
                onChange={() => setScope(option)}
              />
              <span className="approval__scope-label">{SCOPE_LABEL[option]}</span>
              <span className="approval__scope-hint">{SCOPE_HINT[option]}</span>
            </label>
          ))}
        </fieldset>
      )}

      {showExpiry && (
        <>
          <label className="approval__expiry-label" htmlFor={expiryId}>
            有效期
          </label>
          <select
            id={expiryId}
            className="approval__expiry"
            value={expiresInMs === null ? 'never' : String(expiresInMs)}
            onChange={(e) =>
              setExpiresInMs(e.target.value === 'never' ? null : Number(e.target.value))
            }
          >
            {expiryOptions.map((option) => (
              <option
                key={option === null ? 'never' : option}
                value={option === null ? 'never' : String(option)}
              >
                {expiryLabel(option)}
              </option>
            ))}
          </select>
          <p className="approval__expiry-hint">
            {/*
              到期之后会重新询问，而不是静默失效——授权到期而没人告诉你，表现是
              agent 突然做不了一件它昨天能做的事。
            */}
            到期后同一操作会重新询问你。可随时在设置的授权列表里提前撤销。
          </p>
        </>
      )}

      <label className="approval__note-label" htmlFor={noteId}>
        备注（可选，会记入审批记录）
      </label>
      <input
        id={noteId}
        className="approval__note"
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="例如：这批数据还要用"
      />

      {needsAck && (
        <label className="approval__ack" htmlFor={confirmId}>
          <input
            id={confirmId}
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>我确认这个操作无法撤销</span>
        </label>
      )}

      <div className="approval__actions">
        {/* 拒绝放在前面：它是更安全的默认选择，也让 Tab 顺序先到它 */}
        <button
          type="button"
          className="btn btn--deny"
          onClick={() => void decide('deny')}
          disabled={busy}
        >
          拒绝
        </button>
        <button
          type="button"
          className="btn btn--approve"
          onClick={() => void decide('approve')}
          disabled={!canApprove}
          // 说明为什么按钮不可用，否则用户只看到一个灰掉的按钮
          aria-describedby={needsAck && !acknowledged ? confirmId : undefined}
        >
          {busy ? '处理中…' : '批准'}
        </button>
      </div>

      {needsAck && !acknowledged && (
        <p className="approval__blocked" role="note">
          这是不可撤销的操作，请先勾选上方的确认项。
        </p>
      )}
    </section>
  );
}
