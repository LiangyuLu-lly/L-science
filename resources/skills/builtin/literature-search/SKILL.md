---
slug: literature-search
name: 文献检索
version: 1.0.0
---

# 文献检索

## 原则：检索式是研究材料

检索式与检索日期必须能写进论文并被别人原样重跑。**「我搜了一下发现……」不是可复现的
方法**，而这一条在非系统综述的论文里同样适用——引言里的「已有研究普遍认为」如果建立在
一次随手检索上，遗漏了反例的风险很高。

## 概念分解

先把问题拆成 2-4 个概念块，块内用 OR，块间用 AND：

```
(睡眠概念) AND (干预概念) AND (结局概念)
```

每个块内要同时包含**受控词**（MeSH）与**自由词**（标题摘要），因为：
新发表的文献还没被标注 MeSH，只靠 MeSH 会系统性漏掉最近一两年的文献。

## PubMed 语法

```
("Sleep Initiation and Maintenance Disorders"[MeSH] OR insomnia[tiab] OR "sleep onset latency"[tiab])
AND
("Cognitive Behavioral Therapy"[MeSH] OR CBT-I[tiab] OR "cognitive behavio*"[tiab])
AND
("Polysomnography"[MeSH] OR polysomnograph*[tiab] OR PSG[tiab])
AND ("2015"[PDAT] : "3000"[PDAT])
```

- `[MeSH]` 默认包含下位词（自动扩展）。不想扩展用 `[MeSH:noexp]`。
- `[tiab]` = 标题 + 摘要。`[tw]`（text word）范围更广但噪声也多。
- `*` 截词：`behavio*` 覆盖 behavior/behaviour/behavioral。**截词会禁用自动词语映射**，
  所以 `sleep*` 不会自动扩展成 MeSH。
- 短语要加引号，否则 `sleep onset latency` 会被当成三个词做 AND。
- 时间限定用 `[PDAT]`（出版日期）而不是 `[EDAT]`（入库日期）。

**MeSH 术语要去 MeSH Browser 核对**，不要凭印象写。失眠的 MeSH 是
"Sleep Initiation and Maintenance Disorders" 而不是 "Insomnia"——写错的后果是
受控词那一半完全失效，而检索仍会返回结果，看不出问题。

## 数据库选择

| 数据库 | 覆盖 | 何时用 |
|---|---|---|
| PubMed / MEDLINE | 生物医学，有 MeSH | 医学主检索，必用 |
| Embase | 欧洲期刊与会议摘要更全 | 系统综述（PubMed 单库覆盖不足） |
| Web of Science / Scopus | 跨学科，引文网络 | 引文追溯、跨学科主题 |
| OpenAlex | 开放、免费 API、覆盖广 | 程序化批量检索、引文网络 |
| Crossref | DOI 权威登记 | 元数据补全与去重 |
| Semantic Scholar | 有 TLDR 与影响力引用标记 | 快速筛查、找高影响引用 |
| PsycINFO | 心理学与行为科学 | 行为干预类主题 |

**系统综述至少要检索三个库**（PROSPERO 与 PRISMA 的常规期望），并另做引文追溯
（向前引用 + 参考文献列表）与灰色文献检索。单库检索的漏检率在不少方法学研究里超过 20%。

## 程序化检索

```python
import requests

# PubMed E-utilities：先 esearch 取 PMID，再 efetch 取详情
r = requests.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
                 params={'db': 'pubmed', 'term': query, 'retmax': 1000,
                         'retmode': 'json', 'email': 'you@example.com'},
                 timeout=30)
pmids = r.json()['esearchresult']['idlist']
```

```python
# OpenAlex：无需密钥，但要带 mailto 进礼貌池
r = requests.get('https://api.openalex.org/works',
                 params={'search': '...', 'per-page': 200, 'mailto': 'you@example.com'},
                 timeout=30)
```

访问外部域名会触发出口审批——第一次调用时会请求放行该域名，这是预期行为。
遵守速率限制（PubMed 无密钥时 3 请求/秒），并处理分页（PubMed 用 `retstart`，
OpenAlex 用 `cursor`）。

## 必须留档的六项

```python
record = {
    'database': 'PubMed',
    'query': query,                    # 原样，包括括号与字段标签
    'search_date': '2026-08-28',
    'filters': 'PDAT 2015-present; English',
    'hits': len(pmids),
    'tool': 'E-utilities esearch',
}
```

把它存成制品。**命中数尤其重要**：半年后重跑得到不同的数量是正常的（数据库在增长），
但只有留了原始数量才能说明差异来自哪里。

## 反面做法

- **凭记忆列参考文献。** 模型对文献的记忆包含不存在的条目（作者、年份、期刊看起来
  都对，DOI 却指向别的文章）。任何引文都要经检索工具取证，见 `citation-verify`。
- **只看第一页结果。** 相关度排序对布尔检索式不可靠，要么全量导出，要么用明确的
  停止规则（如「连续 50 条无相关」）并写明。
- **把检索式写成一句自然语言放进论文。** 「我们检索了 PubMed 中关于失眠与 CBT-I 的
  文献」无法复现。附完整检索式，长的话放进补充材料。
