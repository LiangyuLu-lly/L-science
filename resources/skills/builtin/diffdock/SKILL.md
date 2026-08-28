---
slug: diffdock
name: DiffDock 分子对接
version: 1.0.0
---

# DiffDock 分子对接

## 它与传统对接的分工

DiffDock 是扩散式对接：直接在配体的位置、朝向、可旋转键上做生成，**不需要指定口袋**
（盲对接）。传统对接（AutoDock Vina、smina、Gnina）需要给一个搜索盒。

分工是清楚的：

| 场景 | 用 |
| --- | --- |
| 不知道口袋在哪 | DiffDock |
| 口袋已知，要精细摆位与打分 | Vina / Gnina（配 DiffDock 交叉验证） |
| 大规模虚拟筛选（十万级） | Vina 类（DiffDock 太慢） |
| 需要蛋白侧也随配体调整 | 都不行，用共折叠：`boltz-2` / `chai-1` |
| 需要亲和力数值 | `boltz-2`（DiffDock **不给亲和力**） |

最后一条要特别记住：**DiffDock 的 confidence 不是亲和力**。它是「这个构象对不对」的
置信度，与「结合有多强」无关。用它给化合物排序去做苗头筛选是误用——两个化合物的
confidence 高低不反映活性高低。

## 输入准备是成败的一半

对接结果的错误里有很大一部分不是模型的问题，而是输入准备的问题。

**受体侧**：

```python
# 去水、去无关杂原子、保留结构性金属与辅因子
from rdkit import Chem
# 实际处理受体常用 pdbfixer / PDB2PQR / reduce
```

- 去掉晶体水（除非有明确证据某个水分子参与结合）
- 去掉冷冻保护剂、缓冲组分等结晶添加物
- **保留**结构性金属（Zn、Mg）与催化辅因子——去掉它们口袋形状就错了
- 补全缺失侧链。缺一段 loop 时要么补上要么在方法里写明
- 用预测结构做受体时：先 relax（见 `alphafold2` 的 `--amber`），且注意 AF2 是 apo 形态，
  口袋可能偏窄

**配体侧**：

```python
from rdkit import Chem
from rdkit.Chem import AllChem

mol = Chem.MolFromSmiles('CC(=O)Oc1ccccc1C(=O)O')
mol = Chem.AddHs(mol)
AllChem.EmbedMolecule(mol, randomSeed=42)
AllChem.MMFFOptimizeMolecule(mol)
Chem.MolToMolFile(mol, 'ligand.sdf')
```

- **质子化状态按 pH 7.4 定**，不是按 SMILES 里写的。羧酸要去质子、碱性胺要质子化。
  搞错电荷会让静电互补完全反过来。用 `dimorphite-dl` 或 OpenBabel 的 `-p 7.4`。
- **手性必须显式写在 SMILES 里**。不写手性，RDKit 会随便给一个，而对接结果会看起来正常。
  这是最隐蔽的一类错误：结论建立在错误的立体异构体上。
- 互变异构体（酮-烯醇、咪唑等）也要显式选定并记录理由。

## 运行

```bash
python -m inference \
  --protein_path receptor.pdb \
  --ligand_description ligand.sdf \
  --out_dir out/ \
  --samples_per_complex 40 \
  --inference_steps 20 \
  --actual_steps 18 \
  --no_final_step_noise
```

- **`--samples_per_complex`**：默认 10，**实际给 40**。扩散采样的方差不小，10 个样本
  常常错过正确构象。这是这里性价比最高的一个调整。
- `--inference_steps` / `--actual_steps`：`actual` 略小于 `inference` 加上
  `--no_final_step_noise` 是官方推荐组合，最后一步不加噪能让构象更干净。
- 批量对接用 `--protein_ligand_csv` 给一张表（每行一个复合物）。

输出按 confidence 降序命名（`rank1_confidence-0.42.sdf` 这样），数值在文件名里。

## 置信度的读法

DiffDock 的 confidence 是一个独立训练的模型给的，尺度大致是 logit：

| 区间 | 经验含义 |
| --- | --- |
| > 0 | 高置信，构象大概率接近正确（RMSD < 2 Å 的比例较高） |
| −1.5 ~ 0 | 中等，需要其他证据 |
| < −1.5 | 低置信，**当作没有得到有效构象** |

两条纪律：

1. **看 top-5 的聚集程度**，不只看 rank1 的分数。五个高分构象落在同一个口袋、朝向相近，
   比一个孤立的高分可信得多。反过来，前五名分散在蛋白表面不同位置，说明模型没有找到
   明确的结合位点。
   ```python
   from rdkit import Chem
   import numpy as np
   poses = [Chem.MolFromMolFile(f'out/rank{i}.sdf') for i in range(1, 6)]
   centers = np.array([p.GetConformer().GetPositions().mean(axis=0) for p in poses])
   print('前五名质心两两距离：\n', np.round(np.linalg.norm(
       centers[:, None] - centers[None, :], axis=-1), 1))
   ```
   两两距离普遍在 5 Å 以内算聚集；出现十几埃的分散就要警惕。
2. **confidence 不能跨复合物比较**（不同蛋白、不同配体）。它只在同一个复合物的候选构象
   之间有序关系。

## 必做：物理合理性检查

这是 DiffDock 这类生成式对接**必须**加的一步，因为它不含力场，会产出物理上不成立的构象：
键长异常、平面基团扭曲、配体与蛋白原子重叠、配体自身原子碰撞。

```python
from posebusters import PoseBusters

pb = PoseBusters(config='dock')       # 'dock' 含受体相关检查
df = pb.bust(['out/rank1.sdf'], mol_true=None, mol_cond='receptor.pdb')
print(df.T)                            # 每一项 True/False
failed = df.columns[~df.iloc[0].astype(bool)]
print('未通过的检查：', list(failed))
```

**任何一项 `False` 的构象不能进入下游**（不能拿去算相互作用、不能做图、不能作为结论
依据）。常见失败项与含义：

- `minimum_distance_to_protein`：与受体原子重叠 → 构象无效
- `internal_steric_clash`：配体自身碰撞 → 构象无效
- `aromatic_ring_flatness`：芳环被扭曲 → 生成瑕疵
- `bond_lengths` / `bond_angles`：几何超出容差

通过 PoseBusters 之后，若要报相互作用细节（氢键、π 堆积），再用力场做一次局部最小化
（受体固定，配体放松）会更稳。

## 交叉验证

单一方法的对接结果证据强度有限。有条件时做两路并比较：

```
DiffDock 盲对接 → 得到口袋位置
  → 用该口袋跑 Vina/Gnina → 得到独立的构象与打分
  → 两者构象 RMSD < 2 Å ⇒ 相互支持
  → 差别大 ⇒ 如实报告不确定，不要只挑一个讲
```

有实验结构（同源 holo、共晶）时，把它作为参照算 RMSD，这是最强的验证。

## 验证清单

- [ ] 受体：去水、保留结构性金属与辅因子、补全侧链、预测结构已 relax
- [ ] 配体：pH 7.4 质子化、**手性显式写明**、互变异构体选定并记录
- [ ] `samples_per_complex` ≥ 40
- [ ] 看了 top-5 的空间聚集程度，不只看 rank1 分数
- [ ] **PoseBusters 全项通过**才进入下游
- [ ] 没有把 confidence 当亲和力、没有跨复合物比较 confidence
- [ ] 有条件时做了与 Vina/Gnina 或实验结构的交叉验证
- [ ] 版本记录：DiffDock 版本、权重、RDKit 版本、seed

## 存成制品

存：处理后的受体 PDB、准备好的配体 SDF（含质子化与手性）、全部候选构象、confidence 表、
**PoseBusters 完整结果表**、交叉验证结果、完整命令行。

受体与配体的**准备后文件**必须存，不能只存原始 PDB/SMILES——准备过程里的每个决定
（去哪个水、怎么质子化、选哪个互变异构体）都会改变结果，而这些决定只体现在准备后的文件里。
