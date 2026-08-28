---
slug: scgpt
name: scGPT 单细胞基础模型
version: 1.0.0
---

# scGPT 单细胞基础模型

## 先回答一个前置问题：值得用吗

单细胞基础模型是否优于经典方法（`scvi-tools`、Harmony、scANVI）**目前仍有争议**。已有多项
独立评测得出的结论并不一致：在某些任务与数据集上基础模型更好，在另一些上经典方法持平
甚至更好，而零样本设置下的优势尤其不稳。

因此使用纪律是：**把它当候选方法之一，与经典基线并列评测，而不是当默认最优。**

具体到操作上，这意味着任何用 scGPT 得出的结论都要附一个经典基线的数字。做不到这一点的
分析在审稿时会被直接问住——「你怎么知道用 Harmony 不会一样好」是必然会被问的。

## 预处理必须与预训练一致

这是 scGPT 最容易出错的地方，而错了不会报错。

scGPT 把表达值分箱成离散 token，并使用**固定的基因词表**。如果你的预处理与预训练不一致，
模型看到的输入分布与它学过的不同，输出会平静地退化。

三条必须对齐：

```python
import scanpy as sc
from scgpt.tokenizer.gene_tokenizer import GeneVocab

adata = sc.read_h5ad('data.h5ad')

# 1) 基因标识符要与词表一致。词表用的是基因符号（HGNC symbol）
#    你的 var_names 是 Ensembl ID 的话必须先映射，否则命中率极低
vocab = GeneVocab.from_file('vocab.json')
adata.var['in_vocab'] = adata.var_names.isin(vocab.get_stoi().keys())
hit = adata.var['in_vocab'].mean()
print(f'词表命中率 {hit:.1%}')
assert hit > 0.5, '命中率过低，基因标识符类型可能不匹配（Ensembl vs symbol）'

# 2) 归一化流程按官方：CPM 归一化 → log1p → HVG 选择 → 分箱
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=1200, flavor='seurat_v3',
                            batch_key='batch')   # 有批次就传，避免选出批次驱动的基因
adata = adata[:, adata.var.highly_variable & adata.var.in_vocab].copy()

# 3) 分箱数必须与预训练一致（通常 51）。改了它就等于换了一套输入语言
N_BINS = 51
```

**词表命中率是第一个要看的数字。** 命中率低于 50% 基本可以断定标识符类型不对（最常见
是拿 Ensembl ID 去匹配 symbol 词表）。这时不要硬跑，先做映射：

```python
# 用 pybiomart / mygene 做 Ensembl → symbol 映射；映射不上的基因如实丢弃并记录数量
```

## 零样本嵌入

```python
from scgpt.tasks import embed_data

adata_emb = embed_data(
    adata_or_file=adata,
    model_dir='scGPT_human',
    gene_col='feature_name',      # 指向存基因符号的那一列
    batch_size=64,
    return_new_adata=True,
)
# 嵌入在 adata_emb.X 里
```

拿到嵌入之后走常规下游：邻居图、聚类、UMAP。**评测必须与基线并列**：

```python
import scanpy as sc, scib_metrics  # scib / scib-metrics 是这类评测的通用工具

for name, rep in [('scGPT', 'X_scgpt'), ('scVI', 'X_scvi'), ('PCA', 'X_pca')]:
    sc.pp.neighbors(adata, use_rep=rep)
    sc.tl.leiden(adata, key_added=f'leiden_{name}')
    # 报生物保留（ARI/NMI vs 已知标注、silhouette）与批次去除（kBET/iLISI）两类指标
```

单看批次去除会误导：把所有细胞混成一团的方法在批次指标上得满分。**必须同时报生物信号
保留**，这是单细胞整合评测的基本要求。

## 微调

零样本不够时微调。三个常见任务：细胞类型标注、批次整合、扰动预测。

```bash
python -m scgpt.tasks.cell_emb --help    # 具体入口随版本变化，先看官方示例
```

微调的纪律与 `ml-eval-protocol` 一致，但有两条单细胞特有的：

1. **切分要按样本/供体分组，不是按细胞随机切分。** 同一个供体的细胞高度相关，随机切分会
   把同一供体的细胞分到训练与测试两侧，测试指标严重虚高。用 `GroupKFold(groups=donor)`。
   这是单细胞机器学习里最普遍的泄漏形式。
2. **细胞类型标注任务里，测试集必须含训练集没有的细胞类型**，或者明确说明「只评估已知
   类型的分类」。不这么做的话，模型在遇到新类型时的行为（通常是强行归到某个已知类）
   完全没有被评估，而实际使用中一定会遇到。

## 扰动预测

scGPT 支持预测基因扰动后的表达变化。这里的评估标准要选对：

- 报**差异表达基因方向的准确率**与 top-k 基因的重合，而不只是整体表达谱的相关系数。
  整体相关系数会很高（因为大部分基因不变），那个数字没有信息量。
- 必须有**未见扰动**的测试集（训练时没出现过的靶基因），否则评估的是记忆。
- 与简单基线比较：「预测＝训练集里该扰动的平均效应」以及「预测＝不变」。基础模型跑不过
  这两个基线的情况并不罕见，如实报告。

## 验证清单

- [ ] 词表命中率检查过并记录；标识符类型（symbol/Ensembl）明确
- [ ] 归一化流程与官方一致（CPM → log1p → HVG → 分箱），分箱数与预训练一致
- [ ] HVG 选择时传了 `batch_key`
- [ ] **与经典基线并列评测**（scVI / Harmony / PCA 至少一个）
- [ ] 整合评测同时报了批次去除与生物信号保留
- [ ] 微调切分**按供体/样本分组**，不是按细胞随机切分
- [ ] 细胞类型标注评估考虑了未见类型
- [ ] 扰动预测有未见扰动测试集，且与平凡基线比较过
- [ ] 版本记录：scgpt 版本、权重目录名、scanpy 版本、随机种子

## 存成制品

存：预处理后的 AnnData（含词表命中标记）、嵌入矩阵、**基线与 scGPT 的评测对照表**、
UMAP 图、切分清单（哪些供体在哪一折）、权重与版本。

那张**对照表是这个技能的核心产物**。没有它，「用了基础模型」这件事在方法学上无法评价，
而它恰恰是这类分析最会被质疑的一点。
