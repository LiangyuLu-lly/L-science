---
slug: power-analysis
name: 样本量与检验力分析
version: 1.0.0
---

# 样本量与检验力分析

## 先验估算

```python
from statsmodels.stats.power import TTestIndPower
n = TTestIndPower().solve_power(effect_size=0.6, alpha=0.05, power=0.8,
                                alternative='two-sided')
# 每组约 45 人
```

四个量里给三个求第四个：效应量、α、检验力、样本量。惯例 α=0.05、power=0.80，
但 0.90 在需要下明确结论时更合适——0.80 意味着即便效应真实存在也有 20% 概率错过。

## 效应量从哪来

这是整个估算里最关键也最容易糊弄的一步。按可靠性排序：

1. **同一实验室的预试验或既有数据**（最可靠，但要用置信区间下界而不是点估计——
   小样本预试验的效应量系统性偏大）。
2. **同类研究的元分析**（比单篇文献可靠得多）。
3. **临床/实践上的最小重要差异**（MCID）。这是最有说服力的论证方式：
   「我们要能检出 15 min 的 TST 差异，因为这是文献认定有临床意义的阈值」。
4. **单篇发表文献的效应量**（最不可靠：发表偏倚让已发表的效应量系统性偏大，
   小样本研究尤甚）。

**不要用「中等效应量 d=0.5」这种约定值当论证。** 它等于说「我不知道要检出多大的效应」，
审稿人会直接指出来。要用就明确写成「在缺乏先验信息的情况下，我们以 d=0.5 为最小可
检出效应」，并承认这是任意选择。

## 常见检验的估算

```python
from statsmodels.stats.power import (TTestIndPower, TTestPower, FTestAnovaPower)

TTestIndPower().solve_power(effect_size=0.6, alpha=.05, power=.8)   # 独立样本 t
TTestPower().solve_power(effect_size=0.5, alpha=.05, power=.8)      # 配对 t（d_z）
FTestAnovaPower().solve_power(effect_size=0.25, alpha=.05, power=.8, k_groups=3)  # 单因素方差
```

**配对设计用的是 d_z（差值的标准化效应量），不是组间 d。** 两者关系依赖相关系数：
`d_z = d / sqrt(2(1-r))`。相关性高时配对设计的检验力优势很大——把组间 d 直接代进
配对公式会严重低估所需样本量，或者说高估了检验力。

比例比较、相关系数、logistic 回归用 `statsmodels.stats.power` 里对应的类；
生存分析用 log-rank 的 Freedman 公式（事件数比样本量更关键）。

## 重复测量与混合模型：用模拟

多层设计没有干净的解析公式。**模拟法是标准做法**：

```r
library(simr)
m <- lmer(y ~ group * night + (1 | subject), data = pilot)
fixef(m)["groupB:night"] <- 0.3          # 设定要检出的效应
powerSim(m, nsim = 500)                  # 得到检验力
powerCurve(m, along = "subject", nsim = 200)   # 样本量曲线
```

自己写模拟的骨架：

```python
def simulate_once(n_subj, n_nights, effect, sd_between, sd_within, rng):
    subj = rng.normal(0, sd_between, n_subj)[:, None]
    y0 = subj + rng.normal(0, sd_within, (n_subj, n_nights))
    y1 = subj + effect + rng.normal(0, sd_within, (n_subj, n_nights))
    # 拟合混合模型，返回该效应的 p 值
    ...

power = np.mean([simulate_once(...) < 0.05 for _ in range(1000)])
```

**关键参数是被试间方差与被试内方差的比例（ICC）**，不是总方差。ICC 高时增加每人的
夜数收益很小，增加人数才有效；ICC 低时反之。这个判断只能靠预试验数据或文献里的 ICC。

## 事后检验力分析：不要做

结果不显著之后计算「我们的检验力是多少」是无效的推论。原因：用观测到的效应量算出的
检验力与 p 值是一一对应的（p 刚过 0.05 时事后检验力必然约 50%），它没有提供任何
p 值之外的信息。

**替代做法**：报告效应量的置信区间。「差异为 3 min（95% CI [−12, 18]）」直接告诉读者
「我们排除不了 18 min 的差异」，这比任何事后检验力数字都有用。

需要正式的「我们排除了多大效应」时用**等效性检验**（TOST）：

```python
from statsmodels.stats.weightstats import ttost_ind
p, lower, upper = ttost_ind(x1, x2, low=-0.5, upp=0.5, usevar='unequal')
```

等效界（`low`/`upp`）必须在看数据之前定好并有实质依据。

## 报告模板

> 以 α=0.05、双侧、检验力 0.80 为目标，基于 Smith 等（2021）元分析报告的组间 Hedges'g
> = 0.62（95% CI [0.41, 0.83]）的下界 0.41 估算，每组需 95 人。考虑 15% 脱落，
> 计划每组纳入 110 人。估算使用 statsmodels {版本} 的 TTestIndPower。

用置信区间下界而不是点估计，是这段里最重要的一处——它让样本量估算对预试验的乐观偏差
稳健。把估算代码存成制品。
