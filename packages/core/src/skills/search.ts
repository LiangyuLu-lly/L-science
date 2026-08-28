/**
 * 技能的本地语义检索（任务 12.2，需求 9.3、9.4、9.5、20.6.3）。
 *
 * 全部在本地构建与查询——技能清单描述的是用户的研究方法，把它送到外部检索
 * 服务去，等于把「这个人在研究什么」这件事泄漏出去，而这条恰恰是本地优先的
 * 核心承诺。
 *
 * 两层打分，**词法层永远可用，向量层可选叠加**：
 *
 * 1. 词法层：BM25，中文按字符二元组切分、英文按词切分。零依赖、确定、冷启动
 *    即可用。
 * 2. 向量层：Ollama 的嵌入模型（默认 `nomic-embed-text`）。可用时按余弦相似度
 *    与词法分融合。
 *
 * 为什么不只做向量层：它需要用户先 `ollama pull` 一个嵌入模型，而在那之前
 * `search_skills` 必须能用——一个「装好平台后要先做两步配置才能检索技能」的
 * 设计，会让绝大多数人从没体验过技能系统。
 *
 * 为什么不只做词法层：用户说「帮我看看这段脑电的睡眠结构」，而技能叫
 * `sleep-staging`、triggers 写的是「睡眠分期」——词法层靠「睡眠」这个二元组能
 * 命中，但换成「夜间多导睡眠监测的分段」就未必。向量层是对这种改写的兜底。
 */

import type { SkillManifest } from './manifest.js';

/* ------------------------------------------------------------------ *
 * 切分
 * ------------------------------------------------------------------ */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 切分为检索词元。
 *
 * 中文用字符二元组而不是分词器：一个中文分词器要么带词典（几 MB 且对领域词
 * 无能——「多导睡眠图」会被切成「多导」「睡眠」「图」），要么要模型。二元组
 * 在检索场景下的召回反而更稳，代价是索引条目多一些，而技能数量在几十的量级，
 * 这个代价可以忽略。
 *
 * 英文与数字按词切分并转小写，同时保留原词的前缀形式，让 `EEG` 能命中 `eeg`。
 */
export function tokenize(text: string): readonly string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();

  let latin = '';
  const flushLatin = (): void => {
    if (latin.length > 0) {
      tokens.push(latin);
      latin = '';
    }
  };

  let prevCjk = '';
  for (const ch of normalized) {
    if (CJK.test(ch)) {
      flushLatin();
      /*
       * 单字与二元组都进索引，但单字只是**召回兜底**，不足以单独构成命中。
       *
       * 全靠二元组会让「图」「峰」这类单字查询完全搜不到；而让单字与二元组等价
       * 则会让任意含常用字的查询都命中一堆东西——实测「量子色动力学」会命中睡眠
       * 分期技能，因为它的描述里有「自动分期」，共享了一个「动」字。精度门在
       * search() 里：查询含多字词元时，只匹配到单字的候选被丢掉。
       */
      tokens.push(ch);
      if (prevCjk !== '') tokens.push(prevCjk + ch);
      prevCjk = ch;
      continue;
    }
    prevCjk = '';

    if (/[a-z0-9]/.test(ch)) {
      latin += ch;
      continue;
    }
    // 连字符与下划线切开，让 sleep-staging 同时产出 sleep 与 staging
    flushLatin();
  }
  flushLatin();

  return tokens;
}

/* ------------------------------------------------------------------ *
 * BM25
 * ------------------------------------------------------------------ */

/** BM25 的两个常数取信息检索里的常规值。 */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * 各字段的权重。
 *
 * `triggers` 权重最高：它写的是「什么时候该用它」，与用户的话最同构。
 * `name` 与 `slug` 次之，`description` 再次之——描述往往写的是「它是什么」，
 * 与用户表达目的的方式差得远。
 */
const FIELD_WEIGHT = {
  triggers: 3.0,
  name: 2.0,
  slug: 1.5,
  domain: 1.0,
  description: 1.0,
} as const;

interface IndexedSkill {
  slug: string;
  /** 词元到加权词频。 */
  termFreq: ReadonlyMap<string, number>;
  /** 加权后的文档长度。 */
  length: number;
  manifest: SkillManifest;
}

export interface SkillSearchHit {
  slug: string;
  /** 融合后的最终得分，越大越相关。 */
  score: number;
  /** 词法层得分。 */
  lexicalScore: number;
  /** 向量层余弦相似度。向量层不可用时为 null。 */
  vectorScore: number | null;
  /** 命中了哪些查询词元。用于向用户解释「为什么检索到它」。 */
  matchedTerms: readonly string[];
  manifest: SkillManifest;
}

/** 一段文本的加权词频贡献。 */
function addField(target: Map<string, number>, text: string, weight: number): number {
  let added = 0;
  for (const token of tokenize(text)) {
    target.set(token, (target.get(token) ?? 0) + weight);
    added += weight;
  }
  return added;
}

/**
 * 技能检索索引。
 *
 * 每次技能目录变化就整体重建。增量更新在几十个文档的规模上没有价值，而它引入
 * 的「索引与实际不一致」这类状态非常难查——症状是某个技能怎么搜都搜不到。
 */
export class SkillSearchIndex {
  readonly #docs: IndexedSkill[] = [];
  readonly #docFreq = new Map<string, number>();
  #avgLength = 0;
  /** slug 到嵌入向量。为空表示向量层未构建。 */
  readonly #vectors = new Map<string, readonly number[]>();

  constructor(manifests: readonly SkillManifest[]) {
    for (const manifest of manifests) {
      const termFreq = new Map<string, number>();
      let length = 0;

      length += addField(termFreq, manifest.triggers.join(' '), FIELD_WEIGHT.triggers);
      length += addField(termFreq, manifest.name, FIELD_WEIGHT.name);
      // slug 里的连字符会被切开，因此 sleep-staging 能被 "sleep" 命中
      length += addField(termFreq, manifest.slug, FIELD_WEIGHT.slug);
      if (manifest.domain !== null) {
        length += addField(termFreq, manifest.domain, FIELD_WEIGHT.domain);
      }
      length += addField(termFreq, manifest.description, FIELD_WEIGHT.description);

      this.#docs.push({ slug: manifest.slug, termFreq, length, manifest });
      for (const term of termFreq.keys()) {
        this.#docFreq.set(term, (this.#docFreq.get(term) ?? 0) + 1);
      }
    }

    this.#avgLength =
      this.#docs.length === 0
        ? 0
        : this.#docs.reduce((n, d) => n + d.length, 0) / this.#docs.length;
  }

  get size(): number {
    return this.#docs.length;
  }

  get hasVectors(): boolean {
    return this.#vectors.size > 0;
  }

  /** 技能索引用的文本。嵌入层与词法层用同一份，避免两层看到的内容不同。 */
  static embeddingText(manifest: SkillManifest): string {
    return [manifest.name, manifest.domain ?? '', manifest.description, ...manifest.triggers]
      .filter((s) => s !== '')
      .join('\n');
  }

  /** 注入嵌入向量。缺失的技能只走词法层，不会因此被排除。 */
  setVectors(vectors: ReadonlyMap<string, readonly number[]>): void {
    this.#vectors.clear();
    for (const [slug, vector] of vectors) this.#vectors.set(slug, vector);
  }

  /** 词法层打分。返回 0 表示一个查询词元都没命中。 */
  #bm25(doc: IndexedSkill, queryTerms: readonly string[]): { score: number; matched: string[] } {
    let score = 0;
    const matched: string[] = [];
    const n = this.#docs.length;

    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term);
      if (tf === undefined) continue;
      matched.push(term);

      const df = this.#docFreq.get(term) ?? 0;
      // 加 0.5 平滑的 IDF。术语在全部技能里都出现时贡献接近 0，正是想要的：
      // 「分析」这种词无法区分任何技能
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const norm = this.#avgLength === 0 ? 1 : doc.length / this.#avgLength;
      score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * norm)));
    }

    return { score, matched };
  }

  /**
   * 检索。
   *
   * `queryVector` 可选：给了就叠加向量层。融合用**词法分归一化后加权求和**而不是
   * 取最大值——取最大值会让两层里较弱的那层完全不起作用，而它们各自擅长的
   * 查询类型不同（词法层擅长精确术语，向量层擅长改写）。
   */
  search(
    query: string,
    options: { limit?: number; queryVector?: readonly number[]; minScore?: number } = {},
  ): readonly SkillSearchHit[] {
    const limit = options.limit ?? 5;
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 && options.queryVector === undefined) return [];

    /*
     * 精度门：查询里存在多字词元时，只匹配到单字的候选不算命中。
     *
     * 单个中文字符的共现是巧合而不是证据。没有这道门，「量子色动力学」会因为
     * 一个「动」字命中睡眠分期技能——而模型拿到这个结果只能带着一份无关的长文档
     * 继续。查询本身全是单字时（用户只打了「图」）不设门，否则那种查询永远无结果。
     */
    const hasMultiCharQueryTerm = queryTerms.some((t) => t.length >= 2);

    const lexical = this.#docs.map((doc) => ({ doc, ...this.#bm25(doc, queryTerms) }));
    const maxLexical = Math.max(...lexical.map((l) => l.score), 0);

    const hits: SkillSearchHit[] = [];
    for (const entry of lexical) {
      if (
        hasMultiCharQueryTerm &&
        entry.matched.length > 0 &&
        !entry.matched.some((t) => t.length >= 2)
      ) {
        continue;
      }

      const normalizedLexical = maxLexical === 0 ? 0 : entry.score / maxLexical;

      let vectorScore: number | null = null;
      if (options.queryVector !== undefined) {
        const vector = this.#vectors.get(entry.doc.slug);
        if (vector !== undefined) vectorScore = cosineSimilarity(options.queryVector, vector);
      }

      /*
       * 融合权重。向量层不可用时词法分单独作为最终分。
       *
       * 0.6 / 0.4 偏向词法层：领域术语（EDF、PSG、HRV）的精确命中比语义近似更
       * 可靠，而嵌入模型对这些缩写的表示往往很弱——通用嵌入模型的训练语料里
       * 「PSG」更可能是游戏主机而不是多导睡眠图。
       */
      const score =
        vectorScore === null ? normalizedLexical : 0.6 * normalizedLexical + 0.4 * vectorScore;

      if (score <= 0) continue;
      hits.push({
        slug: entry.doc.slug,
        score,
        lexicalScore: entry.score,
        vectorScore,
        matchedTerms: entry.matched,
        manifest: entry.doc.manifest,
      });
    }

    const minScore = options.minScore ?? 0;
    return hits
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, limit);
  }
}

/** 余弦相似度。维度不一致时返回 0——那说明两个向量来自不同模型，比不了。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ------------------------------------------------------------------ *
 * 嵌入（可选层）
 * ------------------------------------------------------------------ */

export interface Embedder {
  /** 模型标识，用于判断缓存里的向量是否来自同一个模型。 */
  readonly id: string;
  /** 批量取嵌入。返回的顺序必须与输入一致。 */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface OllamaEmbedderOptions {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Ollama 嵌入。
 *
 * 走原生 `/api/embed`（支持批量）而不是 OpenAI 兼容的 `/v1/embeddings`：后者
 * 在 Ollama 上只接受单条输入，三十几个技能就是三十几次往返。
 */
export function createOllamaEmbedder(options: OllamaEmbedderOptions): Embedder {
  const model = options.model ?? 'nomic-embed-text';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const base = options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

  return {
    id: `ollama:${model}`,
    async embed(texts) {
      if (texts.length === 0) return [];

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${base}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: [...texts] }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `Ollama 嵌入失败 ${String(response.status)}：${body.slice(0, 200)}` +
              (response.status === 404 ? `。可能是没有拉取模型，执行：ollama pull ${model}` : ''),
          );
        }

        const parsed = (await response.json()) as { embeddings?: unknown };
        if (!Array.isArray(parsed.embeddings)) {
          throw new Error('Ollama 嵌入响应里没有 embeddings 数组');
        }
        const out = parsed.embeddings as number[][];
        if (out.length !== texts.length) {
          // 数量对不上时不能按顺序配对，那会把 A 的向量安到 B 头上
          throw new Error(
            `嵌入数量与输入不符（要 ${String(texts.length)} 个，得到 ${String(out.length)} 个）`,
          );
        }
        return out;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
