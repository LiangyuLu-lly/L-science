/**
 * 工具调用卡片（任务 9.2，需求 3.6）。
 *
 * 展示输入、输出、状态与耗时。输入默认折叠——一次 python 调用的代码可能上百行，
 * 展开会把对话流冲散，而用户多数时候只想看结果。
 */

import type { ToolCallView } from '../lib/useTurn.js';
import { RichOutput } from './RichOutput.js';

/** 状态既有文字也有颜色。只靠颜色的话色盲用户与高对比模式下都读不出来。 */
function statusOf(call: ToolCallView): { label: string; tone: 'running' | 'ok' | 'error' } {
  if (call.output === null) return { label: '执行中', tone: 'running' };
  if (call.output.kind === 'error') return { label: '出错', tone: 'error' };
  return { label: '完成', tone: 'ok' };
}

function formatDuration(call: ToolCallView): string {
  if (call.endedAt === null) return '进行中';
  const ms = call.endedAt - call.startedAt;
  if (ms < 1000) return `${String(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 把工具入参渲染成可读形式。代码类参数单独取出，避免被 JSON 转义弄花。 */
function InputBody({ input }: { input: unknown }): React.JSX.Element {
  if (typeof input === 'string') {
    // 编排器把 argumentsJson 原样传过来，先试着解析
    try {
      return <InputBody input={JSON.parse(input)} />;
    } catch {
      return (
        <pre className="tool__input">
          <code>{input}</code>
        </pre>
      );
    }
  }

  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    // code / command 是最常见的长字段，单独按代码块渲染。JSON.stringify 会把
    // 换行变成 \n，一段 30 行的 Python 变成一行不可读的字符串
    const codeField = ['code', 'command', 'newText', 'oldText'].find(
      (k) => typeof obj[k] === 'string',
    );

    if (codeField !== undefined) {
      const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== codeField));
      return (
        <div>
          <pre className="tool__input tool__input--code">
            <code>{obj[codeField] as string}</code>
          </pre>
          {Object.keys(rest).length > 0 && (
            <pre className="tool__input">
              <code>{JSON.stringify(rest, null, 2)}</code>
            </pre>
          )}
        </div>
      );
    }

    return (
      <pre className="tool__input">
        <code>{JSON.stringify(obj, null, 2)}</code>
      </pre>
    );
  }

  return <pre className="tool__input">（无参数）</pre>;
}

export function ToolCard({ call }: { call: ToolCallView }): React.JSX.Element {
  const status = statusOf(call);

  return (
    <article className={`tool tool--${status.tone}`} aria-label={`工具调用 ${call.tool}`}>
      <header className="tool__head">
        <span className="tool__name">
          <code>{call.tool}</code>
        </span>
        {/* 文字标签与颜色并存，不只靠颜色传达状态 */}
        <span className={`tool__status tool__status--${status.tone}`} role="status">
          {status.label}
        </span>
        <span className="tool__duration">{formatDuration(call)}</span>
      </header>

      <details className="tool__section">
        <summary>输入</summary>
        <InputBody input={call.input} />
      </details>

      {call.output !== null && (
        <div className="tool__section tool__section--output">
          <RichOutput output={call.output} />
        </div>
      )}
    </article>
  );
}
