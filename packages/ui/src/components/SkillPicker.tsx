/**
 * 输入框里的技能选择器（任务 12.16，需求 9.5）。
 *
 * 在输入框里打 `/` 弹出候选，选中的技能会被**直接注入**本回合的历史，而不是
 * 变成一句「请使用某技能」交给模型自己判断。
 *
 * ## 为什么必须是注入而不是提示
 *
 * 「显式插入」这四个字的全部意义在于**保证生效**。如果只是在文本里加一句提示，
 * 模型可能判断用不上而跳过，于是用户点了技能却什么也没发生——而界面上看不出区别。
 * 那比没有这个功能更糟：用户会以为方法已经生效，并据此判断结果对不对。
 *
 * ## 为什么用「已选标签」而不是把 slug 写进文本
 *
 * 写进文本的做法（`/sleep-staging 帮我分期`）看起来更简单，但它把两件事混在一起：
 * 用户的话与对系统的指令。后果是用户删字时可能删掉半个 slug，而那时既不报错也不生效。
 * 分开之后，选中的技能是一组可见的标签，删除是显式动作。
 *
 * ## 键盘可达
 *
 * `/` 只在行首或空白之后触发——句子中间的斜杠是路径与日期，不是命令。上下键选，
 * Enter 确认，Esc 关闭且**把焦点还给输入框**。不还焦点的话键盘用户会掉出输入区。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { searchSkills, type SkillSearchHitView } from '../lib/api.js';
import { BackendError } from '../lib/backend.js';

export interface SkillPickerProps {
  /** 当前查询（`/` 之后的部分）。为 null 表示不显示。 */
  query: string | null;
  /** 已选中的 slug，用于在候选里标记。 */
  selected: readonly string[];
  onPick: (hit: SkillSearchHitView) => void;
  onClose: () => void;
}

function errorText(err: unknown): string {
  if (err instanceof BackendError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function SkillPicker({
  query,
  selected,
  onPick,
  onClose,
}: SkillPickerProps): React.JSX.Element | null {
  const [hits, setHits] = useState<SkillSearchHitView[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [vectorsReady, setVectorsReady] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);

  /*
   * 检索有防抖。
   *
   * 不防抖的话每敲一个字符就发一次请求，而向量层那一路要向本机推理服务发一次
   * 嵌入调用——连打五个字符就是五次，后到的响应还可能覆盖先到的。
   */
  useEffect(() => {
    if (query === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      void searchSkills(query.trim() === '' ? '常用' : query, 8)
        .then((result) => {
          if (cancelled) return;
          setHits(result.hits);
          setVectorsReady(result.vectorsReady);
          setCursor(0);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(errorText(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const move = useCallback(
    (delta: number) => {
      setCursor((c) => {
        if (hits.length === 0) return 0;
        return (c + delta + hits.length) % hits.length;
      });
    },
    [hits.length],
  );

  /*
   * 键盘处理挂在 window 上而不是列表上。
   *
   * 焦点始终在输入框里（用户还在打字），所以列表本身收不到 keydown。挂在 window
   * 上并在 capture 阶段拦下方向键与 Enter，是唯一能同时保住「继续打字」与
   * 「用方向键选」的做法。
   */
  useEffect(() => {
    if (query === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const hit = hits[cursor];
        if (hit !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          onPick(hit);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [query, hits, cursor, move, onPick, onClose]);

  // 键盘移动时把当前项滚进视野，否则长列表下方向键像是没反应
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    list.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (query === null) return null;

  return (
    <div className="skillpicker" role="dialog" aria-label="插入技能">
      <div className="skillpicker__head">
        <span className="skillpicker__hint">插入技能{query.trim() === '' ? '' : `：${query}`}</span>
        {/* 向量层没就绪时要说出来：检索质量的差别用户感知得到，而原因不该靠猜 */}
        {!vectorsReady && (
          <span className="skillpicker__degraded" title="嵌入向量还没建好，当前只用词法检索">
            词法检索
          </span>
        )}
        {loading && <span className="skillpicker__loading">检索中…</span>}
      </div>

      {error !== null && <p className="skillpicker__error">{error}</p>}

      {error === null && hits.length === 0 && !loading && (
        <p className="skillpicker__empty">
          没有匹配的技能。换个说法，或者按 Esc 关闭继续正常输入。
        </p>
      )}

      <ul className="skillpicker__list" ref={listRef}>
        {hits.map((hit, index) => {
          const already = selected.includes(hit.slug);
          return (
            <li key={hit.slug}>
              <button
                type="button"
                className={`skillpicker__item ${index === cursor ? 'is-current' : ''} ${already ? 'is-selected' : ''}`}
                data-current={index === cursor ? 'true' : 'false'}
                aria-current={index === cursor ? 'true' : undefined}
                // 鼠标移入即改游标，键盘与鼠标不会各有一套「当前项」
                onMouseEnter={() => setCursor(index)}
                onClick={() => onPick(hit)}
              >
                <span className="skillpicker__name">
                  {hit.name}
                  <code className="skillpicker__slug">{hit.slug}</code>
                  {hit.scope === 'user' && (
                    <span className="skillpicker__badge" title="用户自建，覆盖同名内置技能">
                      自建
                    </span>
                  )}
                  {already && <span className="skillpicker__badge">已选</span>}
                </span>
                <span className="skillpicker__desc">{hit.description}</span>
                {/*
                  依赖缺失不隐藏也不过滤：用户需要知道「这个方法存在但环境没装好」。
                  过滤掉的话他会以为平台没有这个能力。
                */}
                {!hit.requirementsSatisfied && hit.missingSummary !== null && (
                  <span className="skillpicker__missing">⚠ 依赖未满足：{hit.missingSummary}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="skillpicker__foot">↑↓ 选择，Enter 插入，Esc 取消</p>
    </div>
  );
}

/**
 * 已选技能的标签条。
 *
 * 与选择器分开是因为它在选择器关闭之后仍然要显示——用户必须能看到这条消息会带上
 * 哪些技能，否则「显式」就只在点下的那一瞬间成立。
 */
export function SelectedSkills({
  slugs,
  names,
  onRemove,
}: {
  slugs: readonly string[];
  /** slug → 显示名。取不到时退回显示 slug。 */
  names: ReadonlyMap<string, string>;
  onRemove: (slug: string) => void;
}): React.JSX.Element | null {
  if (slugs.length === 0) return null;

  return (
    <div className="selskills" aria-label="本条消息使用的技能">
      <span className="selskills__label">使用技能</span>
      {slugs.map((slug) => (
        <span key={slug} className="selskills__chip">
          {names.get(slug) ?? slug}
          <button
            type="button"
            className="selskills__remove"
            aria-label={`移除技能 ${names.get(slug) ?? slug}`}
            onClick={() => onRemove(slug)}
          >
            ×
          </button>
        </span>
      ))}
      {/* 上限来自 ipc 的 max(5)：技能文档动辄几千字符，塞太多会把上下文吃光 */}
      {slugs.length >= 5 && <span className="selskills__limit">已达上限 5 个</span>}
    </div>
  );
}
