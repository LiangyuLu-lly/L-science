/**
 * 计划面板（任务 #10，需求 10.1、10.4）。
 *
 * 计划是「可审阅、可修改、可批准」的对象，这三件事都必须在界面上做得到，否则
 * 「生成计划」只是把一段文字写进上下文——那和让模型在回答里列步骤没有区别。
 *
 * ## 批准是用户动作
 *
 * `plan.decide` 是 IPC 而不是工具：模型不能批准自己的计划。这里的按钮就是那条
 * 需求的唯一落点，因此草稿状态必须显眼——一个等着批准的计划如果不显眼，用户
 * 会以为 agent 卡住了。
 *
 * ## 为什么按阶段分组而不是平铺
 *
 * 阶段是并行边界：同一阶段内的步骤可以并行（受 `dependsOn` 约束），跨阶段不行。
 * 平铺的话用户看不出哪些会同时跑，而「这两步会同时改同一个文件吗」正是他要判断的事。
 *
 * ## 修改用完整替换
 *
 * `plan.replace` 的载荷是完整计划本体。局部补丁在「删掉一个被依赖的步骤」这类
 * 改动上无法表达，而那正是用户最常想做的修改。因此编辑器直接编辑 JSON——
 * 它同时也是唯一能表达任意结构改动的形式。
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import {
  decidePlan,
  listPlans,
  replacePlan,
  PLAN_STATUS_LABEL,
  PLAN_STEP_STATUS_LABEL,
  type PlanIssue,
  type PlanStepRecord,
  type PlanView,
} from '../lib/api.js';
import { BackendError } from '../lib/backend.js';

function errorText(err: unknown): string {
  if (err instanceof BackendError) {
    const parts = [err.message];
    if (err.detail !== undefined) parts.push(err.detail);
    if (err.remediation !== undefined) parts.push(err.remediation);
    return parts.join('　');
  }
  return err instanceof Error ? err.message : String(err);
}

function timeText(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 步骤行。委派信息与产出要显示——它们是「这一步交出什么」的答案。 */
function StepRow({
  step,
  spec,
}: {
  step: PlanStepRecord;
  spec: PlanView['spec'];
}): React.JSX.Element {
  const specStep = spec.steps.find((s) => s.ref === step.ref);
  const delegation = specStep?.delegation ?? null;

  return (
    <li className={`planstep planstep--${step.status}`}>
      <div className="planstep__head">
        <span className={`planstep__status planstep__status--${step.status}`}>
          {PLAN_STEP_STATUS_LABEL[step.status]}
        </span>
        <span className="planstep__title">{step.title ?? step.ref}</span>
        <code className="planstep__ref">{step.ref}</code>
      </div>

      {step.description !== null && step.description !== '' && (
        <p className="planstep__desc">{step.description}</p>
      )}

      <dl className="planstep__meta">
        {step.skillSlug !== null && (
          <>
            <dt>技能</dt>
            <dd>
              <code>{step.skillSlug}</code>
            </dd>
          </>
        )}
        {specStep !== undefined && specStep.tools.length > 0 && (
          <>
            <dt>工具</dt>
            <dd>{specStep.tools.join('、')}</dd>
          </>
        )}
        {specStep !== undefined && specStep.dependsOn.length > 0 && (
          <>
            <dt>依赖</dt>
            <dd>
              {specStep.dependsOn.map((r) => (
                <code key={r}>{r}</code>
              ))}
            </dd>
          </>
        )}
        {/*
          produces 是步骤间的交接界面。空着意味着下一步不知道该拿什么当输入，
          校验层会为此报 warning，这里也要显出来
        */}
        {specStep !== undefined && (
          <>
            <dt>产出</dt>
            <dd className={specStep.produces.length === 0 ? 'planstep__missing' : ''}>
              {specStep.produces.length === 0
                ? '未声明——下一步不知道该拿什么当输入'
                : specStep.produces.join('、')}
            </dd>
          </>
        )}
        {delegation !== null && (
          <>
            <dt>委派</dt>
            <dd>
              {delegation.parallel ? '并行' : '顺序'}·
              {/*
                阻塞与非阻塞的区别在中断语义上：用户中断会取消阻塞式子 agent，
                非阻塞的留着跑。这一点必须显示，否则「我点了停止但它还在跑」说不清
              */}
              {delegation.blocking ? '阻塞（中断会一并取消）' : '非阻塞（中断不影响它）'}
              {delegation.maxConcurrent === undefined
                ? ''
                : `·并发上限 ${String(delegation.maxConcurrent)}`}
            </dd>
          </>
        )}
        {step.resultRef !== null && (
          <>
            <dt>结果</dt>
            <dd>
              <code>{step.resultRef}</code>
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

function PlanEditor({
  plan,
  projectId,
  onClose,
  onSaved,
}: {
  plan: PlanView;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [text, setText] = useState(() => `${JSON.stringify(plan.spec, null, 2)}\n`);
  const [issues, setIssues] = useState<PlanIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editorId = useId();

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setIssues([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      setSaving(false);
      return;
    }
    try {
      const result = await replacePlan(projectId, plan.id, parsed);
      // 成功也可能带非阻塞警告，要显示出来而不是当成没事
      setIssues(result.issues);
      if (result.issues.every((i) => i.level !== 'error')) onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="planeditor">
      <div className="planeditor__head">
        {/*
          用 label 而不是 span（需求 20.5.2）。视觉上一样，区别在于屏幕阅读器把焦点
          移到编辑框时能读出「编辑计划本体」——挂在 span 上的话它只会读「编辑框」，
          而这个页面上有好几个多行输入。
        */}
        <label htmlFor={editorId}>编辑计划本体</label>
        <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>
          取消
        </button>
      </div>
      <p className="planeditor__hint">
        提交的是完整计划本体，不是局部补丁——「删掉一个被依赖的步骤」这类改动只有完整
        替换才表达得出来。`phases` 可以省略，后端会按步骤里出现的阶段号补全。
      </p>
      <textarea
        id={editorId}
        className="planeditor__code"
        value={text}
        rows={20}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      {error !== null && (
        <pre className="planeditor__error" role="alert">
          {error}
        </pre>
      )}
      {issues.length > 0 && (
        <ul className="planeditor__issues">
          {issues.map((issue, i) => (
            <li key={`${issue.code}-${String(i)}`} className={`is-${issue.level}`}>
              [{issue.level === 'error' ? '阻止执行' : '提示'}] {issue.message}
              {issue.ref === undefined ? '' : `（${issue.ref}）`}
              {issue.suggestion === undefined ? '' : ` → ${issue.suggestion}`}
            </li>
          ))}
        </ul>
      )}
      <div className="planeditor__actions">
        <button type="button" className="btn" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存并重新校验'}
        </button>
      </div>
    </div>
  );
}

export interface PlanPanelProps {
  projectId: string | null;
  conversationId: string | null;
  /** 外部刷新信号（收到 plan.created / plan.decided 广播时自增）。 */
  refreshKey: number;
}

export function PlanPanel({
  projectId,
  conversationId,
  refreshKey,
}: PlanPanelProps): React.JSX.Element {
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (projectId === null || conversationId === null) {
      setPlans([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listPlans(projectId, conversationId);
      setPlans(result.plans);
      // 默认展开最新那份：用户打开面板就是想看当前计划
      setExpanded((prev) => prev ?? result.plans[0]?.id ?? null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const decide = async (planId: string, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await decidePlan(projectId ?? '', planId, decision, note);
      setNote('');
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const draft = useMemo(() => plans.find((p) => p.status === 'draft') ?? null, [plans]);

  if (projectId === null || conversationId === null) {
    return <p className="sidepanel__hint">先选一个会话。</p>;
  }

  return (
    <div className="planpanel">
      {error !== null && (
        <p className="sidepanel__error" role="alert">
          {error}
        </p>
      )}

      {plans.length === 0 && !loading && (
        <p className="sidepanel__hint">
          这个对话还没有步骤清单。复杂任务会先列出步骤，等你同意再做；简单问题不用。
        </p>
      )}

      {/*
        草稿计划置顶且带明显样式。等着批准的计划如果不显眼，用户会以为 agent 卡住了，
        而实际上它在等他点批准
      */}
      {draft !== null && (
        <div className="planpanel__awaiting" role="status">
          <strong>有一份步骤清单等你点头。</strong>
          点头之后才会开始做。若不同意，写明原因，下次会按你的意见重列。
        </div>
      )}

      {plans.map((plan) => {
        const open = expanded === plan.id;
        const byPhase = new Map<number, PlanStepRecord[]>();
        for (const step of plan.steps) {
          const list = byPhase.get(step.phase);
          if (list === undefined) byPhase.set(step.phase, [step]);
          else list.push(step);
        }

        return (
          <section key={plan.id} className={`plancard plancard--${plan.status}`}>
            <button
              type="button"
              className="plancard__head"
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : plan.id)}
            >
              <span className={`plancard__status plancard__status--${plan.status}`}>
                {PLAN_STATUS_LABEL[plan.status]}
              </span>
              <span className="plancard__goal">{plan.spec.goal}</span>
              <span className="plancard__progress">
                {plan.progress.byStatus.done}/{plan.progress.total}
                {plan.progress.byStatus.failed > 0 && (
                  <span className="plancard__failed"> 失败 {plan.progress.byStatus.failed}</span>
                )}
              </span>
            </button>

            {open && (
              <div className="plancard__body">
                <p className="plancard__meta">
                  {timeText(plan.createdAt)} ·{' '}
                  {plan.progress.currentPhase === null
                    ? '全部步骤已收尾'
                    : `当前阶段 ${String(plan.progress.currentPhase)}`}
                </p>

                {editing === plan.id ? (
                  <PlanEditor
                    plan={plan}
                    projectId={projectId}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                      setEditing(null);
                      void refresh();
                    }}
                  />
                ) : (
                  [...byPhase.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([phase, steps]) => {
                      const title =
                        plan.spec.phases.find((p) => p.phase === phase)?.title ??
                        `阶段 ${String(phase)}`;
                      return (
                        <div key={phase} className="planphase">
                          <h4 className="planphase__title">
                            {title}
                            {/* 阶段是并行边界，写出来用户才知道哪些会同时跑 */}
                            {steps.length > 1 && (
                              <span className="planphase__note">
                                {steps.length} 步，同阶段内可并行
                              </span>
                            )}
                          </h4>
                          <ul className="planphase__steps">
                            {steps.map((step) => (
                              <StepRow key={step.id} step={step} spec={plan.spec} />
                            ))}
                          </ul>
                        </div>
                      );
                    })
                )}

                {plan.status === 'draft' && editing !== plan.id && (
                  <div className="plancard__decide">
                    <label htmlFor={`plan-note-${plan.id}`}>说明（拒绝时会交给下一轮生成）</label>
                    <textarea
                      id={`plan-note-${plan.id}`}
                      rows={2}
                      value={note}
                      placeholder="例如：第 2 步缺了多重比较校正"
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <div className="plancard__buttons">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void decide(plan.id, 'approve')}
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        className="btn btn--deny"
                        disabled={busy}
                        onClick={() => void decide(plan.id, 'reject')}
                      >
                        拒绝
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setEditing(plan.id)}
                      >
                        修改
                      </button>
                    </div>
                  </div>
                )}

                {plan.status !== 'draft' && (
                  <p className="plancard__locked">
                    {/* 说清为什么不能改，否则用户会找不到「修改」按钮而以为是 bug */}
                    只有草稿状态能改动本体。执行中改计划会让已完成的步骤与新步骤集合对不上
                    ——要改请让 agent 重新生成一份。
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
