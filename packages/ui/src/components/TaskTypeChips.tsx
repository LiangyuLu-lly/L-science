/**
 * 一次性任务类型芯片（B5）。
 *
 * 点一下只改这一条消息的 `routing.taskType`。推断引擎是关键词表，故意不猜
 * `citation.verify`；芯片是覆盖入口，不是给那张表补关键词。
 */

import type { TaskType } from '../lib/api.js';

export const TASK_TYPE_CHIPS = [
  { label: '写代码', taskType: 'analysis.codegen' },
  { label: '画图', taskType: 'figure.compose' },
  { label: '核对引用', taskType: 'citation.verify' },
] as const;

export type ChipTaskType = (typeof TASK_TYPE_CHIPS)[number]['taskType'];

export function TaskTypeChips({
  selected,
  onSelect,
}: {
  selected: TaskType | undefined;
  onSelect: (taskType: ChipTaskType) => void;
}): React.JSX.Element {
  return (
    <div className="tchips" role="group" aria-label="本条消息的任务类型">
      <span className="tchips__label">本条任务</span>
      {TASK_TYPE_CHIPS.map((chip) => (
        <button
          key={chip.taskType}
          type="button"
          className={`tchips__chip ${selected === chip.taskType ? 'is-current' : ''}`}
          aria-pressed={selected === chip.taskType}
          onClick={() => onSelect(chip.taskType)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
