---
slug: boltz-2
name: Boltz-2 复合物与亲和力预测
version: 1.0.0
---

# Boltz-2 复合物与亲和力预测

## 它比 AlphaFold2 多了什么

两件事，都是 AF2 结构上做不到的：

1. **配体、核酸、修饰残基在同一个预测里**。AF2 给的是 apo 形态（见 `alphafold2` 第 4 条
   陷阱）；Boltz-2 是共折叠（co-folding），配体与蛋白一起被预测，口袋会因配体而调整。
2. **结合亲和力预测**。同一次前向给出一个亲和力标量，不需要另外跑打分函数。

代价是：结构精度在**纯蛋白单体**上没有优势，而亲和力预测有很强的适用边界（下面单独讲）。

## 输入是 YAML，不是 FASTA

这是与 AF2 最直观的差别。一个蛋白 + 一个小分子：

```yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: MKVLWAALLVTFLAGCQAKVEQAVETEPEPELRQQTEWQSGQRWELALGRFWDYLRWVQTLS
  - ligand:
      id: L
      smiles: 'CC(=O)Oc1ccccc1C(=O)O'
properties:
  - affinity:
      binder: L
```

要点：

- `id` 是链标识，配体也要有。`properties.affinity.binder` 指向配体的 `id`，**不写这一段
  就不会输出亲和力**。
- 配体可以用 `smiles` 或 `ccd`（PDB 化学组分词典三字母码，如 `ATP`、`HEM`）。已知辅因子
  用 `ccd` 更稳——SMILES 写错手性不会报错，只会给出一个错的结构。
- 同聚体写多条 `protein` 条目共用同一 `sequence`，`id` 不同。
- 核酸用 `dna` / `rna` 键。
- 修饰残基与共价连接用 `modifications` / `constraints`，写法见官方 schema；需要时用
  `load_skill_reference` 取。

```bash
boltz predict input.yaml \
  --use_msa_server \
  --diffusion_samples 5 \
  --recycling_steps 3 \
  --output_format mmcif
```

- `--use_msa_server`：**会联网**（MSA 走远端），出口代理会拦下来要审批。离线要自己备
  a3m 并在 YAML 里用 `msa:` 指定。
- `--diffusion_samples`：扩散采样数。默认 1，**实际至少给 5**。它是这里的「跑五个模型」
  ——单个样本没有一致性判据。
- `--recycling_steps`：与 AF2 的 recycle 同理，难目标提到 10 上下。

## 置信度与亲和力的读法

结构侧输出 `confidence_*.json`，里面：

- `confidence_score`：综合分，粗看用
- `ptm` / `iptm`：与 AF2 同义；复合物看 `iptm`
- `complex_plddt`、`chains_ptm`、`pair_chains_iptm`：逐链与链对的分解。**判断某个界面
  是否可信要看 `pair_chains_iptm` 里对应的那一对**，不是看全局 `iptm`——三链复合物里
  A-B 界面很好而 A-C 完全错，全局分仍可能过得去
- `ligand_iptm`：配体位置的可信度。它低就意味着**结合模式不可信**，此时亲和力数值也不必看了

亲和力侧输出 `affinity_*.json`：

- `affinity_pred_value`：以 `log10(IC50 [µM])` 为刻度的标量。**越小越强**
- `affinity_probability_binary`：是不是结合物的概率

换算与解读：

```python
import json
aff = json.load(open('predictions/target/affinity_target.json'))
log_ic50_uM = aff['affinity_pred_value']
ic50_uM = 10 ** log_ic50_uM
pic50 = 6 - log_ic50_uM          # pIC50 = -log10(IC50 [M])
print(f'IC50 ≈ {ic50_uM:.3g} µM，pIC50 ≈ {pic50:.2f}，'
      f'是结合物的概率 {aff["affinity_probability_binary"]:.2f}')
```

## 亲和力预测的边界——这一节决定结论能不能写

**它能做的**：在**同一个靶点**上给一组配体排序。这是它被训练来做的事，也是虚拟筛选里
真正需要的能力。

**它不能做的，逐条**：

1. **不能当绝对值报。** 「预测 IC50 为 3.2 µM」这句话不该出现在论文里。误差量级在
   1 个 log 单位上下，而且随化学空间漂移。要报就报排序与相对关系。
2. **不能跨靶点比较。** 靶点 X 上预测 -1.0 与靶点 Y 上预测 -1.5 之间没有可比性。
3. **不能外推到训练分布之外的化学型。** 共价抑制剂、金属螯合剂、大环、多肽、PROTAC
   这类，预测值基本不可用。先确认你的配体属于常规类药小分子。
4. **结合模式不可信时亲和力无意义。** 先看 `ligand_iptm`，它低就停下。
5. **不能替代实验。** 它筛掉明显不行的，不确认行的。

排序质量要用你自己的数据核验，而不是引用论文里的相关系数：

```python
from scipy.stats import spearmanr
# 手上有已测活性的化合物就先跑一遍，看排序相关性
rho, p = spearmanr(pred_log_ic50, measured_log_ic50)
print(f'Spearman ρ = {rho:.2f}（n={len(pred_log_ic50)}）')
```

ρ 低于 0.4 时这个靶点上的预测不足以支撑筛选决策，要如实说出来。

## 与同类的取舍

| 需求 | 用 |
| --- | --- |
| 纯蛋白单体/复合物，要最稳的结构 | `alphafold2` |
| 蛋白 + 配体共折叠 + 亲和力 | Boltz-2 |
| 蛋白 + 配体，偏向多模态输入与约束 | `chai-1` |
| 要 AF3 级别的开源复现、含核酸与修饰 | `openfold3` |
| 已有 holo 口袋、只要摆配体 | `diffdock`（对接，不重折蛋白） |

## 验证清单

- [ ] `diffusion_samples` ≥ 5，且样本间结合模式一致
- [ ] 看的是 `pair_chains_iptm` 里对应界面那一对，不是全局 iptm
- [ ] `ligand_iptm` 达标后才使用亲和力数值
- [ ] 亲和力只用于同靶点排序，没有当绝对值写进结论
- [ ] 配体化学型在常规类药空间内；否则已注明限制
- [ ] 有实测数据的话跑过 Spearman 核验，并报了 n 与 ρ
- [ ] 版本记录：boltz 版本、权重版本、MSA 来源与日期

## 存成制品

存：YAML 输入、全部采样的 mmCIF、`confidence_*.json`、`affinity_*.json`、完整命令行、
以及（若做了）排序核验的表与图。YAML 是这一步唯一的完整输入声明——化学计量、配体
SMILES、约束全在里面，丢了它这次预测无法复现。
