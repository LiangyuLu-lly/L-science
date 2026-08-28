---
slug: alphafold2
name: AlphaFold2 结构预测
version: 1.0.0
---

# AlphaFold2 结构预测

## 走哪条路

三条实际可用的路径，按摩擦从低到高：

| 路径 | 适用 | 代价 |
| --- | --- | --- |
| **AFDB 查已有结构** | UniProt 里已有的天然蛋白 | 零算力。**先查这一步**，别重算 |
| **LocalColabFold** | 需要自己跑（突变体、复合物、设计序列） | 一次装好，GPU 显存 ≥12 GB 覆盖多数单体 |
| 完整 AlphaFold2 | 需要严格复现原论文流程、或要用完整模板库 | 数据库约 2.6 TB |

AFDB（AlphaFold Protein Structure Database）已经覆盖了 UniProt 的绝大部分。**任何天然
序列先查 AFDB**：拿到的是同一套模型的输出，而且带了官方的 pLDDT 与 PAE。

```python
# 先查再算。存在就直接用，别浪费几十分钟 GPU
import urllib.request, json
acc = 'P00533'
meta = json.load(urllib.request.urlopen(f'https://alphafold.ebi.ac.uk/api/prediction/{acc}'))
print(meta[0]['pdbUrl'], meta[0]['paeDocUrl'])
```

## LocalColabFold 的调用

```bash
colabfold_batch input.fasta out/ \
  --num-recycle 3 \
  --num-models 5 \
  --amber \
  --use-gpu-relax \
  --model-type auto
```

复合物用 `:` 连接链，**同一条重复表示同聚体的化学计量**：

```
>homodimer
MKV...QRS:MKV...QRS
>heterotrimer_A2B
MKV...QRS:MKV...QRS:PLT...WNE
```

参数只有几个真正影响结论：

- `--num-recycle`：默认 3。难目标（低 MSA 深度、长 loop、大复合物）提到 12-20 常能把
  pLDDT 抬上去。提高它比换模型更有效，代价线性。
- `--num-models 5`：跑满五个。只跑一个就没有「模型间一致性」这个判据，而那是判断预测
  是否可信的重要信号——五个模型给出互不相同的构象时，任何单个模型都不可信。
- `--amber` / `--use-gpu-relax`：**只要涉及键长键角、接触距离、氢键、对接输入，就必须
  relax**。未 relax 的模型有立体化学冲突，直接拿去对接会得到荒谬的打分。
- `--templates`：默认不用。用模板会提高已知家族的精度，但也会在做基准测试时引入泄漏。
- `--msa-mode`：默认走 MMseqs2 远端 API（**会联网**，出口代理会拦下来要审批）。
  离线环境用 `--msa-mode single_sequence` 但精度会显著下降，或者自己准备 a3m。

## 置信度怎么读

三个量，各回答不同的问题，不能互相替代。

**pLDDT**（0-100，逐残基）回答「这个残基的局部结构对不对」。

| 区间 | 含义 |
| --- | --- |
| >90 | 主链与侧链朝向都可信 |
| 70-90 | 主链可信，侧链未必 |
| 50-70 | 低置信，只能当拓扑提示 |
| <50 | **很可能本来就是无序区**，不是「预测失败」 |

`<50` 的长片段是有信息的：它常常正确地指出了内在无序区（IDR）。把它当失败去调参是白费
力气，把它当结构去解释是错误。

**PAE**（预测对齐误差矩阵，逐残基对）回答「域 A 相对域 B 的摆放对不对」。它是唯一能
回答这个问题的量——两个域各自 pLDDT 都 95，而它们之间的相对位置完全是猜的，这种情况很常见。
看 PAE 图的块状结构：块内低（深色）块间高就是「域内可信、域间不可信」。

**pTM / ipTM** 是全局标量。复合物只看 `ipTM`：

- ipTM > 0.8：界面大体可信
- 0.6-0.8：需要独立证据支持
- < 0.6：**当作没有预测出界面**，不要在论文里描述这个界面

ColabFold 的复合物排序分是 `0.8 × ipTM + 0.2 × pTM`。排第一不代表可信，只代表在五个
里最好。

```python
import json, numpy as np, matplotlib.pyplot as plt
scores = json.load(open('out/target_scores_rank_001_*.json'))
plddt = np.array(scores['plddt']); pae = np.array(scores['pae'])
print(f'pLDDT 中位数 {np.median(plddt):.1f}，<50 占比 {(plddt < 50).mean():.1%}')
fig, ax = plt.subplots(figsize=(4, 4))
im = ax.imshow(pae, cmap='bwr_r', vmin=0, vmax=31); fig.colorbar(im, label='PAE (Å)')
```

## 会让结论站不住的六件事

1. **把高 pLDDT 当成「这条序列真的会折叠」。** 对**设计序列**尤其危险：AF2 对从头设计
   的序列普遍给出很高的 pLDDT，而其中相当一部分在实验里根本不折叠。pLDDT 衡量的是
   「模型对自己输出有多确定」，不是「这个分子在溶液里的行为」。设计序列的可信度要靠
   正交证据（见 `proteinmpnn` 里的自一致性验证）。
2. **把预测结构当实验结构用。** 不要在论文里写「结构显示」，写「预测模型提示」。
   坐标文件里的 B-factor 列在 AFDB 与 ColabFold 输出里放的是 **pLDDT 而不是 B-factor**，
   任何按 B-factor 做筛选的下游脚本都会读出错误的语义。
3. **拿 AF2 模型讨论构象变化或动力学。** AF2 给一个静态结构，它不采样构象集合。
   「预测的开放态与晶体的闭合态不同，说明存在构象转换」是无效推理。
4. **忘了 AF2 里没有配体、辅因子、金属、糖基化与其他修饰。** 输出是 apo 形态。口袋里
   看起来空的，不能推断它是空的；缺了金属的位点几何常常是错的。需要配体请用 `boltz-2`、
   `chai-1` 或 `openfold3`。
5. **在 MSA 很浅的目标上不检查 Neff。** 精度强依赖同源序列数量。孤儿蛋白、病毒蛋白、
   快速演化区的预测要格外保守。ColabFold 的 a3m 行数可以直接看：
   ```bash
   grep -c '^>' out/target.a3m
   ```
   几十条以内就要在方法里写明这个限制。
6. **基准测试里的模板与训练集泄漏。** AF2 的训练截止在 2018-04-30（原始权重）。
   拿一个更早存进 PDB 的结构去「验证」AF2 不构成验证。做评估必须用截止之后的结构，
   并显式关掉模板。

## 验证清单

宣称一个预测可用之前，逐条过：

- [ ] 先查过 AFDB，确认不是在重算已有结果
- [ ] 五个模型都跑了，且它们的整体构象一致
- [ ] pLDDT 中位数、`<50` 残基占比都记录了
- [ ] 复合物看了 ipTM，且 PAE 图的块结构与「哪些域的相对位置可信」的说法一致
- [ ] relax 跑过（涉及几何、接触、对接时）
- [ ] MSA 深度记录了；深度不足时在方法里写明
- [ ] 版本记录了：ColabFold 版本、权重版本（`alphafold2_multimer_v3` 之类）、
      MSA 来源与日期

## 存成制品

要存的是**五份坐标 + 打分 JSON + PAE 矩阵 + a3m + 完整命令行**，不是只存排名第一的 PDB。
只存一个的话「模型间一致吗」这个问题事后无法回答，而它是可信度判断的核心依据之一。
`save_artifacts` 时把命令行与版本写进 code 字段。
