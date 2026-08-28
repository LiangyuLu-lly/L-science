---
slug: reference-dedupe
name: 参考文献去重
version: 1.0.0
---

# 参考文献去重

## 为什么难

多库检索的结果里同一篇文献会以多种面貌出现：

- **DOI 大小写不同**：DOI 规范上大小写不敏感，但字符串比较敏感。
- **前缀不同**：`10.1234/x`、`https://doi.org/10.1234/x`、`doi:10.1234/x`。
- **期刊名缩写 vs 全称**：`J Sleep Res` / `Journal of Sleep Research`。
- **预印本与正式版**：不同 DOI、标题可能有微调，是**两条记录一个研究**。
- **在线优先与正式出版**：年份差一年。
- **勘误、撤稿声明**：标题带 `Correction to:` / `Retraction:` 前缀，DOI 不同。
- **会议摘要与全文**：同一研究的两次发表，通常应保留全文并注明。

## 三级去重

**顺序不能反**：先做确定性的，再做启发式的。反过来会让模糊匹配把两篇真正不同的文献
合并掉，而这个错误之后无法发现。

### 一级：DOI 精确匹配（确定）

```python
import re

def normalize_doi(raw: str | None) -> str | None:
    if not raw:
        return None
    s = raw.strip().lower()
    s = re.sub(r'^(https?://)?(dx\.)?doi\.org/', '', s)
    s = re.sub(r'^doi:\s*', '', s)
    return s if s.startswith('10.') else None
```

DOI 相同即同一文献，无需再判。**这一级能解决多库检索里绝大部分重复。**

### 二级：PMID / arXiv id 精确匹配（确定）

有些旧文献没有 DOI 但有 PMID。同理归一化后精确比较。

### 三级：标题 + 首作者 + 年份 模糊匹配（启发式）

```python
def normalize_title(t: str) -> str:
    t = t.lower()
    t = re.sub(r'^(correction to:|retraction:|erratum:)\s*', '', t)
    t = re.sub(r'[^a-z0-9\u4e00-\u9fff ]+', ' ', t)   # 去标点，保留中文
    return ' '.join(t.split())

from difflib import SequenceMatcher
def title_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_title(a), normalize_title(b)).ratio()
```

判为重复的条件（三条都要满足）：

1. 标题相似度 ≥ **0.92**；
2. 第一作者姓一致（归一化后）；
3. 年份差 ≤ 1。

**阈值取 0.92 而不是 0.85**：0.85 会把「Effects of X on sleep in adults」与
「Effects of X on sleep in adolescents」判成同一篇——它们的标题相似度约 0.88，
而这是两个不同人群的研究。宁可漏合并（人工再看）也不要误合并。

## 需要人工确认的情形

自动化到这里就该停下，把下列情形列出来让人决定：

- 标题相似度在 **0.85-0.92** 之间的对（灰区）。
- 一方有 DOI 一方没有，且标题高度相似（可能是预印本 vs 正式版）。
- 标题带 `Correction`/`Retraction` 前缀且能匹配到原文（**保留两条**：撤稿声明本身
  是必须知道的信息，合并掉等于把撤稿隐藏了）。
- 同一作者同一年的多篇相近标题（系列研究，常常真的是不同文献）。

## 保留哪一条

合并时选**元数据最完整**的那条作为主记录，而不是先出现的那条：

```python
def completeness(rec) -> int:
    return sum(1 for k in ('doi', 'journal', 'volume', 'pages', 'abstract', 'authors')
               if rec.get(k))
```

同时保留**全部来源标记**（这条记录在哪几个库里出现过）——PRISMA 流程图需要「各库命中数」
与「去重后数量」，来源信息丢了就填不出来。

## PRISMA 计数

系统综述必须报告这四个数，去重代码要能直接产出：

```python
counts = {
    'records_identified': {'PubMed': 412, 'Embase': 508, 'WoS': 331},
    'duplicates_removed': 389,
    'records_screened': 862,
    'manual_review_needed': 17,        # 灰区对数，要如实报告
}
```

## 输出

去重结果、合并映射表（哪些 id 合并到了哪个主记录）、灰区待人工确认列表，一起存成制品。
**合并映射表是可逆性的保证**——发现某次合并错了，靠它能还原。
