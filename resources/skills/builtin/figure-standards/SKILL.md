---
slug: figure-standards
name: 图表规范
version: 1.0.0
---

# 图表规范

## 出图前的两个决定

**1. 这张图要让读者看出什么？** 一张图一个论点。同时想展示三件事的图，读者一件都看不出。

**2. 数据分布长什么样？** 决定用哪种图：

| 数据 | 用 | 不要用 |
|---|---|---|
| 小样本（n<30）的组间比较 | 点图 + 中位数与 IQR，或雨云图 | 柱状图 + 误差棒 |
| 配对/重复测量 | 连线的配对图 | 两个独立的柱子 |
| 分布形状重要 | 小提琴图 / 密度图 | 均值 ± SD |
| 大样本相关 | 散点 + 拟合线 + 置信带 | 只给 r 值 |
| 时间序列 | 折线 + 阴影置信带 | 带误差棒的折线（视觉拥挤） |

**柱状图 + 误差棒（"dynamite plot"）在小样本上应避免**：它隐藏了分布形状与样本量，
四种完全不同的分布能画出相同的柱子。多数高影响期刊现在明确要求展示单个数据点。

## matplotlib 设置

```python
import matplotlib
matplotlib.use('Agg')                # 无头环境必须
import matplotlib.pyplot as plt

plt.rcParams.update({
    'figure.dpi': 300,               # 位图投稿要求通常 ≥300 dpi
    'savefig.dpi': 300,
    'font.size': 8,                  # 期刊单栏图里 8 pt 约等于印刷 8 pt
    'axes.labelsize': 8,
    'axes.titlesize': 9,
    'xtick.labelsize': 7,
    'ytick.labelsize': 7,
    'legend.fontsize': 7,
    'axes.spines.top': False,        # 去掉上右边框，减少视觉噪声
    'axes.spines.right': False,
    'savefig.bbox': 'tight',
    'savefig.transparent': False,     # 透明背景在某些排版系统里变黑
})
```

**尺寸按目标期刊的栏宽定**，不要出完图再缩放——缩放会让字号变得不可读：

```python
SINGLE_COL_IN = 3.5      # 约 89 mm，多数期刊单栏
DOUBLE_COL_IN = 7.2      # 约 183 mm，双栏
fig, ax = plt.subplots(figsize=(SINGLE_COL_IN, 2.6))
```

## 颜色

- **不要只靠颜色区分类别。** 同时用形状（marker）、线型或直接标注。
  约 8% 的男性有红绿色觉障碍，而且期刊常常灰度印刷。
- 用色觉友好的配色：`viridis`（连续）、`cividis`（连续、灰度友好）、
  Okabe-Ito 或 `tab10`（分类）。**避免 `jet`/`rainbow`**：它的亮度不单调，
  会在数据里造出不存在的边界。
- 出图后做灰度检查：

```python
# 转成灰度看是否还能区分
from PIL import Image
Image.open('fig.png').convert('L').save('fig_gray.png')
```

## 必备元素

- **坐标轴标签带单位**（`慢波活动 (µV²/Hz)`）。无单位的轴是最常见的返修意见。
- **纵轴从 0 开始**，除非有充分理由不这样做且在图注说明。截断纵轴会放大差异，
  是误导性图表的头号手法。
- **误差棒说明是什么**（SD / SEM / 95% CI）在图注里写清。三者含义不同，
  不写等于没给。
- **样本量**标在图上或图注里。
- **显著性标记**要说明检验与校正方法，`*` 的含义在图注里定义。
  不要在图上标 `***` 而不给具体 p 值。

## 图注

图注要能独立读懂，包含：做了什么、n 是多少、误差棒是什么、统计检验与校正、
缩写全称。**图注不是标题**，通常 3-6 句。

```
图 2. 干预组与对照组的慢波活动。(A) 逐夜的 SWA（0.5-4.5 Hz，C3-M2，N2+N3 期）。
点为个体值，横线为中位数，须为 IQR。(B) 组间差异的效应量与 95% 置信区间。
干预组 n=22，对照组 n=22。p 值来自混合效应模型（被试为随机截距），
经 Holm 校正（6 次比较）。SWA = slow wave activity。
```

## 格式

- **矢量优先**：PDF 或 EPS（线图、散点）。放大不失真，多数期刊偏好。
- **位图**用于含大量数据点或图像的图（谱图、地形图）：TIFF 或 PNG，≥300 dpi
  （含文字的图有的期刊要 600 dpi）。
- **不要交 JPEG**：有损压缩会在线条边缘产生振铃。
- 同时保存 PDF 与 PNG：PDF 投稿，PNG 用于预览与内部沟通。

## 血缘

**每张图保存时必须带上生成它的代码与输入数据版本**：

```python
save_artifacts(paths=['fig2_swa.pdf', 'fig2_swa.png'],
               code=plot_code, language='python',
               inputVersionIds=[stats_table_version_id])
```

没有代码的图是不可复现的，Reviewer 会为此开发现。审稿人问「这张图里的中位数是怎么算的」
时，代码就是答案。这也是修图时能保证「换了配色但数据没变」的唯一依据。

## 自查

- 灰度下能区分各组吗？
- 字号在实际印刷尺寸下可读吗（≥6 pt）？
- 轴标签有单位吗？
- 误差棒的含义写了吗？
- 纵轴截断了吗，说明了吗？
- 图注能独立读懂吗？
- 代码与输入版本存进血缘了吗？
