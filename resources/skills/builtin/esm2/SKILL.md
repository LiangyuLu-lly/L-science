---
slug: esm2
name: ESM-2 蛋白语言模型
version: 1.0.0
---

# ESM-2 蛋白语言模型

## 选哪个规模

| 权重 | 参数 | 维度 | 什么时候用 |
| --- | --- | --- | --- |
| `esm2_t12_35M_UR50D` | 35M | 480 | 快速试通流程、CPU 也能跑 |
| `esm2_t30_150M_UR50D` | 150M | 640 | 数据量小（几百条）时性价比常最好 |
| `esm2_t33_650M_UR50D` | 650M | 1280 | **默认选它。** 多数任务上的甜点 |
| `esm2_t36_3B_UR50D` | 3B | 2560 | 变异效应预测、数据量大时 |
| `esm2_t48_15B_UR50D` | 15B | 5120 | 除非有充分理由且显存够，否则不必 |

一条经验：**下游数据只有几百条标注时，650M 与 3B 的差别通常被数据量掩盖**，而 3B 会让
每次迭代慢好几倍。先用 650M 把流程与评估搭对，再考虑换大的。

## 取嵌入

```python
import torch, esm

model, alphabet = esm.pretrained.esm2_t33_650M_UR50D()
model = model.eval().cuda()
bc = alphabet.get_batch_converter()

data = [('p1', 'MKVLWAALLVTFLAGCQAK'), ('p2', 'PLTWNEQVQEELLSSQ')]
labels, strs, toks = bc(data)
with torch.no_grad():
    out = model(toks.cuda(), repr_layers=[33], return_contacts=False)
reps = out['representations'][33]          # [B, L+2, D]
```

**这里有一个必须做对的细节**：`toks` 里带了起始（`<cls>`）与结束（`<eos>`）标记，而 batch
内短序列被 pad。取嵌入时必须按真实长度切掉这三类位置：

```python
seq_reps, mean_reps = [], []
for i, (_, seq) in enumerate(data):
    r = reps[i, 1 : len(seq) + 1]          # 去掉 cls 与 eos/pad
    seq_reps.append(r.cpu())               # 逐残基 [L, D]
    mean_reps.append(r.mean(0).cpu())      # 序列级 [D]
```

不切的后果很具体：pad 位置的向量会被平均进去，于是**同一条序列在不同 batch 里得到不同的
嵌入**（因为 batch 内最长序列变了）。这个错误不会报，只会让下游模型的性能莫名不稳定。

序列级表示用**掩码均值池化**（上面的写法）。不要用 `<cls>` 位置的向量——ESM-2 的预训练
目标里没有句子级任务，`<cls>` 没有被训练成序列摘要。

## 零样本变异效应预测

不需要任何标注数据，直接用语言模型的似然给突变打分。标准做法是**掩码边际**
（masked marginal）：把突变位点掩掉，比较野生型与突变型氨基酸在该位置的对数概率。

```python
import torch

def masked_marginals(model, alphabet, seq: str, positions: list[int]) -> dict:
    """positions 是 1-based 的序列位置。返回 {pos: {aa: logprob}}。"""
    bc = alphabet.get_batch_converter()
    _, _, toks = bc([('wt', seq)])
    toks = toks.cuda()
    out = {}
    for pos in positions:
        idx = pos                                  # +1 抵消 cls，正好等于 pos
        masked = toks.clone()
        masked[0, idx] = alphabet.mask_idx
        with torch.no_grad():
            logits = model(masked)['logits']
        lp = torch.log_softmax(logits[0, idx], dim=-1)
        out[pos] = {aa: float(lp[alphabet.get_idx(aa)]) for aa in 'ACDEFGHIKLMNPQRSTVWY'}
    return out

marg = masked_marginals(model, alphabet, seq, [45, 128])
# 突变分数 = log P(mut) - log P(wt)。越负越可能有害
score = marg[45]['A'] - marg[45][seq[44]]
```

三条要点：

1. **分数是相对的，没有绝对阈值。** 「score < −5 就是致病」这种阈值不存在。用法是在
   一组突变里排序，或者与已知的良性/致病集合比较分布位置。
2. **报告方向。** 越负越可能有害。写进论文时明确写出符号约定，这是最常被写反的地方。
3. **序列超过模型窗口时要切窗。** 长蛋白围绕突变位点取一个足够大的窗口（比如两侧各 511），
   并记录窗口策略——不同窗口会给出不同分数。

零样本打分与 MSA 类方法（GEMME、EVE）各有强弱，两者相关但不一致。要做严肃的致病性
判断，两条路都跑并报告一致性。

## 嵌入 + 下游模型：最大的坑是切分

用 ESM-2 嵌入做下游分类/回归时，**随机切分训练/测试集会严重高估性能**。原因：蛋白数据集
里充满同源序列，随机切分会把同一家族的成员分到两侧，测试集因此不是「未见过的蛋白」而是
「训练集里那个蛋白的近亲」。

正确做法是**按序列相似性聚类切分**：

```bash
# 用 MMseqs2 在 30% 同一性上聚类，同簇的整体划到同一侧
mmseqs easy-cluster all.fasta clu tmp --min-seq-id 0.3 -c 0.8 --cov-mode 1
```

```python
import pandas as pd
from sklearn.model_selection import GroupKFold

clusters = pd.read_csv('clu_cluster.tsv', sep='\t', names=['rep', 'member'])
groups = df['id'].map(dict(zip(clusters['member'], clusters['rep'])))
cv = GroupKFold(n_splits=5)                # 按簇分组，同簇不跨折
for tr, te in cv.split(X, y, groups=groups):
    ...
```

同时报告两个数字：随机切分的性能与聚类切分的性能。差距很大（常见）本身就是重要信息——
它量化了这个任务有多依赖同源信息。只报随机切分的结果是不诚实的，只报聚类切分的结果
则让读者无法与文献里（大多用随机切分）的数字比较。

其余评估纪律见 `ml-eval-protocol`。

## 与 ESMFold 的关系

ESMFold（见 `esmfold`）的骨干就是 ESM-2。已经在算嵌入的话，结构预测可以复用同一次编码，
省一次前向。

## 验证清单

- [ ] 权重规模与数据量匹配，且记录了具体权重名
- [ ] 取嵌入时**切掉了 cls/eos/pad**；序列级用掩码均值池化，不是 cls 向量
- [ ] 变异打分明确写了符号方向；没有使用凭空的绝对阈值
- [ ] 长序列的窗口策略记录了
- [ ] 下游任务**按序列相似性聚类切分**，并同时报告了随机切分的数字
- [ ] 嵌入是在固定权重下算的（若做了微调，训练/评估切分与种子都记录了）
- [ ] 版本记录：esm 包版本、权重名、torch 版本

## 存成制品

嵌入矩阵可能很大（几千条序列 × 1280 维）。存 `.npy` 或 `.parquet`，并**在同一个制品的
代码血缘里记下**：权重名、`repr_layers`、池化方式、是否切了特殊标记。

这几项决定了嵌入的语义。同一批序列用不同池化方式得到的嵌入不可混用，而文件本身看不出
区别——只有血缘能回答「这份嵌入是怎么算出来的」。
