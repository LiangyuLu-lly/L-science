---
slug: scvi-tools
name: scvi-tools 概率单细胞建模
version: 1.0.0
---

# scvi-tools 概率单细胞建模

## 选哪个模型

| 模型 | 任务 |
| --- | --- |
| **scVI** | 无监督批次整合 + 潜表示。最常用的起点 |
| **scANVI** | 有部分细胞标注时的半监督整合 + 标签迁移 |
| **totalVI** | CITE-seq（RNA + 蛋白）联合建模 |
| **PeakVI** | scATAC |
| **MultiVI** | 多组学（RNA + ATAC）配对或非配对 |
| **DestVI / Stereoscope** | 空间转录组去卷积 |
| **scArches**（配合上述） | 把新数据映射到已训练的参考模型上，不重训 |

## 第一条硬要求：输入必须是原始计数

scVI 家族建模的是计数分布（负二项/零膨胀负二项）。喂进归一化或 log 变换后的数据，
模型假设就不成立了——而**它不会报错**，只会给出一个看起来正常但错误的潜空间。

这是这个技能里最重要的一条。防它的方式是显式检查：

```python
import numpy as np, scanpy as sc, scvi

adata = sc.read_h5ad('data.h5ad')

# 原始计数必须是非负整数。这个断言要写进流程，不要靠记忆
X = adata.X
vals = X.data if hasattr(X, 'data') else X
assert vals.min() >= 0, '出现负值，这不是计数'
assert np.allclose(vals, np.round(vals)), '不是整数，输入很可能已被归一化或 log 过'

# 习惯做法：把原始计数留在 layers 里，让 .X 可以随便被下游改
adata.layers['counts'] = adata.X.copy()
```

之后所有 `setup_anndata` 都显式指向那一层：

```python
scvi.model.SCVI.setup_anndata(
    adata,
    layer='counts',                      # 显式指定，不依赖 .X 当前是什么
    batch_key='batch',
    categorical_covariate_keys=['donor', 'chemistry'],
    continuous_covariate_keys=['pct_mito'],
)
```

## 协变量怎么设

- **`batch_key`**：技术批次。模型会把它的效应吸收掉。
- **`categorical_covariate_keys`**：其他要校正的离散因素（供体、建库化学、测序批）。
- **`continuous_covariate_keys`**：连续混杂（线粒体比例、检测基因数）。

一条关键取舍：**不要把生物学变量放进协变量**。把疾病状态或处理组放进 `batch_key`，
模型会把你真正想研究的信号当噪声消掉，然后你会得到一个「组间没有差异」的干净结果。

供体与疾病状态共线时（每个供体只属于一组）这个问题无解——那是实验设计的限制而不是分析
问题，必须在方法里写明，不能靠调协变量绕过。

## 训练

```python
model = scvi.model.SCVI(adata, n_latent=30, n_layers=2, gene_likelihood='nb')
model.train(max_epochs=None, early_stopping=True)     # None 让它按细胞数自动定
adata.obsm['X_scvi'] = model.get_latent_representation()
```

- `gene_likelihood`：`'nb'` 是默认且通常够用。`'zinb'` 只在确实有大量技术零时才有帮助
  （10x 数据上多数情况 `nb` 更稳）。
- `n_latent`：10-30。这个数不敏感，不必调。
- **看训练曲线**。不看的话过拟合与欠拟合都发现不了：
  ```python
  import matplotlib.pyplot as plt
  h = model.history
  plt.plot(h['elbo_train']['elbo_train'], label='train')
  plt.plot(h['elbo_validation']['elbo_validation'], label='validation')
  plt.legend(); plt.xlabel('epoch'); plt.ylabel('ELBO')
  ```
  验证 ELBO 明显上翘就是过拟合，降低 `n_latent` 或加 `dropout_rate`。

## 整合效果怎么评——不能看 UMAP

**UMAP 上批次混在一起不是整合成功的证据。** 任何足够强的校正都能把批次混匀，包括那些
连细胞类型一起抹掉的。反过来，UMAP 上还分得开也不一定是失败——可能那两个批次真的含
不同的细胞组成。

要用定量指标，且**必须同时报两类**：

```python
# scib-metrics 是这类评测的通用工具
from scib_metrics.benchmark import Benchmarker

bm = Benchmarker(
    adata,
    batch_key='batch',
    label_key='cell_type',
    embedding_obsm_keys=['X_pca', 'X_scvi', 'X_harmony'],   # 并列比较
)
bm.benchmark()
bm.plot_results_table()
```

- **批次去除**：kBET、iLISI、图连通性
- **生物保留**：ARI、NMI、cLISI、细胞类型 silhouette

只报第一类是最常见的误导。把两类并列，再与 PCA（不校正）和至少一个其他方法并列，
读者才能判断这次整合是不是过度校正了。

## 差异表达与伪重复——这一节决定统计结论能否成立

scvi-tools 提供后验采样式的差异表达：

```python
de = model.differential_expression(groupby='cell_type', group1='B cell', group2='T cell')
de = de[(de['is_de_fdr_0.05']) & (de['lfc_mean'].abs() > 0.5)]
```

这适合**细胞类型之间**的比较。但研究里更常问的是**组间**比较（患者 vs 对照），
而这里有一个会让整篇文章的统计站不住的陷阱：

**把细胞当独立样本是伪重复。** 一个供体贡献几千个细胞，把这几千个细胞当几千个独立观测，
样本量被人为放大了三个数量级，于是任何微小差异都「显著」。p 值会小到 1e-50 这种量级，
而真实的独立单位是**供体**，n 可能只有 6 对 6。

正确做法是**伪批量（pseudobulk）**：

```python
import pandas as pd, numpy as np

# 按 (供体, 细胞类型) 聚合原始计数，得到伪批量矩阵
counts = adata.layers['counts']
key = adata.obs[['donor', 'cell_type']].astype(str).agg('|'.join, axis=1)
pb = pd.DataFrame(index=sorted(key.unique()), columns=adata.var_names, dtype=float)
for k, idx in key.groupby(key).groups.items():
    rows = adata.obs_names.get_indexer(idx)
    pb.loc[k] = np.asarray(counts[rows].sum(axis=0)).ravel()

# 之后走 bulk RNA-seq 的成熟流程（DESeq2 / edgeR / limma-voom），
# 设计矩阵里 n = 供体数，并把每个伪批量的细胞数作为权重或过滤依据
```

伪批量的三条细节：

1. **细胞数太少的 (供体, 细胞类型) 组合要丢掉**（常用阈值 10-20 个细胞），否则计数噪声
   压倒信号。丢弃规则要记录。
2. **聚合用原始计数求和**，不是归一化值求平均。
3. 报告时明确写出 **n 是供体数**，并给出每组供体数与细胞数。

模型内的 DE 与伪批量各有位置：细胞类型标记基因用前者，组间比较用后者。混用会让结论
在最基本的统计层面被推翻。相关统计设计见 `mixed-effects-models` 与 `multiple-comparisons`。

## 标签迁移与参考映射

```python
scvi.model.SCANVI.setup_anndata(adata, layer='counts', batch_key='batch',
                                labels_key='cell_type', unlabeled_category='Unknown')
sc_model = scvi.model.SCANVI.from_scvi_model(model, unlabeled_category='Unknown')
sc_model.train(max_epochs=20, n_samples_per_label=100)
adata.obs['pred'] = sc_model.predict()
adata.obs['pred_conf'] = sc_model.predict(soft=True).max(axis=1)
```

**必须报告预测置信度分布并设阈值**。低置信细胞标成 `Unknown` 而不是硬分到某一类——
参考图谱里没有的细胞类型一定存在，强行归类会造出一批不存在的细胞群然后被当成发现。

## 验证清单

- [ ] 输入是**原始计数**，断言过非负整数，且存在 `layers['counts']`
- [ ] `setup_anndata` 显式指定了 layer
- [ ] 生物学变量**没有**被当成 batch 或协变量
- [ ] 供体与分组共线时已在方法里写明该限制
- [ ] 看了训练/验证 ELBO 曲线
- [ ] 整合评测同时报了批次去除与生物保留，并与 PCA 及其他方法并列
- [ ] 没有把 UMAP 的混匀程度当作整合成功的证据
- [ ] **组间差异表达走伪批量**，n 是供体数，且记录了细胞数过滤阈值
- [ ] 标签迁移报了置信度分布并对低置信设了 `Unknown`
- [ ] 随机种子固定（`scvi.settings.seed = 0`）并记录
- [ ] 版本记录：scvi-tools、scanpy、anndata、torch

## 存成制品

存：预处理后的 AnnData（含 counts 层与潜表示）、训练曲线、**整合评测对照表**、
伪批量矩阵与设计矩阵、DE 结果表、模型 checkpoint（`model.save()`）、种子与版本。

伪批量矩阵与设计矩阵要单独存：它们是组间结论的直接输入，而从 AnnData 重算需要复现
一整套聚合与过滤规则。
