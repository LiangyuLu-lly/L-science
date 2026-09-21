/**
 * 顶栏：品牌、项目选择、新建项目、连接状态、隔离徽章。
 *
 * 新建项目必须始终可见。后端启动时已经种了「未命名项目」，所以这里只在用户
 * 点击时调用已有的 project.create，不在启动时再种一份。
 */

import type { Project } from '../lib/api.js';
import type { ConnectionState } from '../lib/useBackend.js';
import { IsolationBadge } from './IsolationBadge.js';

export type ProjectHeaderProps = {
  readonly projects: readonly Project[];
  readonly projectId: string | null;
  readonly onSelectProject: (id: string) => void;
  readonly onCreateProject: () => void;
  readonly connectionState: ConnectionState;
  readonly connectionLabel: string;
};

export function ProjectHeader(props: ProjectHeaderProps): React.JSX.Element {
  return (
    <header className="app__header">
      <span className="app__brand">L-science</span>
      <span className="app__tag">本地优先 AI 科研工作台</span>

      <div className="app__project">
        {props.projects.length > 0 && (
          <>
            <label className="app__project-label" htmlFor="project-select">
              项目
            </label>
            <select
              id="project-select"
              value={props.projectId ?? ''}
              onChange={(e) => props.onSelectProject(e.target.value)}
            >
              {props.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.archivedAt === null ? '' : '（已归档）'}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          className="btn btn--small"
          onClick={props.onCreateProject}
          disabled={props.connectionState !== 'ready'}
        >
          新建项目
        </button>
      </div>

      <div className="app__status">
        <span className={`badge badge--${props.connectionState}`} role="status">
          {props.connectionLabel}
        </span>
        <IsolationBadge />
      </div>
    </header>
  );
}
