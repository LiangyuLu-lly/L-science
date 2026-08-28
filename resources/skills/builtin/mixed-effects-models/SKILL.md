---
slug: mixed-effects-models
name: 混合效应模型
version: 1.0.0
---

# 混合效应模型

## 什么时候必须用

只要**同一个被试贡献了多个观测**就必须用，没有例外：多夜记录、多个通道、多个 epoch、
多个时间点、多个试次。

把它们当独立样本（直接 t 检验或方差分析）会让有效样本量被高估几十倍，p 值小到毫无意义。
这是睡眠与脑电研究里最常见的致命错误，也是审稿人最先查的一条。判断方法很简单：
**样本量写的是被试数还是观测数？** 如果统计里用的是观测数，就错了。

## 随机效应结构

```r
# R（lme4/lmerTest）——混合模型在 R 里的实现更成熟，优先用它
library(lmerTest)
m <- lmer(sw_density ~ group * night + age + sex + (1 + night | subject), data = d)
summary(m)
```

```python
# Python 回退：statsmodels 只支持单个分组因子且随机斜率支持有限
import statsmodels.formula.api as smf
m = smf.mixedlm('sw_density ~ group * night + age + sex', d,
                groups=d['subject'], re_formula='~night').fit()
```

**先按设计写最大随机效应结构，收敛不了再简化。** 常见简化顺序：
去掉随机斜率的相关项（`(1 + night || subject)`）→ 去掉随机斜率（`(1 | subject)`）。

**不要为了让 p 值变小而删随机效应。** 删掉随机斜率会让被试间斜率差异被算进残差，
固定效应的标准误偏小、p 值偏乐观。简化过程与最终结构都要写进论文。

## 收敛与奇异拟合

- `boundary (singular) fit`：某个随机效应方差估计为 0。多数情况说明数据不足以估计它，
  简化结构。不是错误，但要如实报告。
- 不收敛先做两件事：**连续预测变量中心化**（尤其是有交互项时）、**换优化器**
  （`control = lmerControl(optimizer = "bobyqa")`）。
- 观测数少于随机效应参数数量的十倍时，估计不可靠。

## p 值与自由度

混合模型的分母自由度没有唯一定义。三种常见做法：

- **Satterthwaite**（`lmerTest` 默认）：目前推荐，报告时写明。
- **Kenward-Roger**：小样本更保守，`pbkrtest` 提供。
- **似然比检验**：嵌套模型比较，`anova(m0, m1)`。注意比较固定效应时两个模型都要用
  **ML 而不是 REML** 拟合（`REML = FALSE`）。

statsmodels 的 `mixedlm` 用 Wald z 检验，小样本下偏乐观。样本量小于 30 个被试时优先用 R。

## 分布与链接

响应变量不是近似正态时用广义混合模型（`glmer`）：

- **计数**（事件个数）：Poisson；过度分散时用负二项（`glmer.nb`）。
  判据：残差偏差 / 自由度 明显大于 1。
- **比例/二分**（是否觉醒）：binomial。
- **右偏连续**（潜伏期、功率）：先取对数，或用 Gamma + log 链接。
  取对数之后系数解释成**乘性**效应，别按加性解释。

## 报告

必报四项，缺一项审稿人就会问：

1. **模型公式**（含随机效应结构，原样写出）。
2. **固定效应的估计、标准误、检验统计量、自由度、p 值**。
3. **效应量**：条件 R²、边际 R²（`performance::r2_nakagawa`），或标准化系数。
   只报 p 值无法判断实际意义。
4. **随机效应方差与 ICC**。ICC 告诉读者被试间差异占多少——它低于 0.05 时用混合模型的
   必要性需要说明，高于 0.5 时说明被试间差异主导，组间效应的解释要谨慎。

## 事后比较

交互项显著之后做简单效应分析，用 `emmeans`：

```r
library(emmeans)
emmeans(m, pairwise ~ group | night, adjust = "tukey")
```

`adjust` 必须给。多组两两比较不校正是 `multiple-comparisons` 里的问题，
但在混合模型里同样适用。

## 常见错误清单

- **在 epoch 级数据上跑模型但把 epoch 当独立观测**（忘了 `(1 | subject)`）。
- **把嵌套结构写成交叉结构**。多个通道嵌套在被试内是 `(1 | subject/channel)`，
  写成 `(1 | subject) + (1 | channel)` 假定通道是跨被试可比的固定集合——通道确实是，
  epoch 不是。
- **对每个通道各跑一次模型，然后报最显著的那个**。这是多重比较问题，见
  `multiple-comparisons`。
- **随机效应只放 subject 却忽略了 night**。三夜设计里夜次既是固定效应（顺序效应）
  也可能需要随机效应。
- **样本量报成观测数**。论文里的 N 必须是被试数，观测数单列。
