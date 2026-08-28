---
slug: proteinmpnn
name: ProteinMPNN 序列设计
version: 1.0.0
---

# ProteinMPNN 序列设计

## 三个变体，选哪个

它们是同一族反向折叠模型：输入骨架坐标，输出能折成这个骨架的氨基酸序列。

| 变体 | 什么时候用 | 关键差别 |
| --- | --- | --- |
| **ProteinMPNN** | 通用骨架设计，只有蛋白 | 原版。骨架里的配体、金属、核酸**看不见** |
| **LigandMPNN** | 骨架里有配体/金属/核酸，要设计它周围的位点 | 显式建模非蛋白原子，口袋残基选择质量显著更好 |
| **SolubleMPNN** | 目标是可溶表达、降低聚集 | 训练时排除了跨膜与聚集倾向的语境，倾向给更亲水的表面 |

最常见的错误是**在有配体的口袋上用原版 ProteinMPNN**。它不知道那里有个分子，于是会把
口袋填成一个疏水核心——序列本身没问题，但设计目标（结合）从一开始就没进入优化。
有配体就用 LigandMPNN，没有例外。

## 调用

```bash
python protein_mpnn_run.py \
  --pdb_path backbone.pdb \
  --pdb_path_chains "A" \
  --out_folder out/ \
  --num_seq_per_target 8 \
  --sampling_temp "0.1" \
  --seed 42 \
  --batch_size 1
```

LigandMPNN（独立仓库，参数名略有不同）：

```bash
python run.py \
  --model_type "ligand_mpnn" \
  --pdb_path holo_backbone.pdb \
  --out_folder out/ \
  --number_of_batches 8 \
  --temperature 0.1 \
  --seed 42
```

真正影响结果的参数：

- **`--sampling_temp`**：这是最重要的一个。
  - `0.0001`-`0.1`：接近贪心，序列保守、自一致性高、多样性低。**做单个设计用这档。**
  - `0.2`-`0.3`：多样性明显上升，仍大体可用。做文库筛选用这档。
  - `>0.5`：多样性很高但自一致性快速下降。除非你要大规模实验筛选，否则不用。

  一个实用做法是同时跑 `"0.1 0.2 0.3"`（它接受多个温度），然后按自一致性筛。
- **`--num_seq_per_target`**：每个骨架出多少条。做筛选给 8-64，做单点验证给 8 足够。
- **固定位点**：`--fixed_positions_jsonl`。催化残基、已知功能位点、要保留的界面残基
  必须固定，否则模型会为了折叠稳定性把它们改掉。
- **对称性**：`--tied_positions_jsonl`。同聚体设计必须绑定对应位点，否则各链拿到不同
  序列，那不再是同聚体。
- **偏置**：`--bias_AA_jsonl` 调整整体氨基酸倾向；`--omit_AAs "C"` 排除半胱氨酸（避免
  意外二硫键）是很常见的做法。

`--seed` 必须固定并记录。采样是随机的。

## 自一致性验证——不做这一步就没有任何证据

反向折叠模型给出的分数（负对数似然、序列恢复率）**不能说明设计会折叠**。它们衡量的是
「在模型看来这条序列适合这个骨架」，而模型和自己意见一致是必然的。

唯一有意义的计算验证是**闭环**：设计出的序列，再独立预测一遍结构，看能不能回到原骨架。

```python
# 1) 设计：backbone.pdb → 若干条序列
# 2) 折叠：每条序列独立预测结构（用 esmfold 快，用 alphafold2 稳）
# 3) 比对：预测结构 vs 原骨架，算 Cα RMSD 与 TM-score
from Bio.PDB import PDBParser, Superimposer
import numpy as np

def ca_rmsd(ref_pdb: str, pred_pdb: str) -> float:
    p = PDBParser(QUIET=True)
    ref = [a for a in p.get_structure('r', ref_pdb).get_atoms() if a.get_id() == 'CA']
    pred = [a for a in p.get_structure('p', pred_pdb).get_atoms() if a.get_id() == 'CA']
    n = min(len(ref), len(pred))
    sup = Superimposer(); sup.set_atoms(ref[:n], pred[:n])
    return float(sup.rms)
```

判据（领域内常用的量级）：

- **scRMSD < 2 Å** 且预测的 pLDDT 高：设计通过计算筛选
- 2-3 Å：边缘，需要更多证据
- **> 3 Å**：设计失败，不要送去实验

关键点：**第 2 步的折叠模型必须与设计模型独立**。用 ProteinMPNN 自己的分数当验证是循环
论证；而这一步之所以有效，正是因为 ESMFold/AF2 是另一套训练目标下的模型。

同时记住 `alphafold2` 与 `esmfold` 里都写过的那条：**设计序列的 pLDDT 系统性虚高**。
因此 pLDDT 高只是必要条件，scRMSD 才是判据，而两者都通过之后仍然只是「值得做实验」，
不是「设计成功」。

## 完整回路

```
骨架（实验结构 / RFdiffusion 产物）
  → LigandMPNN 设计 N 条序列（温度 0.1，固定催化位点，对称位点绑定）
  → 每条用 ESMFold 折叠（快速筛）
  → scRMSD < 2 Å 且 pLDDT > 85 的留下
  → 留下的用 AlphaFold2 复核（五个模型）
  → 仍然通过的进入实验
```

每一层都要记录**通过率**。通过率异常高（比如 90% 以上）通常说明骨架太保守或验证太宽松；
异常低（低于 5%）说明骨架本身有问题，继续设计是浪费。

## 五个会让工作白做的错误

1. **有配体却用原版 ProteinMPNN**（见上）。
2. **没固定催化/功能位点。** 模型的目标是折叠稳定性，不是功能。不固定它就会为了稳定性
   把活性位点改掉，得到一个折叠很好但没有功能的蛋白。
3. **同聚体没绑定对称位点。** 得到的是异聚体序列，实验里表现完全不同。
4. **用模型自己的分数当验证**（见上）。
5. **报了序列恢复率当成质量指标。** 序列恢复率（与天然序列的一致度）在**重设计天然蛋白**
   时有意义，在**从头设计**里没有参照序列，这个指标根本不适用。

## 验证清单

- [ ] 变体选对了（有配体→LigandMPNN；求可溶→SolubleMPNN）
- [ ] 温度记录了；单点设计用的是低温档
- [ ] 功能位点固定了；同聚体对称位点绑定了
- [ ] seed 固定并记录
- [ ] **做了自一致性回路**，用的是独立的折叠模型
- [ ] 报了 scRMSD 与 pLDDT 两个数，且以 scRMSD 为判据
- [ ] 报了每一层的通过率
- [ ] 没有把序列恢复率用在从头设计上

## 存成制品

存：输入骨架、固定/绑定位点的 JSONL、全部设计序列的 FASTA（含每条的分数与温度）、
每条的折叠预测结构、scRMSD 汇总表、每层通过率、seed 与完整命令行。

那张**汇总表是这一步的核心产物**——它是「为什么送这几条去实验」的全部依据。只存最终
入选的几条序列的话，筛选过程无法复核，而筛选就是这一步的方法学内容。
