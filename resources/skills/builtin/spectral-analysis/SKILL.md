---
slug: spectral-analysis
name: 频谱分析
version: 1.0.0
---

# 频谱分析

## 选方法

| 目的 | 方法 | 理由 |
|---|---|---|
| 稳态功率（整夜、某一睡眠期） | Welch | 分段平均降低方差，实现简单 |
| 时间分辨（谱图、事件前后） | 多窗（multitaper）或短时傅里叶 | 时频权衡可控 |
| 窄带峰值定位（纺锤波频率） | 多窗 | 频率分辨率与方差的折中更好 |
| 非正弦成分、1/f 背景 | 先拟合并去除 1/f，再看残差 | 见下文 |

```python
from mne.time_frequency import psd_array_welch
psd, freqs = psd_array_welch(data, sfreq=sf, fmin=0.5, fmax=35,
                             n_fft=int(4 * sf), n_overlap=int(2 * sf))
```

`n_fft = 4 * sf` 给出 0.25 Hz 的频率分辨率，足够分开 δ 与 θ。取 `n_fft = sf`（1 s 窗）
只有 1 Hz 分辨率，δ 频段（0.5-4 Hz）里只剩三四个点，band power 会很不稳。

## 单位与标度

- Welch 给的是 **功率谱密度**，单位 µV²/Hz（数据以 µV 计）。
- **band power 是 PSD 在频段上的积分，不是均值**。用 `np.trapz(psd[mask], freqs[mask])`。
  取均值得到的是「平均 PSD」，量纲不同，且频段宽度不同时不可比。
- 取对数（dB = 10·log10）之后才近似正态，做参数检验前一般要转。转换要在**统计之前、
  平均之前**做——先在线性尺度上跨被试平均，再取对数，会被少数高功率被试主导。

## 频段定义

频段边界没有唯一标准，**必须写明你用的是哪套**：

```python
BANDS = {'SWA': (0.5, 4.5), 'delta': (0.5, 4), 'theta': (4, 8),
         'alpha': (8, 12), 'sigma': (11, 16), 'beta': (16, 30)}
```

睡眠研究里 σ（纺锤波频段）常用 11-16 Hz，但 12-15 Hz 也常见；α 与 σ 有重叠，
在 N2 上分别报告这两个频段而不解释重叠，会让读者以为它们是独立的。

## 相对功率

相对功率 = 该频段功率 / 总功率。它能压掉个体间电极阻抗差异，但代价是**各频段不再独立**
——一个频段升高必然让其他频段的相对值下降。因此：

- 报告相对功率时必须同时报告绝对功率，否则「β 相对功率下降」可能只是「δ 绝对功率上升」。
- 不要对全部频段的相对功率各做一次检验然后校正——它们的和恒为 1，自由度比看起来少。

## 1/f 背景

脑电功率谱是「1/f 背景 + 窄带峰」的叠加。传统 band power 把两者混在一起，于是
「θ 功率升高」可能只是背景斜率变了。要区分就用参数化分解：

```python
# specparam（原 fooof）：拟合 1/f 后分离出振荡峰
from specparam import SpectralModel
sm = SpectralModel(peak_width_limits=[1, 8], max_n_peaks=6)
sm.fit(freqs, psd)
sm.get_params('aperiodic_params')   # 偏移与斜率
sm.get_params('peak_params')        # 中心频率、幅度、带宽
```

没装 specparam 时至少在讨论里承认这个混淆，不要把 band power 的变化直接解释成振荡变化。

## 整夜谱图

```python
from mne.time_frequency import psd_array_multitaper
# 逐 30 s epoch 算 PSD，堆成 时间 × 频率 矩阵
```

绘图要点：颜色映射用 dB；纵轴限制到 0.5-30 Hz（更高频段基本是肌电）；
把分期结果画在谱图上方对齐——这两张图分开放，读者无法把 δ 的起伏与 N3 段对应起来。

## 常见错误

- **在含伪迹的 epoch 上算功率然后平均。** 一个饱和 epoch 的功率能高出三个数量级，
  平均值完全被它决定。先按 `BAD_*` annotation 排除。
- **不同记录的 epoch 数不同就直接比总功率。** 比的应该是密度或均值，不是总和。
- **忘记补偿滤波器。** 高通 0.3 Hz 会让 0.5 Hz 附近的功率被削掉一部分，
  不同高通设置的数据集之间 δ 功率不可比。
- **在功率上做 t 检验而不取对数。** 功率是右偏的，均值不是好的集中趋势度量。
