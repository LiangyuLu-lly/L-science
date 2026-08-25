/**
 * 富输出渲染（任务 9.2，需求 3.6、3.8）。
 *
 * 内核输出是不可信内容，HTML 与 SVG 都经 DOMPurify 消毒后才渲染。
 * 见 `lib/sanitize.ts` 对为什么不自己写过滤的说明。
 */

import { useMemo } from 'react';

import { pickRenderable } from '../lib/sanitize.js';
import type { ToolOutput } from '../lib/api.js';

/** 结构化异常。traceback 折叠，因为它常常很长而关键信息在头两行。 */
function ErrorOutput({
  ename,
  evalue,
  traceback,
}: {
  ename: string;
  evalue: string;
  traceback: readonly string[];
}): React.JSX.Element {
  return (
    <div className="output output--error">
      <p className="output__error-head">
        <span className="output__ename">{ename}</span>
        <span className="output__evalue">{evalue}</span>
      </p>
      {traceback.length > 0 && (
        <details className="output__traceback">
          <summary>调用栈（{traceback.length} 行）</summary>
          <pre>
            <code>{traceback.join('\n')}</code>
          </pre>
        </details>
      )}
    </div>
  );
}

function HtmlOutput({ html, modified }: { html: string; modified: boolean }): React.JSX.Element {
  return (
    <div className="output output--html">
      {modified && (
        // 必须告知用户内容被改动过。不说的话，一个被剥掉了关键单元格的表格
        // 看起来就是「数据本来如此」
        <p className="output__notice" role="note">
          部分内容因安全策略被移除（内核输出属于不可信内容，仅允许基本排版标签）。
        </p>
      )}
      {/* eslint-disable-next-line react/no-danger -- 已经过 DOMPurify 消毒，见 sanitize.ts */}
      <div className="output__html-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function RichOutput({ output }: { output: ToolOutput }): React.JSX.Element {
  const renderable = useMemo(
    () => (output.kind === 'rich' ? pickRenderable(output.data) : null),
    [output],
  );

  if (output.kind === 'error') {
    return <ErrorOutput ename={output.ename} evalue={output.evalue} traceback={output.traceback} />;
  }

  if (output.kind === 'text') {
    return (
      <pre className="output output--text">
        <code>{output.text}</code>
      </pre>
    );
  }

  if (renderable === null) return <p className="output__notice">（无输出）</p>;

  switch (renderable.kind) {
    case 'image':
      return (
        <figure className="output output--image">
          <img
            src={`data:${renderable.mime};base64,${renderable.base64}`}
            alt="内核生成的图像"
            loading="lazy"
          />
        </figure>
      );
    case 'html':
      return <HtmlOutput html={renderable.html} modified={renderable.modified} />;
    case 'text':
      return (
        <pre className="output output--text">
          <code>{renderable.text}</code>
        </pre>
      );
    case 'unknown':
      return <p className="output__notice">无法渲染的输出类型：{renderable.mimes.join('、')}</p>;
  }
}
