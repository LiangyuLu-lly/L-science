---
slug: hrv-analysis
name: 心率变异性分析
version: 1.0.0
---

# 心率变异性分析

## 流程

```python
import neurokit2 as nk
signals, info = nk.ecg_process(ecg, sampling_rate=sf)
rpeaks = info['ECG_R_Peaks']
hrv = nk.hrv(rpeaks, sampling_rate=sf, show=False)   # 时域 + 频域 + 非线性
```

## 先把 RR 序列清理干净

这一步决定一切。**异位心搏（早搏）会让 RMSSD 虚高数倍**——一次早搏产生一个短 RR 紧跟
一个长 RR，相邻差值的平方项被放大。

```python
rri = np.diff(rpeaks) / sf * 1000                       # ms
# 判据：与前后中位数偏离 20% 以上视为异常
med = scipy.ndimage.median_filter(rri, size=5)
bad = np.abs(rri - med) / med > 0.2
```

处理方式三选一，**必须写明选了哪个**：删除（改变时间轴，频域分析不可用）、
线性内插（常用）、样条内插。异常比例超过 **5%** 时该段不应用于 HRV 分析，直接排除。

`nk.signal_fixpeaks(rpeaks, sampling_rate=sf, method='kubios')` 可以自动做，
但要打印它改了多少个点。

## 采样率下限

R 波峰值定位的精度直接决定 RR 的精度。**ECG 采样率低于 250 Hz 时 RMSSD 系统性偏差
不可忽略**；PSG 里 ECG 常只有 200 Hz 甚至 128 Hz，这种情况下：

- 报告 SDNN 等长程指标仍可接受；
- RMSSD、pNN50 这类依赖相邻差值的指标要么不报，要么明确声明采样率限制；
- 可以用抛物线插值提高峰值定位精度（`nk.ecg_findpeaks` 内部已做部分补偿）。

## 窗长

**HRV 指标只在相同窗长下可比。** 这是最常被违反的一条：

| 窗长 | 可用指标 |
|---|---|
| 10-60 s | 仅 RMSSD、SDNN（超短程，需引用效度研究） |
| 5 min | 标准短程窗，LF/HF 的经典定义就基于它 |
| 24 h | SDNN、SDANN、非线性指标；ULF 频段只有这里能算 |

用 30 s 的睡眠 epoch 算 LF 功率是**无效的**——LF 频段下限 0.04 Hz，一个周期 25 s，
30 s 窗里连一个完整周期都放不下。要按 epoch 分析只能用 RMSSD 类指标，且要引用超短程
HRV 的效度文献。

## 频域

- VLF 0.003-0.04 Hz、LF 0.04-0.15 Hz、HF 0.15-0.4 Hz。
- **HF 受呼吸频率强烈影响。** 呼吸频率低于 9 次/分（0.15 Hz）时呼吸成分会落进 LF 频段，
  HF/LF 的解释完全反转。有呼吸信号时报告呼吸频率，没有时在限制里说明。
- **不要把 LF/HF 解释成「交感/副交感平衡」。** 这个解释在生理学上已被广泛质疑
  （LF 同时含副交感成分）。报告数值可以，赋予它自主神经平衡的含义需要额外论证。
- RR 序列非等间隔，做 FFT 前必须重采样（通常 4 Hz 三次样条）。`nk.hrv_frequency`
  已处理，自己实现时别直接对 RR 序列做 FFT。

## PPG

PPG 得到的是**脉率变异（PRV）**，不等于 HRV。脉搏传导时间的变异会叠加进来，
体动伪影远多于 ECG。可以用，但：

- 论文里用 PRV 这个词，或明确写「由 PPG 导出的 HRV 代理指标」；
- 报告与 ECG 的一致性（若有同步记录）或引用效度文献；
- 体动段必须排除，`nk.ppg_quality` 可给出逐点质量。

## 睡眠场景

- 按睡眠期分层报告：REM 的 HRV 显著不同于 NREM，混在一起平均会掩盖两者。
- 分析单位是被试而不是 epoch。同一夜的相邻 epoch 高度相关（见 `mixed-effects-models`）。
- 呼吸事件会产生周期性心率变化（cyclic variation of heart rate），OSA 组的 HRV 差异
  可能主要由此驱动，需要在讨论里区分。

## 存成制品

RR 序列（清理前与清理后）、异常比例、窗长、采样率、neurokit2 版本，与指标表一起存。
异常比例这一项尤其重要——它是判断该段数据可信度的唯一依据。
