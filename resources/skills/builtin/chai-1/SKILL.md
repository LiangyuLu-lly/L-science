---
slug: chai-1
name: Chai-1 多模态结构预测
version: 1.0.0
---

# Chai-1 多模态结构预测

## 它的差异点

Chai-1 与 `boltz-2`、`openfold3` 同属「AF3 之后的开源共折叠模型」这一代，能同时处理蛋白、
DNA、RNA、小分子与修饰残基。它真正区别于其他两个的地方是**约束通道**：可以把实验得到的
接触信息喂进去引导预测。

这一点在实际研究里很关键。你手上常常有：交联质谱给出的残基对、突变实验指出的界面残基、
已知的口袋位置、共价抑制剂的连接点。没有约束通道时这些信息只能用来**事后筛选**预测结果；
有了它，这些信息可以**事前约束**采样空间。

另一个差异是它在**不给 MSA** 时表现相对稳（官方定位就是单序列可用），因此离线环境下比
需要 MSA 服务的路径省事。要更高精度仍然可以给 MSA。

## 输入是带前缀的 FASTA

实体类型写在序列名里，用 `type|name=...` 的形式：

```
>protein|name=kinase_A
MKVLWAALLVTFLAGCQAKVEQAVETEPEPELRQQTEWQSGQRWELALGRFWDYLRWVQTLS
>protein|name=kinase_A_copy2
MKVLWAALLVTFLAGCQAKVEQAVETEPEPELRQQTEWQSGQRWELALGRFWDYLRWVQTLS
>ligand|name=inhibitor
CC(=O)Oc1ccccc1C(=O)O
>rna|name=aptamer
GGCUAGCUACGAUCG
```

同聚体就重复写，`name` 必须不同（它同时是链标识）。配体那一行写 SMILES。

```python
from pathlib import Path
from chai_lab.chai1 import run_inference

out = run_inference(
    fasta_file=Path('input.fasta'),
    output_dir=Path('out'),
    num_trunk_recycles=3,
    num_diffn_timesteps=200,
    num_diffn_samples=5,
    seed=42,
    use_esm_embeddings=True,
    device='cuda:0',
)
```

参数里只有三个值得调：

- `num_diffn_samples`：采样数，**至少 5**。理由同 `boltz-2`——单个样本没有一致性判据。
- `num_trunk_recycles`：难目标提到 6-10。
- `num_diffn_timesteps`：默认 200 已经够；调低省时但会让结构变糙，别为了快改它。

`seed` 一定要固定并记录。扩散采样是随机的，不固定种子这次预测不可复现——这是
`reproducibility-checklist` 里最常被忽略的一条。

## 约束

约束以 CSV 提供，通过 `constraint_path` 传入。三类常用：

| 类型 | 用来表达 | 典型来源 |
| --- | --- | --- |
| `contact` | 两个具体残基应当靠近 | 交联质谱、双突变互补、FRET |
| `pocket` | 配体应落在某组残基围成的位置 | 已知活性位点、同源 holo 结构 |
| `covalent` | 两个原子之间有共价键 | 共价抑制剂、糖基化位点、二硫键 |

```python
out = run_inference(
    fasta_file=Path('input.fasta'),
    constraint_path=Path('restraints.csv'),
    output_dir=Path('out'),
    num_diffn_samples=5,
    seed=42,
)
```

**约束用错会静默失效，这是这个技能最需要防的坑。** 具体形态：

1. **残基编号基准不对。** 约束里的编号必须与你 FASTA 里的序列编号一致（1-based，
   从该链序列第一个残基算）。用 PDB 里的作者编号（常常不从 1 开始、常常有插入码）会
   指到错误的残基，而程序不会报错——它会老老实实地把两个错残基拉近。
   **写约束之前先打印那几个位置的残基类型核对一遍**：
   ```python
   seq = 'MKVLWAALL...'
   for pos in (45, 128):
       print(pos, seq[pos - 1])     # 与实验记录里的残基类型对得上吗
   ```
2. **链名对不上。** 约束里的链标识用的是 FASTA 里的 `name=`。拼错就等于没有这条约束。
3. **约束互相矛盾或物理上不可能。** 模型会尽力满足，结果是一个被扭曲的结构，而置信度
   可能仍然不低。加了约束之后**必须与不加约束的预测比一比**：构象差别巨大而置信度反而
   升高，通常说明约束把结构拽变形了。
4. **把约束当结论。** 用约束引导出的界面不能再拿来「验证」那些约束。这是循环论证。

## 置信度

输出的 `scores.model_idx_*.npz` 里有 `aggregate_score`、`ptm`、`iptm`、`per_chain_ptm`、
`per_chain_pair_iptm`。读法与 `boltz-2` 一致：

- 复合物界面看 `per_chain_pair_iptm` 里对应那一对，不看全局
- 配体位置的可信度低就不要讨论结合模式
- 五个样本的构象一致性是独立于任何分数的判据，先看它

```python
import numpy as np
s = np.load('out/scores.model_idx_0.npz')
print({k: np.round(s[k], 3) for k in ('aggregate_score', 'ptm', 'iptm')})
print('链对 iptm:\n', np.round(s['per_chain_pair_iptm'], 3))
```

## 与同类的取舍

需要**亲和力数值**去 `boltz-2`；需要**实验约束引导**或**离线单序列**用 Chai-1；
需要最接近 AF3 论文流程的复现用 `openfold3`；纯蛋白且要最稳用 `alphafold2`。

三个都能跑的时候，**跑两个看是否一致**比在一个上反复调参更有信息量。

## 验证清单

- [ ] `seed` 固定并记录，`num_diffn_samples` ≥ 5
- [ ] 五个样本构象一致；不一致时没有只挑好看的那个来讲
- [ ] 界面判据用的是 `per_chain_pair_iptm` 对应项
- [ ] 有约束时：残基编号核对过（打印过残基类型）、链名核对过
- [ ] 有约束时：与无约束预测比较过，确认不是把结构拽变形了
- [ ] 没有用「约束引导出的结果」去支持那些约束本身
- [ ] 版本记录：chai_lab 版本、权重版本、是否用了 ESM 嵌入与 MSA

## 存成制品

存：FASTA、约束 CSV、全部样本的 mmCIF、`scores.*.npz`、seed 与完整参数。约束 CSV 与
seed 是这里最容易丢又最致命的两样——丢了约束不知道结构是被什么拽出来的，丢了 seed
连同一个结果都拿不回来。
