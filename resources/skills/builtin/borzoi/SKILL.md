---
slug: borzoi
name: Borzoi 序列到表达预测
version: 1.0.0
---

# Borzoi 序列到表达预测

## 它预测什么

输入一段 DNA 序列（约 524 kb 上下文），输出**沿序列的 RNA-seq 覆盖度轨道**，分辨率 32 bp，
覆盖上千个人类与小鼠的样本/组织轨道。它是 Enformer 的后继：Enformer 预测的是 CAGE、
DNase、ChIP 等信号，Borzoi 直接预测 RNA-seq 覆盖，因此能同时反映**表达量、剪接、
3′ 端选择**这三类效应。

这是它区别于 `evo2` 的地方：Evo 2 给序列似然（「这段序列合理吗」），Borzoi 给功能读出
（「这段序列在这个组织里表达多少、怎么剪接」）。调控变异分析里两者互补。

## 基本用法

```python
import numpy as np

# 1) 取以目标位点为中心的序列，长度必须等于模型输入长度
SEQ_LEN = 524_288
def center_window(fa, chrom: str, pos0: int) -> str:
    half = SEQ_LEN // 2
    start = pos0 - half
    seq = fa.fetch(chrom, max(0, start), start + SEQ_LEN)
    # 越过染色体边界时补 N，且必须记录发生了填充
    if len(seq) < SEQ_LEN:
        seq = seq + 'N' * (SEQ_LEN - len(seq))
    return seq.upper()

# 2) one-hot 编码。碱基顺序必须与训练时一致（通常 ACGT），N 编码为全 0
def one_hot(seq: str) -> np.ndarray:
    lut = {'A': 0, 'C': 1, 'G': 2, 'T': 3}
    x = np.zeros((len(seq), 4), dtype=np.float32)
    for i, b in enumerate(seq):
        j = lut.get(b)
        if j is not None:
            x[i, j] = 1.0
    return x

# 3) 前向，得到 [轨道数, bins] 的覆盖度预测
pred = model.predict(one_hot(seq)[None])[0]
```

三个必须做对的细节：

1. **序列长度必须精确等于模型输入长度**。少一个碱基会让整个感受野错位，而多数实现只会
   报一个形状错误——如果你自己 pad 到了对的长度但没居中，就完全不报错，只是结果错。
2. **one-hot 的碱基顺序**要与权重训练时一致。顺序搞错等于把 A 当 C，预测毫无意义且不报错。
3. **`N` 编码为全 0**，不是 0.25。用 0.25 会让模型看到一个「四种碱基混合」的信号，
   那在训练分布里不存在。

## 输出的读法

输出是 `[轨道, bin]`。要用它必须解决两件事：

**A. 找到你要的轨道。** 上千条轨道对应不同样本与检测类型，靠索引硬编码迟早出错。
从轨道元数据表里按名称筛：

```python
import pandas as pd
targets = pd.read_csv('targets_human.txt', sep='\t')          # 随权重分发
liver = targets[targets['description'].str.contains('liver', case=False)]
print(liver[['index', 'identifier', 'description']].head())
tracks = liver['index'].to_numpy()
```

**报告时必须写明用了哪些轨道**（identifier 而不是索引号）。「肝脏表达升高」这句话在
不同轨道子集下可以得出相反结论。

**B. 把 bin 汇总成基因级数值。** 覆盖度是沿序列的，要比较表达量得先在基因区间上求和：

```python
BIN = 32
def gene_signal(pred, window_start: int, gene_start: int, gene_end: int, tracks) -> float:
    lo = (gene_start - window_start) // BIN
    hi = (gene_end - window_start) // BIN
    return float(pred[tracks, lo:hi].sum(axis=1).mean())
```

注意模型输出的 bin 范围通常**小于**输入长度（两端被裁掉作为上下文）。计算 bin 索引时必须
减掉这个裁剪偏移，否则整体错位。偏移量从权重配置里读，不要猜。

## 变异效应：in silico 突变

```python
ref_seq = center_window(fa, chrom, pos0)
assert ref_seq[SEQ_LEN // 2] == ref, '参考碱基对不上，坐标或基因组版本错了'

alt_seq = ref_seq[: SEQ_LEN // 2] + alt + ref_seq[SEQ_LEN // 2 + 1 :]
p_ref = model.predict(one_hot(ref_seq)[None])[0]
p_alt = model.predict(one_hot(alt_seq)[None])[0]

# 在目标基因区间上取对数比，避免绝对尺度问题
s_ref = gene_signal(p_ref, win_start, g_start, g_end, tracks)
s_alt = gene_signal(p_alt, win_start, g_start, g_end, tracks)
log2fc = np.log2((s_alt + 1e-6) / (s_ref + 1e-6))
```

- **变异必须放在窗口中心**，与 `evo2` 同理。
- **用对数比而不是差值**。覆盖度尺度在不同基因间差几个数量级，差值不可比。
- **正反链都要考虑**：对负链基因，很多实现要求把序列反向互补后再预测。反了不会报错，
  只会让效应方向错。检查方式是拿几个已知方向的 eQTL 验证符号。

## 归因（找关键碱基）

要回答「这个增强子里哪些碱基重要」，用 ISM（逐碱基替换）或梯度类归因。ISM 更慢但更可信
（没有梯度饱和问题）：

```python
def ism(seq: str, lo: int, hi: int, tracks, ref_signal: float) -> np.ndarray:
    """返回 [位置, 4] 的效应矩阵。区间要小，ISM 是 O(区间长度 × 4) 次前向。"""
    out = np.zeros((hi - lo, 4))
    for i in range(lo, hi):
        for j, b in enumerate('ACGT'):
            if seq[i] == b:
                continue
            mut = seq[:i] + b + seq[i + 1 :]
            p = model.predict(one_hot(mut)[None])[0]
            out[i - lo, j] = gene_signal(p, ...) - ref_signal
    return out
```

ISM 的成本是每个碱基三次前向，一个 200 bp 区间就是 600 次。**先用梯度归因定位候选区间，
再在小区间上跑 ISM** 是常规做法。

## 三条已知边界，必须在结论里体现

1. **跨个体预测能力有限。** 这是这类模型最重要的已知局限：在**跨基因**方向上（哪些基因
   表达高）表现很好，但在**跨个体**方向上（同一个基因在不同人之间的表达差异）表现弱得多。
   因此不要用它做个体化表达预测，也不要声称它能替代实测 eQTL。它适合的是「这个变异有没有
   调控效应」这类定性问题与相对排序。
2. **它预测的是模型见过的组织/样本轨道**，不是任意细胞类型。你的目标细胞类型没有对应
   轨道时，用最接近的并明确说明这个替代。
3. **它不区分因果与相关。** 高归因分数意味着模型依赖那些碱基，不等于那些碱基在生物学上
   是因果的。归因是假设生成，实验验证（报告基因、CRISPRi）才是确认。

## 验证清单

- [ ] 基因组版本记录了；参考碱基断言过
- [ ] 序列长度精确、变异居中、越界填充有记录
- [ ] one-hot 碱基顺序与权重一致；N 编码为全 0
- [ ] 负链基因的链方向处理正确（拿已知 eQTL 验过符号）
- [ ] bin 索引减掉了输出裁剪偏移
- [ ] 轨道按 **identifier** 记录，不是索引号
- [ ] 用对数比而非差值报效应
- [ ] 结论里没有声称跨个体/个体化预测能力
- [ ] 归因结论表述为假设而非因果
- [ ] 版本记录：权重版本、轨道元数据文件、torch 版本

## 存成制品

存：变异表（含 log2fc、用的轨道 identifier 列表、窗口起点）、覆盖度轨道图、归因矩阵、
轨道元数据文件本身、基因组版本与校验和。

**轨道元数据文件要跟着存**。它是「用了哪些组织」的唯一权威记录，而不同权重版本的轨道
索引不同——只存索引号的话，换个版本重跑会静默地用到另一批组织。
