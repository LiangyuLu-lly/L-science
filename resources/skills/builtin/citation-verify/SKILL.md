---
slug: citation-verify
name: 引文核实
version: 1.0.0
---

# 引文核实

## 铁律

**不许凭记忆回答「这篇文献是否存在」或「它是否支持这个结论」。** 每一条都要经检索工具
取证。原因不是谨慎，是已知的失效模式：语言模型能生成作者、年份、期刊、卷页、
甚至 DOI 格式全都合理但整篇不存在的引文，而这种输出在表面上与真引文毫无区别。

宁可回答「我核实不了」，也不要给一个未经核实的肯定答复。前者用户会自己去查，
后者会进论文然后被审稿人抓到。

## 两个层次

核实分两步，**第二步比第一步重要得多**：

1. **存在性**：这篇文献存在吗？元数据对得上吗？
2. **支持性**：它的内容真的支持你要引用它来支持的那个说法吗？

「存在但不支持」是最危险的情形——引文能被查到，所以看起来没问题，但结论没有依据。
它在同行评议里被抓到的后果比编造引文更难解释（编造可以说是笔误，误引说明没读原文）。

## 第一步：存在性

按可靠性顺序试：

```python
import requests

# 1) 有 DOI 时直接查 Crossref（DOI 的权威登记机构）
r = requests.get(f'https://api.crossref.org/works/{doi}',
                 headers={'User-Agent': 'L-science (mailto:you@example.com)'}, timeout=30)
ok = r.status_code == 200
meta = r.json()['message'] if ok else None
```

```python
# 2) 没有 DOI 时按标题精确查询
r = requests.get('https://api.crossref.org/works',
                 params={'query.bibliographic': title, 'rows': 5}, timeout=30)
```

```python
# 3) 生物医学优先 PubMed（Crossref 不含 PubMed 独有的旧文献）
r = requests.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
                 params={'db': 'pubmed', 'term': f'{title}[Title]', 'retmode': 'json'}, timeout=30)
```

拿到元数据后**逐项核对**，不要只看标题相似：

| 项 | 判定 |
|---|---|
| 标题 | 归一化（去标点、小写）后比较；相似度低于 0.9 视为不匹配 |
| 第一作者姓 | 必须一致。不一致即为不同文献 |
| 年份 | 差 1 年可接受（在线优先 vs 正式出版），差 2 年以上为不匹配 |
| 期刊 | 缩写与全称都要能对上 |
| 卷 / 页 | 有则核对；预印本无卷页是正常的 |

**DOI 解析成功但元数据与声称的不符，是编造引文最典型的表现**：DOI 前缀是真实出版社的，
后缀被凑出来，于是解析到了另一篇真实但无关的文章。这种情况必须报为「不匹配」而不是
「已核实」。

## 第二步：支持性

只有拿到**原文的相关段落**才能判定。可用的证据来源按强度排序：

1. 全文 PDF 的相关段落（用 `pdf-explore` 定位）。
2. 摘要里的明确陈述。
3. **不可接受**：标题、关键词、或「这个领域的共识」。

判定输出三态，不要二值化：

- **supports**：原文有明确对应的陈述。**必须引出原文句子**（不超过 30 词），
  并给出页码或章节。
- **contradicts**：原文的结论与所声称的相反，或适用条件不满足（不同人群、
  不同剂量、不同结局指标）。
- **unclear**：拿不到足够证据。这是一个合法且常见的结论。

**「适用条件不满足」是最常被忽略的一类误引**：一篇在青少年上得到的结论被用来支持
老年人群的说法，引文存在、内容也确实这么说，但结论不适用。核实时要比对人群、
干预、结局三要素。

## 输出格式

```python
verdict = {
    'claim': '慢波活动在老年人中显著降低',
    'citation': {'doi': '10.xxxx/yyyy', 'first_author': 'Smith', 'year': 2019},
    'existence': 'verified',          # verified | not_found | mismatch
    'support': 'supports',            # supports | contradicts | unclear
    'evidence': '原文第 4 页："SWA declined by 38% in the older group"',
    'evidence_source': 'fulltext-pdf',
    'checked_at': '2026-08-28',
    'notes': '原文样本为 60-75 岁，若claim涉及 80 岁以上则超出适用范围',
}
```

存成制品并与断言关联。Reviewer 会对没有证据的断言开 FAIL，而这份记录就是证据。

## 批量核实

参考文献列表逐条核实时：

- **先按 DOI 去重**（见 `reference-dedupe`），避免重复请求。
- 遵守速率限制：Crossref 礼貌池（带 mailto）约 50 请求/秒，无 mailto 会被限流；
  PubMed 无密钥 3 请求/秒。
- 失败要区分「不存在」与「请求失败」。网络错误重试；重试仍失败的记为 `unclear`
  而不是 `not_found`——把网络问题报成「文献不存在」会让用户删掉一条真实引文。
