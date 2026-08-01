/**
 * 存储门面：应用库 + 按需打开的项目库。
 *
 * 两级结构的直接后果是「创建/删除项目」跨越了数据库与文件系统，无法放进单个
 * 事务。因此顺序是刻意选的：
 *
 * - 创建：先建目录与项目库，最后写注册表行。中途失败只会留下一个没被注册的
 *   孤儿目录（可被清理任务发现），而不是列表里出现一个打不开的项目。
 * - 删除：先删注册表行，再删目录。中途失败同样只留孤儿目录。
 *
 * 两个方向都把「注册表指向不存在的项目」这个更糟的状态排除掉了。
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { openDatabase, migrate, type Db } from './db.js';
import { APP_MIGRATIONS } from './migrations/app.js';
import { PROJECT_MIGRATIONS } from './migrations/project.js';
import { appPaths, projectPaths, type AppPaths, type ProjectPaths } from './paths.js';
import { ProjectRepo, type CreateProjectInput, type Project } from './repo/projects.js';
import { ConversationRepo, MessageRepo, ToolCallRepo } from './repo/conversations.js';

export class ProjectStore {
  readonly projectId: string;
  readonly paths: ProjectPaths;
  readonly db: Db;
  readonly conversations: ConversationRepo;
  readonly messages: MessageRepo;
  readonly toolCalls: ToolCallRepo;

  #closed = false;

  constructor(projectId: string, paths: ProjectPaths, db: Db) {
    this.projectId = projectId;
    this.paths = paths;
    this.db = db;
    this.conversations = new ConversationRepo(db);
    this.messages = new MessageRepo(db);
    this.toolCalls = new ToolCallRepo(db);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 库自称的项目 id。与目录名不一致说明库被复制或错放了。 */
  declaredProjectId(): string | null {
    const row = this.db.prepare('SELECT project_id FROM project_meta WHERE singleton = 1').get() as
      { project_id: string } | undefined;
    return row === undefined ? null : row.project_id;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }
}

export class AppStore {
  readonly paths: AppPaths;
  readonly db: Db;
  readonly projects: ProjectRepo;

  readonly #open = new Map<string, ProjectStore>();
  #closed = false;

  private constructor(paths: AppPaths, db: Db) {
    this.paths = paths;
    this.db = db;
    this.projects = new ProjectRepo(db);
  }

  /** 打开（必要时创建）应用库并应用迁移。 */
  static open(root?: string): AppStore {
    const paths = root === undefined ? appPaths() : appPaths(root);
    for (const dir of [
      paths.config,
      paths.credentials,
      paths.projects,
      paths.runtimeKernels,
      paths.runtimeEnvs,
      paths.skillsBuiltin,
      paths.skillsUser,
      paths.logs,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    const db = openDatabase(paths.appDb);
    migrate(db, APP_MIGRATIONS);
    return new AppStore(paths, db);
  }

  /**
   * 打开项目库。句柄按项目 id 缓存——每次打开都新建连接会让 WAL 下的读写
   * 并发行为难以预测，也容易在 Windows 上留下文件锁。
   */
  openProject(projectId: string): ProjectStore {
    this.#assertOpen();

    const cached = this.#open.get(projectId);
    if (cached !== undefined && !cached.closed) return cached;

    const paths = projectPaths(projectId, this.paths.root);
    if (!existsSync(paths.db)) {
      throw new Error(`项目库不存在：${projectId}`);
    }

    const db = openDatabase(paths.db);
    migrate(db, PROJECT_MIGRATIONS);
    const store = new ProjectStore(projectId, paths, db);
    this.#open.set(projectId, store);
    return store;
  }

  /**
   * 创建项目：先落地目录与项目库，最后写注册表行。
   * 见文件头对顺序的说明。
   */
  createProject(input: CreateProjectInput): Project {
    this.#assertOpen();

    const id = input.id ?? randomUUID();
    const paths = projectPaths(id, this.paths.root);
    if (existsSync(paths.db)) {
      throw new Error(`项目目录已存在：${id}`);
    }

    mkdirSync(paths.blobs, { recursive: true });
    mkdirSync(paths.workspace, { recursive: true });
    mkdirSync(paths.logs, { recursive: true });

    const db = openDatabase(paths.db);
    migrate(db, PROJECT_MIGRATIONS);
    db.prepare('INSERT INTO project_meta (singleton, project_id, created_at) VALUES (1, ?, ?)').run(
      id,
      Date.now(),
    );

    const store = new ProjectStore(id, paths, db);
    this.#open.set(id, store);

    try {
      return this.projects.create({ ...input, id });
    } catch (err) {
      // 注册表写失败就把刚建的库收掉，不留半个项目。
      store.close();
      this.#open.delete(id);
      rmSync(paths.root, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * 删除项目：注册表行 -> 关闭句柄 -> 删目录。
   *
   * 必须先关句柄再删目录：Windows 上打开的 SQLite 文件被锁住，
   * 直接删会失败并留下一个残缺目录。
   */
  deleteProject(id: string): { removedRow: boolean; removedDir: boolean } {
    this.#assertOpen();

    const paths = projectPaths(id, this.paths.root);
    const removedRow = this.projects.deleteRow(id);

    const store = this.#open.get(id);
    if (store !== undefined) {
      store.close();
      this.#open.delete(id);
    }

    let removedDir = false;
    if (existsSync(paths.root)) {
      rmSync(paths.root, { recursive: true, force: true });
      removedDir = !existsSync(paths.root);
    }

    return { removedRow, removedDir };
  }

  /** 注册表里有、但目录已不存在的项目 id。用于启动时的一致性检查。 */
  danglingProjects(): string[] {
    return this.projects
      .list({ includeArchived: true })
      .filter((p) => !existsSync(projectPaths(p.id, this.paths.root).db))
      .map((p) => p.id);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const store of this.#open.values()) store.close();
    this.#open.clear();
    this.db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('AppStore 已关闭');
  }
}
