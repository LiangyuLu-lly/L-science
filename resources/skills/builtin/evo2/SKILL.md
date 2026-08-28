---
slug: evo2
name: Evo 2 基因组语言模型
version: 1.0.0
---

# Evo 2 基因组语言模型

## 它是什么，不是什么

Evo 2 是在跨物种基因组数据上训练的 DNA 语言模型，**单核苷酸分辨率**，上下文可达百万
碱基量级。它给的是序列的对数似然，以及可用于下游的表示。

它**不是**：

- 不是变异注释工具。它不知道基因边界、不知道转录本、不给 HGVS 记法。这些要靠
  Ensembl VEP 之类的注释流程。
- 不是表达量预测器。要从序列预测 RNA-seq 覆盖度去 `borzoi`。
- 不是蛋白模型。编码区变异对蛋白的影响，`esm2` 常常更直接。

分工是清楚的：**Evo 2 的独特价值在非编码区与「不依赖比对」的场景**。多数序列级方法
（保守性打分、MSA 方法）在非编码区、在缺乏近缘物种的序列上都很吃力，而 Evo 2 不需要比对。

## 变异打分

核心量是 delta likelihood：突变序列与参考序列的对数似然之差。

```python
from evo2 import Evo2
import numpy as np

model = Evo2('evo2_7b')          # 也有 1b / 40b

def score_variant(chrom_seq: str, pos0: int, ref: str, alt: str,
                  window: int = 8192) -> float:
    """pos0 是 0-based 的变异位置。返回 delta = logL(alt) - logL(ref)。"""
    assert chrom_seq[pos0] == ref, '参考碱基对不上，坐标或基因组版本错了'

    half = window // 2
    start, end = max(0, pos0 - half), pos0 + half
    ref_seq = chrom_seq[start:end]
    off = pos0 - start
    alt_seq = ref_seq[:off] + alt + ref_seq[off + 1 :]

    ll_ref = model.score_sequences([ref_seq])[0]
    ll_alt = model.score_sequences([alt_seq])[0]
    return float(ll_alt - ll_ref)
```

四条纪律：

1. **先断言参考碱基对得上**（上面那行 `assert`）。坐标系错位（1-based 与 0-based）、
   基因组版本不一致（hg19 与 hg38）是这类分析里最高频的错误，而它不会报错——你会得到
   一整列看起来正常的分数，全都基于错误的位置。
2. **窗口大小固定并记录。** delta 值随窗口变化。同一批分析里所有变异必须用同一窗口，
   否则分数不可比。
3. **窗口要居中。** 把变异放在窗口中间，不要让它靠边——模型两侧的上下文不对称会引入
   系统偏差。
4. **符号方向写清楚。** 这里 `delta = logL(alt) − logL(ref)`，**越负表示突变越被模型认为
   不合理**，即越可能有害。写进论文时把这句话写出来。

批量处理时按染色体分组、一次读入序列，不要每个变异重读一次 FASTA：

```python
import pysam
fa = pysam.FastaFile('GRCh38.fa')
for chrom, grp in variants.groupby('chrom'):
    seq = fa.fetch(chrom)                      # 一次取整条
    grp['delta'] = [score_variant(seq, p - 1, r, a)     # VCF 是 1-based
                    for p, r, a in zip(grp.pos, grp.ref, grp.alt)]
```

## 评估：没有阈值，只有分布

与 `esm2` 同理，delta 没有绝对阈值。可用的做法有两种：

**A. 与已知集合比较分布。** 拿 ClinVar 的致病/良性集合（注意排除与训练数据可能重叠的
部分），画两条分布，报 AUROC / AUPRC。

```python
from sklearn.metrics import roc_auc_score, average_precision_score
auroc = roc_auc_score(y_pathogenic, -delta)      # 注意取负号对齐方向
auprc = average_precision_score(y_pathogenic, -delta)
```

`-delta` 那个负号是必须的：delta 越负越有害，而 AUROC 要求分数越大越正类。**这个符号
搞反会得到一个低于 0.5 的 AUROC，然后被误读成「模型没用」**，而实际上是方向反了。
看到 AUROC 明显低于 0.5，第一件事是检查符号。

**B. 在同一基因内排序。** 饱和突变扫描类问题里，只关心同一位点/同一基因内的相对排序，
此时用 Spearman 与实测功能数据比较。

**类不平衡必须处理**：ClinVar 里良性变异远多于致病变异，只报 AUROC 会过于乐观。
一并报 AUPRC 与基线正类率。详见 `ml-eval-protocol`。

## 生物安全边界

Evo 2 是生成式模型，能产出新的 DNA 序列。这条能力有明确的使用边界，且这个边界与技术
无关而与用途有关：

- **不生成、不优化、不设计**与病原体毒力、传播性、免疫逃逸相关的序列。
- **不用它规避**合成 DNA 供应商的筛查（模型的训练数据里刻意排除了部分内容，但这不构成
  可以尝试绕过的理由）。
- 生成式用法用于工程菌、代谢通路、调控元件这类无害目标时，仍然要在方法里写明生成而非
  天然来源，并遵守所在机构的生物安全审查流程。

这不是形式条款。序列一旦进入合成流程就离开了计算环境，此时唯一的控制点是研究者本人的
判断，而那个判断应该在动手之前完成。

## 与其他技能的分工

| 问题 | 用 |
| --- | --- |
| 编码区错义变异对蛋白的影响 | `esm2`（配 Evo 2 交叉验证） |
| 非编码/调控区变异 | Evo 2 |
| 变异对表达量与剪接的影响 | `borzoi` |
| 需要标准注释（基因、转录本、HGVS） | Ensembl VEP 连接器 |
| 群体频率、临床解读 | gnomAD / ClinVar 连接器 |

严肃的变异解读是**多证据汇总**：序列模型分数 + 保守性 + 群体频率 + 功能注释 + 已有临床
证据。任何单一分数都不足以支撑致病性判断，这一点要在结论里如实体现。

## 验证清单

- [ ] 基因组版本记录了（hg19/hg38/T2T），且与变异坐标来源一致
- [ ] 每个变异都断言过参考碱基对得上
- [ ] 窗口大小固定、居中，并记录
- [ ] delta 的符号方向在代码与文字里都写明了
- [ ] 算 AUROC 时符号已对齐（看到 <0.5 先查符号）
- [ ] 类不平衡下同时报了 AUPRC 与基线正类率
- [ ] 评估集与训练数据的潜在重叠已考虑并说明
- [ ] 结论是多证据汇总，不是单一分数
- [ ] 生成式用法符合上面的安全边界，且经过机构流程

## 存成制品

存：变异表（含 chrom/pos/ref/alt/delta/窗口大小）、基因组版本与 FASTA 校验和、评估曲线
与指标表、权重名与版本。

**基因组 FASTA 的校验和要存**。同一个「hg38」有多个变体（含不含 alt contigs、不同的
patch 版本），坐标在边缘情况下会不一致，而事后无法从结果反推用的是哪一份。
