/**
 * 一次性任务类型芯片（B5）。
 *
 * 点一下改这一条消息的 `routing.taskType`。推断引擎是关键词表，故意不猜
 * `citation.verify`；芯片是覆盖入口，不是给那张表补关键词。
 *
 * 「核对引用」额外对当前选中文献跑一次 `citation.verify`。schema 不收 refId，
 * 用题录/DOI 作为 `citations[]`——这是接口允许的文献级核对，不是只提示路由。
 */

import { useState } from 'react';

import {
  verifyCitations,
  type CitationVerdict,
  type TaskType,
} from '../lib/api.js';

export const TASK_TYPE_CHIPS = [
  { label: '写代码', taskType: 'analysis.codegen' },
  { label: '画图', taskType: 'figure.compose' },
  { label: '核对引用', taskType: 'citation.verify' },
] as const;

export type ChipTaskType = (typeof TASK_TYPE_CHIPS)[number]['taskType'];

type FocusCite = {
  readonly cite: string;
  readonly doi: string | null;
};

type Offender = {
  readonly raw: string;
  readonly verdict: CitationVerdict;
  readonly detail: string;
};

type CheckUi =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'cannot'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'done';
      readonly counts: Readonly<Record<CitationVerdict, number>>;
      readonly offenders: readonly Offender[];
    };

function assertNever(value: never): never {
  throw new Error(`未处理的核对状态：${JSON.stringify(value)}`);
}

function citationQuery(ref: FocusCite): string {
  const cite = ref.cite.trim();
  if (ref.doi !== null && cite !== '' && !cite.includes(ref.doi)) {
    return `${cite} ${ref.doi}`;
  }
  if (cite !== '') return cite;
  if (ref.doi !== null) return ref.doi;
  return '';
}

function formatCounts(counts: Readonly<Record<CitationVerdict, number>>): string {
  return (
    `核对完成：已核实 ${String(counts.verified)}，` +
    `not-found ${String(counts['not-found'])}，` +
    `metadata-mismatch ${String(counts['metadata-mismatch'])}，` +
    `ambiguous ${String(counts.ambiguous)}，` +
    `unverifiable ${String(counts.unverifiable)}。`
  );
}

function CheckFeedback({ ui }: { readonly ui: CheckUi }): React.JSX.Element | null {
  switch (ui.kind) {
    case 'idle':
      return null;
    case 'running':
      return (
        <p className="panel__hint" role="status">
          正在核对引用…
        </p>
      );
    case 'cannot':
      return (
        <p className="panel__hint" role="status">
          {ui.message}
        </p>
      );
    case 'failed':
      return (
        <p className="panel__error" role="alert">
          核对引用失败：{ui.message}
        </p>
      );
    case 'done':
      return (
        <div>
          <p className="panel__hint" role="status">
            {formatCounts(ui.counts)}
          </p>
          {ui.offenders.length > 0 ? (
            <ul className="panel__hint">
              {ui.offenders.map((result) => (
                <li key={`${result.verdict}:${result.raw}`}>
                  {result.verdict} · {result.raw} · {result.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    default:
      return assertNever(ui);
  }
}

export function TaskTypeChips({
  selected,
  onSelect,
  projectId,
  focusRef,
}: {
  selected: TaskType | undefined;
  onSelect: (taskType: ChipTaskType) => void;
  projectId: string | null;
  focusRef: FocusCite | null;
}): React.JSX.Element {
  const [checkUi, setCheckUi] = useState<CheckUi>({ kind: 'idle' });

  const runCitationCheck = async (): Promise<void> => {
    if (projectId === null) {
      setCheckUi({ kind: 'cannot', message: '同时跳过一次实际核对：当前没有项目' });
      return;
    }
    if (focusRef === null) {
      setCheckUi({ kind: 'cannot', message: '同时跳过一次实际核对：先在文献里选一篇，再点核对引用' });
      return;
    }
    const raw = citationQuery(focusRef);
    if (raw === '') {
      setCheckUi({
        kind: 'cannot',
        message: '同时跳过一次实际核对：这篇文献没有可核对的题录或 DOI',
      });
      return;
    }
    setCheckUi({ kind: 'running' });
    try {
      const outcome = await verifyCitations(projectId, { citations: [raw] });
      const offenders = outcome.results
        .filter((result) => result.verdict !== 'verified')
        .map((result) => ({
          raw: result.raw,
          verdict: result.verdict,
          detail: result.detail,
        }));
      setCheckUi({ kind: 'done', counts: outcome.counts, offenders });
    } catch (err: unknown) {
      if (err instanceof Error) {
        setCheckUi({ kind: 'failed', message: err.message });
        return;
      }
      throw err;
    }
  };

  return (
    <div>
      <div className="tchips" role="group" aria-label="本条消息的任务类型">
        <span className="tchips__label">本条任务</span>
        {TASK_TYPE_CHIPS.map((chip) => (
          <button
            key={chip.taskType}
            type="button"
            className={`tchips__chip ${selected === chip.taskType ? 'is-current' : ''}`}
            aria-pressed={selected === chip.taskType}
            onClick={() => {
              onSelect(chip.taskType);
              if (chip.taskType === 'citation.verify') {
                void runCitationCheck();
              }
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
      <CheckFeedback ui={checkUi} />
    </div>
  );
}
