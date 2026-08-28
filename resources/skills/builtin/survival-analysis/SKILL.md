---
slug: survival-analysis
name: 生存分析
version: 1.0.0
---

# 生存分析

## 什么时候用它而不是 t 检验

结局是「多久之后发生某事」，且**有些人没等到事件发生**。睡眠研究里的典型场景：

- 入睡潜伏期，但有人整夜没睡着（删失在记录时长处）。
- 首次 REM 出现时间，但有人整夜无 REM。
- 干预后失眠复发时间，随访结束时未复发。

**把删失当缺失删掉，或者把删失时间当事件时间，都会产生系统性偏倚。** 前者把「一直
没事」的人排除掉，剩下的全是发生了事件的人，估计出的时间偏短；后者把「至少 480 min」
当成「正好 480 min」，同样低估。这是必须用生存分析的唯一理由。

## 数据结构

两列：`time`（观察时长）与 `event`（1 = 事件发生，0 = 删失）。

```python
d = pd.DataFrame({'time': [12, 480, 35, 200], 'event': [1, 0, 1, 1], 'group': [...]})
```

**删失必须是「无信息删失」**：删失原因与事件风险无关。整夜未入睡而删失在记录结束处
是无信息的；因为「太痛苦而退出研究」造成的删失**不是**——退出与失眠严重程度相关，
此时 Kaplan-Meier 会低估风险。这条要在限制里明确讨论。

## Kaplan-Meier

```r
library(survival); library(survminer)
fit <- survfit(Surv(time, event) ~ group, data = d)
ggsurvplot(fit, risk.table = TRUE, conf.int = TRUE, pval = TRUE)
survdiff(Surv(time, event) ~ group, data = d)      # log-rank
```

```python
from lifelines import KaplanMeierFitter, CoxPHFitter
from lifelines.statistics import logrank_test
km = KaplanMeierFitter().fit(d['time'], d['event'])
km.median_survival_time_
logrank_test(t1, t2, e1, e2).p_value
```

报告要点：

- **中位生存时间而不是均值。** 有删失时均值不可估（曲线不降到 0），中位数可估。
  曲线没降到 0.5 时中位数也不可估，此时报告特定时点的生存率（如「480 min 内入睡的
  比例」）。
- **风险人数表（risk table）必须画在图下方。** 曲线尾部往往只剩两三个人，
  不给风险人数会让读者以为尾部的差异同样可信。
- log-rank 检验假定风险比恒定。曲线交叉时它检验力极低，此时用 Renyi 检验或限制
  平均生存时间（RMST）差异。

## Cox 模型

```r
cox <- coxph(Surv(time, event) ~ group + age + sex + ahi, data = d)
summary(cox)             # HR = exp(coef)
cox.zph(cox)             # 比例风险假设检验
```

- **HR 的解释是瞬时风险比，不是「快多少倍」。** HR=2 意味着任一时刻事件发生的瞬时
  风险翻倍，不等于时间减半。
- **比例风险假设必须检查并报告。** `cox.zph` 的全局 p 值显著说明假设不成立，
  Schoenfeld 残差图上应看到随时间的系统趋势。违反时的处理：分层（`strata()`）、
  加时间交互项、或改用 RMST/加速失效时间模型。
- **每个协变量至少需要 10 个事件**（不是 10 个样本）。20 个事件的数据里放 5 个协变量
  是过拟合，系数不可信。事件数少时优先减协变量而不是减样本。
- 重复事件（多次复发）用 Andersen-Gill 或带聚类稳健标准误的模型
  （`coxph(..., cluster = subject)`），别当独立事件。

## 竞争风险

存在会阻止目标事件发生的其他事件时（例如「因换药退出」阻止了「复发」），
Kaplan-Meier 会高估累积发生率。用累积发生函数（CIF）与 Fine-Gray 模型：

```r
library(cmprsk)
cuminc(d$time, d$status)                  # status: 0 删失, 1 目标事件, 2 竞争事件
crr(d$time, d$status, cov1 = d[, c('age')])
```

判断是否需要：**如果把竞争事件当删失处理在生理上说不通，就需要竞争风险模型。**

## 报告模板

> 入睡潜伏期采用 Kaplan-Meier 估计，未入睡者删失于记录结束（n=4，均在对照组）。
> 干预组中位潜伏期 18 min（95% CI [12, 27]），对照组 41 min（95% CI [29, 58]），
> log-rank χ²(1)=8.7，p=.003。Cox 模型校正年龄、性别与 AHI 后 HR=2.31
> （95% CI [1.32, 4.04]，p=.003）。比例风险假设经 Schoenfeld 残差检验未见违反
> （全局 p=.42）。

删失的人数与分组分布必须写出来——如果删失集中在一组，无信息删失假设就值得怀疑。
