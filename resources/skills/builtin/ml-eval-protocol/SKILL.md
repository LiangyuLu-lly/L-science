---
slug: ml-eval-protocol
name: 机器学习评估规范
version: 1.0.0
---

# 机器学习评估规范

生理信号上的机器学习最常见的问题不是模型不够好，而是**评估协议有漏洞导致性能被高估**。
下面每一条都对应一种真实发生过、且能让 0.75 的准确率变成 0.95 的泄漏。

## 划分必须按被试

```python
from sklearn.model_selection import GroupKFold, StratifiedGroupKFold
cv = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=42)
for tr, te in cv.split(X, y, groups=subject_ids):
    ...
```

**同一个被试的样本绝不能同时出现在训练与测试集里。** 随机划分 epoch 会让模型学到
「这是谁的脑电」而不是「这是哪个睡眠期」——个体特征在 30 s epoch 上极强。这个泄漏
能把睡眠分期准确率从 0.80 抬到 0.95 以上，而所有指标看起来都正常。

同理：多夜记录要按**被试**分组而不是按夜；家庭/中心聚集的数据要按更高层级分组。

## 预处理必须在折内做

```python
from sklearn.pipeline import Pipeline
pipe = Pipeline([('scale', StandardScaler()), ('clf', LogisticRegression())])
scores = cross_val_score(pipe, X, y, groups=g, cv=cv)     # 正确
```

在全量数据上 `fit_transform` 之后再划分是泄漏：标准化用到了测试集的均值与方差。
同样适用于**特征选择、缺失值填补、重采样（SMOTE）、降维**。

**特征选择的泄漏尤其隐蔽**：先在全部数据上按与标签的相关性选出 100 个特征，
再做交叉验证——这一步已经把测试集的标签信息用掉了。必须放进 Pipeline。

## 超参数与最终评估要分开

嵌套交叉验证，或者干脆留出一个独立测试集：

```python
from sklearn.model_selection import GridSearchCV, cross_val_score
inner = GroupKFold(4); outer = GroupKFold(5)
search = GridSearchCV(pipe, param_grid, cv=inner)
nested = cross_val_score(search, X, y, groups=g, cv=outer)   # 无偏估计
```

**用交叉验证选超参数，然后报告同一个交叉验证的最佳分数，是乐观偏倚。** 报告的应该是
外层折的分数。做不到嵌套时至少留出一个从未参与任何决策的测试集，并且只在最后跑一次。

## 指标要匹配类别不平衡

睡眠分期里 N2 占 45%、N1 占 5%，准确率会被 N2 主导：

- **必报**：per-class 的精确率/召回率/F1，以及混淆矩阵。
- **总体指标**：macro-F1 或 Cohen's κ 而不是准确率。κ 校正了随机一致，在分期任务里是
  文献标准。
- **不平衡二分类**：报 AUPRC 而不只是 AUROC。AUROC 在负类极多时会给出虚高的印象。
- **阈值**：AUROC 是阈值无关的，但实际部署要选阈值。选阈值的依据（Youden、
  固定特异度、成本比）要写明，且阈值必须在训练集上选。

```python
from sklearn.metrics import classification_report, cohen_kappa_score, confusion_matrix
print(classification_report(y_true, y_pred, digits=3))
print(cohen_kappa_score(y_true, y_pred))
```

## 基线不可省略

必须给出的三个基线，否则读者无法判断模型是否真的学到了东西：

1. **多数类**（`DummyClassifier(strategy='most_frequent')`）。
2. **简单模型**：逻辑回归或浅决策树 + 少量手工特征。
3. **领域已有方法**：睡眠分期就是 YASA，HRV 分类就是既有的判别公式。

深度模型只比多数类好 5 个点却不给基线，是文献里的常见问题。

## 随机性

固定并报告所有种子：`random_state` / `torch.manual_seed` / `np.random.seed`。
**但单次运行的结果不能当结论**——报告多个种子（≥5）下的均值与标准差。
不同种子间差 3 个点的模型，与基线差 2 个点的「提升」没有意义。

## 报告模板

> 采用按被试分层的 5 折交叉验证（StratifiedGroupKFold，`random_state=42`），
> 训练集内嵌套 4 折用于超参数搜索。标准化与特征选择置于 Pipeline 内，
> 仅在训练折上拟合。5 个随机种子下 macro-F1 为 0.72 ± 0.03，Cohen's κ 为 0.68 ± 0.04；
> 多数类基线 macro-F1 为 0.12，YASA 为 0.69 ± 0.02。逐类指标与混淆矩阵见表 2。

## 存成制品

划分索引（哪些被试在哪一折）、Pipeline 定义、种子、每折的逐类指标、混淆矩阵图。
划分索引是可复现的关键——没有它，别人重跑得到的差异无法归因。
