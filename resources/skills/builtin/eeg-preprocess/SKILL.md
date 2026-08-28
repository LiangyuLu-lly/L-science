---
slug: eeg-preprocess
name: EEG 预处理
version: 1.0.0
---

# EEG 预处理

## 顺序

顺序会影响结果，不是风格问题：

1. **先标坏道，再重参考。** 反过来会把一个坏道的噪声经平均参考摊到所有通道上，
   之后无论怎么处理都去不掉。
2. **先滤波，再切 epoch。** 反过来每个 epoch 边缘都会有滤波器的瞬态响应，
   表现是「每个 epoch 头尾都有一个大波」，很容易被事件检测当成真实事件。
3. **ICA 之前先高通。** ICA 对慢漂移极其敏感，1 Hz 高通（仅用于拟合 ICA）几乎是标准做法：
   在副本上做 1 Hz 高通拟合 ICA，把得到的解混矩阵应用到原始（0.3 Hz 高通）数据上。

## 滤波

```python
raw.filter(l_freq=0.3, h_freq=35., fir_design='firwin')   # 睡眠 EEG 常用
raw.notch_filter(freqs=[50])                               # 中国工频 50 Hz，北美 60 Hz
```

- **高通截止**：睡眠分期用 0.3 Hz（保留慢波），ERP 用 0.1 Hz 或更低。
  高通设到 1 Hz 会把 δ 功率削掉一部分，N3 判读会偏少。
- **低通截止**：判读纺锤波需要保留到 16 Hz 以上，取 35 Hz 有余量。要看肌电时不能低通到
  35 Hz——REM 的肌张力低下判读依赖 EMG 的高频成分。
- **陷波**：先看功率谱确认工频是否真的存在。没有干扰时加陷波只会引入一个凹口，
  且会影响附近的 γ 分析。
- **不要用 IIR 零相位以外的滤波器做时间敏感的分析**。`method='iir'` 默认是 Butterworth
  加 filtfilt（零相位），单向 `lfilter` 会引入群延迟，事件时刻会系统性偏移。

## 重参考

```python
raw.set_eeg_reference('average')        # 平均参考，需要足够多且分布均匀的通道
raw.set_eeg_reference(['M1', 'M2'])     # 双侧乳突，PSG 标准
mne.set_bipolar_reference(raw, 'C3', 'M2')
```

PSG 按 AASM 用对侧乳突（C3-M2、C4-M1、F3-M2、F4-M1、O1-M2、O2-M1）。**通道少于 20 个
时不要用平均参考**——平均值被少数通道主导，等于引入了一个假的公共成分。

## 坏道

判据要写下来而不是靠眼看：

```python
data = raw.get_data(picks='eeg')
std = data.std(axis=1)
# 与中位数差 5 倍以上：过大是接触不良或饱和，过小是断线（几乎是平线）
bad = [ch for ch, s in zip(raw.ch_names, std)
       if s > 5 * np.median(std) or s < 0.2 * np.median(std)]
raw.info['bads'] = bad
```

插值前必须有电极位置（`raw.set_montage('standard_1020')`）。PSG 只有六个 EEG 通道时
**不要插值**——空间采样太稀疏，插出来的是编造的信号。标为坏道并在分析里排除即可。

## 伪迹

- **眼动（EOG）**：有 EOG 通道时用 `mne.preprocessing.create_eog_epochs` 找出成分再
  用 ICA 去除。没有 EOG 通道时不要凭前额通道猜——直接标记时段并排除。
- **肌电（EMG）**：高频宽带升高。低通滤波能压住影响，但**不要为了「干净」而低通到
  30 Hz 以下**，那会连带削掉纺锤波。
- **心搏（ECG）**：在参考电极靠近血管时明显。ICA 能分离，但成分数少于 15 时可靠性差。
- **体动**：整段饱和。标为 `BAD_movement` annotation，让下游按段排除，而不是删掉样本
  ——删样本会改变时间轴，之后与分期文件对不上。

ICA 的成分数取 `min(n_channels - len(bads) - 1, 20)`。PSG 的六通道 EEG 上 ICA 基本无效，
成分数不足以分离出可解释的伪迹成分。

## 记录参数

预处理参数**必须与结果一起保存**，且要具体到数值：

```python
prep = {
    'highpass_hz': 0.3, 'lowpass_hz': 35.0, 'notch_hz': [50],
    'filter_design': 'firwin', 'reference': ['M1', 'M2'],
    'bads': raw.info['bads'], 'bad_criterion': 'std > 5*median or < 0.2*median',
    'ica_ncomp': None, 'mne_version': mne.__version__,
}
```

原因很直接：「δ 功率」这个数在 0.3 Hz 高通和 1 Hz 高通下能差 20% 以上。没有这份记录，
两篇论文的同名指标不可比，审稿人问起时也答不上来。
