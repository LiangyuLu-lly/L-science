---
slug: table-standards
name: 表格规范
version: 1.0.0
---

# 表格规范

## 什么时候用表而不是图

- 需要**精确数值**（读者要拿去做元分析）。
- 变量多、每个变量的观测少（图会拥挤）。
- 分类信息（纳入排除、各研究特征）。

需要展示**趋势、分布或关系**时用图。同一份数据既出表又出图是冗余，
除非表放补充材料。

## 表 1：基线特征

```python
import pandas as pd

def describe(df, group_col, cont_vars, cat_vars):
    rows = []
    for v in cont_vars:
        r = {'变量': v}
        for g, sub in df.groupby(group_col):
            # 偏态变量用中位数 + IQR，而不是均值 ± SD
            if abs(sub[v].skew()) > 1:
                r[g] = f'{sub[v].median():.1f} ({sub[v].quantile(.25):.1f}–{sub[v].quantile(.75):.1f})'
            else:
                r[g] = f'{sub[v].mean():.1f} ± {sub[v].std():.1f}'
        rows.append(r)
    for v in cat_vars:
        for level, _ in df.groupby(v):
            r = {'变量': f'{v} = {level}'}
            for g, sub in df.groupby(group_col):
                n = (sub[v] == level).sum()
                r[g] = f'{n} ({100 * n / len(sub):.1f}%)'
            rows.append(r)
    return pd.DataFrame(rows)
```

**不要对基线特征做组间显著性检验。** 这条在方法学文献里已有明确共识
（CONSORT 也不要求），理由：

- 随机化成功的定义不是「基线 p>0.05」。随机试验里基线差异按定义就是随机的，
  对它做检验在逻辑上没有对应的零假设。
- 检验力低时「p>0.05」被误读为「组间可比」，而实际可能存在临床上重要的失衡。
- 一堆基线变量各做一次检验是典型的多重比较问题。

**正确做法**：报告描述统计与**标准化差异**（standardized mean difference，
|SMD| > 0.1 视为需要关注），让读者自己判断失衡程度。

```python
def smd(a, b):
    pooled = np.sqrt((a.var(ddof=1) + b.var(ddof=1)) / 2)
    return (a.mean() - b.mean()) / pooled if pooled > 0 else 0.0
```

## 结果表

- 一行一个比较或一个模型项，一列一个统计量。
- **必列**：估计值、离散度（SE 或 CI）、检验统计量、自由度、p 值、效应量。
- 多重比较校正后的 p 值单列，列头写明校正方法（`p_Holm`）。
- 缺失值用 `—` 而不是留空——留空无法区分「没有这一项」与「忘了填」。

## 格式

**三线表**（顶线、表头下横线、底线，无纵线）是学术表格的通行样式。
不要加纵向框线与斑马纹。

- 数值**按小数点对齐**。
- **有效位数与测量精度一致**且列内统一。TST 写 `342` 不写 `342.7183`；
  p 值三位小数；效应量两位。
- 单位放在列头（`TST (min)`）而不是每个单元格里重复。
- 表格标题在**上方**（图注在下方，这两者相反是排版惯例）。

## 表注

按顺序：整体说明 → 数值格式说明 → 缩写全称 → 显著性标记定义。

```
表 1. 基线人口学与睡眠特征。
数值为均值 ± 标准差，偏态变量为中位数（四分位距），分类变量为 n（%）。
SMD = 标准化均值差；|SMD| > 0.1 提示组间失衡。
AHI = 呼吸暂停低通气指数；ISI = 失眠严重程度指数；TST = 总睡眠时间。
按方法学建议未对基线特征做组间显著性检验。
```

最后那一句值得写——不写的话审稿人可能会要求补基线检验，写了就省一轮往返。

## 导出

```python
# LaTeX（booktabs 三线表）
df.to_latex('table1.tex', index=False, escape=False,
            column_format='lrrr', float_format='%.2f')

# Word/Excel 投稿
df.to_excel('table1.xlsx', index=False)

# Markdown 用于内部审阅
print(df.to_markdown(index=False))
```

LaTeX 需要 `\usepackage{booktabs}`，`to_latex` 默认已生成 `\toprule`/`\midrule`/`\bottomrule`。

## 血缘

表格与图一样，保存时带上生成代码与输入数据版本。表 1 里的每个数都应能追溯到
原始数据的某一列——审稿人问「这个中位数含不含那两个被排除的被试」时，代码是唯一答案。
