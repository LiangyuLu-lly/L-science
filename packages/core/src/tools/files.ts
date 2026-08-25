/**
 * `read_file` 与 `edit_file`（任务 6.4，需求 6.8、6.9、5.4）。
 *
 * 两个刻意的限制，都是为了防止一类具体的静默损坏：
 *
 * 1. **二进制拒读**。把 .npy 或 .edf 当文本读进来，得到的是一串替换字符，
 *    模型会基于这串垃圾推理。明确拒绝并提示改用代码工具，比给它一堆
 *    U+FFFD 有用得多。
 * 2. **精确替换必须唯一命中**。命中零次说明模型记错了原文，命中多次说明它
 *    的定位不够具体——两种情况下继续替换都会改错地方。而改错地方在手稿
 *    编辑里是最难发现的错误：文件还在、语法还对，只是内容悄悄变了。
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';

import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

/** 单次读取的字符上限。超过则要求分段读。 */
const MAX_READ_CHARS = 200_000;

/** 判定二进制的采样字节数。 */
const BINARY_SNIFF_BYTES = 8000;

/**
 * 判断内容是否为二进制。
 *
 * 依据是 NUL 字节与不可打印字符比例，而不是扩展名：扩展名会骗人（.dat 可能是
 * 文本，.txt 可能是别人误命名的二进制），而内容不会。
 */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(BINARY_SNIFF_BYTES, buffer.length));
  if (sample.length === 0) return false;

  // NUL 字节几乎不出现在文本里，出现即可判定
  if (sample.includes(0)) return true;

  let suspicious = 0;
  for (const byte of sample) {
    // 制表、换行、回车之外的 C0 控制字符，以及 DEL
    const isControl =
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f;
    if (isControl) suspicious += 1;
  }

  // 阈值取 5%：UTF-8 文本里这类字节应当极少。取得更松会把
  // 含少量控制字符的日志误判为二进制
  return suspicious / sample.length > 0.05;
}

/** 是否是 PDF。按魔数判断而不是扩展名。 */
export function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export interface ReadFileInput {
  /** 文件路径，相对会话工作目录。与 versionId 二选一。 */
  path?: string;
  /** 制品版本 id。与 path 二选一。 */
  versionId?: string;
  /** 起始行（1 起）。 */
  startLine?: number;
  endLine?: number;
  /** PDF 的页码（1 起）。仅对 PDF 有效。 */
  page?: number;
}

/** 按行截取。行号从 1 开始，与编辑器一致。 */
export function sliceLines(
  text: string,
  startLine?: number,
  endLine?: number,
): { text: string; note: string } {
  if (startLine === undefined && endLine === undefined) {
    if (text.length <= MAX_READ_CHARS) return { text, note: '' };
    // 超长文件不静默截断，而是明确告知需要分段读
    const lines = text.split('\n');
    return {
      text: text.slice(0, MAX_READ_CHARS),
      note:
        `\n\n[文件共 ${String(lines.length)} 行 ${String(text.length)} 字符，超过单次读取上限 ` +
        `${String(MAX_READ_CHARS)}。已返回开头部分，请用 startLine/endLine 分段读取剩余内容。]`,
    };
  }

  const lines = text.split('\n');
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? lines.length);

  if (from > lines.length) {
    return { text: '', note: `[起始行 ${String(from)} 超出文件行数 ${String(lines.length)}]` };
  }

  const selected = lines.slice(from - 1, to);
  // 带上行号：模型后续要用 edit_file 精确替换，没有行号它无法确认自己看的是哪段
  const numbered = selected.map((line, i) => `${String(from + i).padStart(6)}\t${line}`).join('\n');

  return {
    text: numbered,
    note: `\n\n[已读取第 ${String(from)}-${String(to)} 行，共 ${String(lines.length)} 行]`,
  };
}

export interface ReadFileToolOptions {
  /** 解析路径并做边界检查。通常接 PathGuard。 */
  resolvePath: (raw: string, ctx: ToolContext) => string;
  /** 按 version_id 取制品文件的真实路径。组 7 落地后接上。 */
  resolveVersion?: (versionId: string) => string | null;
  /** PDF 按页抽取文本。缺失时 PDF 会被拒读并说明原因。 */
  extractPdfPage?: (path: string, page: number) => Promise<{ text: string; pageCount: number }>;
}

export function createReadFileTool(options: ReadFileToolOptions): ToolDefinition<ReadFileInput> {
  return {
    name: 'read_file',
    description:
      '读取文本文件的内容，返回带行号的文本。可以用 startLine/endLine 分段读取大文件。' +
      'PDF 需要指定 page 按页读取。二进制文件会被拒绝——请改用 python 工具读取它们。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对会话工作目录' },
        versionId: { type: 'string', description: '制品版本 id，与 path 二选一' },
        startLine: { type: 'number', description: '起始行号，从 1 开始' },
        endLine: { type: 'number', description: '结束行号，包含该行' },
        page: { type: 'number', description: 'PDF 页码，从 1 开始' },
      },
      additionalProperties: false,
    },

    parseInput(raw): ReadFileInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      const hasPath = typeof obj.path === 'string' && obj.path !== '';
      const hasVersion = typeof obj.versionId === 'string' && obj.versionId !== '';
      if (!hasPath && !hasVersion) throw new Error('必须提供 path 或 versionId 之一');
      if (hasPath && hasVersion) {
        // 同时给两个说明模型不确定该用哪个，此时猜一个会掩盖它的困惑
        throw new Error('path 与 versionId 只能提供一个');
      }

      for (const key of ['startLine', 'endLine', 'page'] as const) {
        const value = obj[key];
        if (
          value !== undefined &&
          (typeof value !== 'number' || value < 1 || !Number.isInteger(value))
        ) {
          throw new Error(`${key} 必须是不小于 1 的整数`);
        }
      }
      if (
        typeof obj.startLine === 'number' &&
        typeof obj.endLine === 'number' &&
        obj.endLine < obj.startLine
      ) {
        throw new Error('endLine 不能小于 startLine');
      }

      return {
        ...(hasPath ? { path: obj.path as string } : {}),
        ...(hasVersion ? { versionId: obj.versionId as string } : {}),
        ...(typeof obj.startLine === 'number' ? { startLine: obj.startLine } : {}),
        ...(typeof obj.endLine === 'number' ? { endLine: obj.endLine } : {}),
        ...(typeof obj.page === 'number' ? { page: obj.page } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      let resolved: string;
      if (input.versionId !== undefined) {
        const path = options.resolveVersion?.(input.versionId) ?? null;
        if (path === null) {
          return {
            ok: false,
            output: {
              kind: 'error',
              ename: 'VersionNotFound',
              evalue: `找不到制品版本 ${input.versionId}`,
              traceback: [],
            },
          };
        }
        resolved = path;
      } else {
        try {
          resolved = options.resolvePath(input.path ?? '', ctx);
        } catch (err) {
          return {
            ok: false,
            output: {
              kind: 'error',
              ename: 'PathDenied',
              evalue: err instanceof Error ? err.message : String(err),
              traceback: [],
            },
          };
        }
      }

      let buffer: Buffer;
      try {
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          return {
            ok: false,
            output: {
              kind: 'error',
              ename: 'IsADirectory',
              evalue: `${resolved} 是目录而不是文件。`,
              traceback: [],
            },
          };
        }
        buffer = readFileSync(resolved);
      } catch (err) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'ReadFailed',
            evalue: err instanceof Error ? err.message : String(err),
            traceback: [],
          },
        };
      }

      if (isPdf(buffer)) return readPdf(resolved, input.page, options);

      if (looksBinary(buffer)) {
        // 明确拒绝并给出替代方案，比返回一串 U+FFFD 有用得多
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'BinaryFile',
            evalue:
              `${resolved} 看起来是二进制文件，不能按文本读取。` +
              '请改用 python 工具读取它——例如 numpy.load、pandas.read_parquet 或 mne.io.read_raw_edf，' +
              '取决于它的实际格式。',
            traceback: [],
          },
        };
      }

      const { text, note } = sliceLines(buffer.toString('utf8'), input.startLine, input.endLine);
      return { ok: true, output: { kind: 'text', text: text + note } };
    },
  };
}

async function readPdf(
  path: string,
  page: number | undefined,
  options: ReadFileToolOptions,
): Promise<ToolResult> {
  if (options.extractPdfPage === undefined) {
    return {
      ok: false,
      output: {
        kind: 'error',
        ename: 'PdfSupportMissing',
        evalue: 'PDF 文本抽取尚未接入。请改用 python 工具读取——例如 pypdf 或 pdfplumber。',
        traceback: [],
      },
    };
  }

  if (page === undefined) {
    // 不默认读第一页：论文的关键内容极少在第一页，默认读它会让模型
    // 以为自己看过全文了
    return {
      ok: false,
      output: {
        kind: 'error',
        ename: 'PageRequired',
        evalue: 'PDF 必须指定 page 参数按页读取。先读第 1 页可以拿到总页数。',
        traceback: [],
      },
    };
  }

  try {
    const { text, pageCount } = await options.extractPdfPage(path, page);
    if (page > pageCount) {
      return {
        ok: false,
        output: {
          kind: 'error',
          ename: 'PageOutOfRange',
          evalue: `第 ${String(page)} 页超出范围，该 PDF 共 ${String(pageCount)} 页。`,
          traceback: [],
        },
      };
    }
    return {
      ok: true,
      output: {
        kind: 'text',
        text: `${text}\n\n[第 ${String(page)} 页 / 共 ${String(pageCount)} 页]`,
      },
    };
  } catch (err) {
    return {
      ok: false,
      output: {
        kind: 'error',
        ename: 'PdfExtractFailed',
        evalue: err instanceof Error ? err.message : String(err),
        traceback: [],
      },
    };
  }
}

/* ------------------------------------------------------------------ *
 * edit_file
 * ------------------------------------------------------------------ */

export type EditMode = 'replace' | 'write';

export interface EditFileInput {
  path: string;
  mode: EditMode;
  /** replace 模式：要被替换的原文，必须唯一命中。 */
  oldText?: string;
  /** replace 模式的新内容；write 模式的全文。 */
  newText: string;
}

/** 替换结果。命中数是关键信息，因此单独返回而不是只给成功失败。 */
export interface ReplaceOutcome {
  matches: number;
  result: string;
}

/**
 * 执行精确替换。
 *
 * 不用正则也不做任何归一化：模型给的 oldText 就是它认为文件里的原文，任何
 * 「智能匹配」都会让它在自己没意识到的情况下改动别的地方。宁可报「没命中」
 * 让它重新读文件。
 */
export function replaceOnce(content: string, oldText: string): ReplaceOutcome {
  if (oldText === '') return { matches: 0, result: content };

  let matches = 0;
  let index = content.indexOf(oldText);
  while (index !== -1) {
    matches += 1;
    if (matches > 1) break; // 超过一处即可判定失败，不必数完
    index = content.indexOf(oldText, index + oldText.length);
  }

  return { matches, result: content };
}

export interface EditFileToolOptions {
  resolvePath: (raw: string, ctx: ToolContext) => string;
}

export function createEditFileTool(options: EditFileToolOptions): ToolDefinition<EditFileInput> {
  return {
    name: 'edit_file',
    description:
      '修改文件。mode="replace" 做精确文本替换，oldText 必须在文件中唯一出现——' +
      '命中零次或多次都会失败而不做任何修改。mode="write" 用 newText 覆盖整个文件。' +
      '替换比全文覆盖安全得多，改局部内容时优先用它。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对会话工作目录' },
        mode: { type: 'string', enum: ['replace', 'write'], description: '编辑模式' },
        oldText: {
          type: 'string',
          description:
            'replace 模式必填。必须与文件中的原文逐字符一致，包括缩进与换行。' +
            '如果它在文件里出现多次，请带上更多上下文使其唯一。',
        },
        newText: { type: 'string', description: 'replace 模式的替换内容；write 模式的完整新内容' },
      },
      required: ['path', 'mode', 'newText'],
      additionalProperties: false,
    },

    parseInput(raw): EditFileInput {
      if (typeof raw !== 'object' || raw === null) throw new Error('入参必须是对象');
      const obj = raw as Record<string, unknown>;

      if (typeof obj.path !== 'string' || obj.path === '') throw new Error('path 必须是非空字符串');
      if (obj.mode !== 'replace' && obj.mode !== 'write') {
        throw new Error('mode 必须是 replace 或 write');
      }
      if (typeof obj.newText !== 'string') throw new Error('newText 必须是字符串');

      if (obj.mode === 'replace') {
        if (typeof obj.oldText !== 'string' || obj.oldText === '') {
          throw new Error('replace 模式必须提供非空的 oldText');
        }
        if (obj.oldText === obj.newText) {
          // 这通常是模型的疏漏。静默成功会让它以为改动生效了
          throw new Error('oldText 与 newText 相同，这次编辑不会产生任何变化');
        }
      }

      return {
        path: obj.path,
        mode: obj.mode,
        newText: obj.newText,
        ...(typeof obj.oldText === 'string' ? { oldText: obj.oldText } : {}),
      };
    },

    async execute(input, ctx): Promise<ToolResult> {
      let resolved: string;
      try {
        resolved = options.resolvePath(input.path, ctx);
      } catch (err) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'PathDenied',
            evalue: err instanceof Error ? err.message : String(err),
            traceback: [],
          },
        };
      }

      if (input.mode === 'write') {
        try {
          writeFileSync(resolved, input.newText, 'utf8');
          const lines = input.newText.split('\n').length;
          return {
            ok: true,
            output: {
              kind: 'text',
              text: `已写入 ${resolved}（${String(lines)} 行，${String(input.newText.length)} 字符）。`,
            },
          };
        } catch (err) {
          return {
            ok: false,
            output: {
              kind: 'error',
              ename: 'WriteFailed',
              evalue: err instanceof Error ? err.message : String(err),
              traceback: [],
            },
          };
        }
      }

      let content: string;
      try {
        const buffer = readFileSync(resolved);
        if (looksBinary(buffer)) {
          return {
            ok: false,
            output: {
              kind: 'error',
              ename: 'BinaryFile',
              evalue: `${resolved} 是二进制文件，不能做文本替换。`,
              traceback: [],
            },
          };
        }
        content = buffer.toString('utf8');
      } catch (err) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'ReadFailed',
            evalue: err instanceof Error ? err.message : String(err),
            traceback: [],
          },
        };
      }

      const oldText = input.oldText ?? '';
      const { matches } = replaceOnce(content, oldText);

      if (matches === 0) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'NoMatch',
            evalue:
              `oldText 在 ${resolved} 中没有找到。文件内容可能与你记忆中的不同——` +
              '请先用 read_file 重新读取相关部分，确认原文后再编辑。' +
              '注意缩进、行尾与全角半角必须逐字符一致。',
            traceback: [],
          },
        };
      }

      if (matches > 1) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'AmbiguousMatch',
            evalue:
              `oldText 在 ${resolved} 中出现了多次，无法确定该改哪一处，因此没有做任何修改。` +
              '请在 oldText 里带上更多上下文（前后各多几行）使其唯一。',
            traceback: [],
          },
        };
      }

      try {
        // 用 split/join 而不是 String.replace：后者会把 newText 里的 $& 之类
        // 当成替换模式展开，而模型写的手稿内容里完全可能出现 $
        const updated = content.split(oldText).join(input.newText);
        writeFileSync(resolved, updated, 'utf8');
        return {
          ok: true,
          output: { kind: 'text', text: `已替换 ${resolved} 中的 1 处内容。` },
        };
      } catch (err) {
        return {
          ok: false,
          output: {
            kind: 'error',
            ename: 'WriteFailed',
            evalue: err instanceof Error ? err.message : String(err),
            traceback: [],
          },
        };
      }
    },
  };
}
