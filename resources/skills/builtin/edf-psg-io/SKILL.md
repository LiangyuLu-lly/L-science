---
slug: edf-psg-io
name: EDF / PSG 数据读写
version: 1.0.0
---

# EDF / PSG 数据读写

## 什么时候用

拿到一份 `.edf` / `.bdf` 记录，在做任何分析之前。读入这一步出的错会一路传到结论，
而且症状往往不像读取问题——单位错了会让振幅阈值全部失效，看起来像「这个人的脑电
特别平」。

## 读入

用 `mne.io.read_raw_edf(path, preload=False)`。`preload=False` 是默认选择：整夜 PSG
在 256 Hz、20 通道下是数百 MB，先看元数据再决定读哪一段。

读进来第一件事是**打印并核对**下面五项，不要跳过：

```python
import mne
raw = mne.io.read_raw_edf(path, preload=False, verbose='error')
print(raw.info['sfreq'])                    # 采样率
print(raw.ch_names)                          # 通道名
print(raw.n_times / raw.info['sfreq'] / 3600)  # 时长（小时）
print(raw.info['meas_date'])                 # 记录起始时间（含时区）
print({ch: raw.info['chs'][i]['unit'] for i, ch in enumerate(raw.ch_names)})
```

## 五个必查项

**1. 单位。** EDF 头里的 physical dimension 常见 `uV`、`mV`、`V`，也常见写错或留空。
MNE 会按头部声明换算到 **伏特**，因此 `raw.get_data()` 拿到的是 V 而不是 µV。写阈值时
乘 `1e-6`，或者一次性 `raw.get_data(units='uV')` 明确要 µV。判据：健康成人清醒期 EEG
峰峰值大致在 10-100 µV；算出来是 1e-5 量级说明单位没错，是 10 量级说明头里声明的
单位与实际不符。

**2. 通道命名。** 同一份数据集里 `C3-A2`、`C3-M2`、`EEG C3-A2` 混用是常态。统一到一套
命名再往下走，并把映射表存成制品——半年后复现时没有它就对不上。参考导联 A1/A2 与
M1/M2 是同一位置的两种叫法（耳垂 vs 乳突），不要当成两个通道。

**3. 采样率不一致。** EDF 允许每个信号有各自的采样率（脑电 256 Hz、血氧 1 Hz 很常见）。
`read_raw_edf` 会重采样到最高的那个，这会让 1 Hz 的血氧被内插成 256 Hz 的假数据。
需要低频通道时单独读：`mne.io.read_raw_edf(path, include=['SpO2'])`。

**4. 时间轴基准。** 分期文件（`.txt`、`.xml`、`.csv`）的时间通常是**相对记录起点的秒数**，
但也有用绝对时钟的。核对方法：分期条目数 × epoch 长度 应约等于记录时长。差一个整小时
基本上是时区问题，差几分钟通常是分期从「关灯」而不是「记录开始」算的。

**5. 断点与不连续。** EDF+ 允许不连续记录（`EDF+D`）。`raw.annotations` 里的
`BAD_ACQ_SKIP` 标记着断点。直接按索引切 epoch 会跨过断点拼接出不存在的信号。

## 标注

```python
ann = mne.Annotations(onset=[...], duration=[...], description=[...])
raw.set_annotations(ann)
```

`onset` 是相对记录起点的秒。分期用 30 s duration 与 `Sleep stage W/N1/N2/N3/R` 这套
描述（AASM 命名），别自己发明字符串——后续的 yasa / 可视化工具都按这套认。

## 导出

EDF 写出用 `mne.export.export_raw(path, raw, fmt='edf')`（需要 `edfio`）。两个坑：

- EDF 的物理量程是 16 位整数量化的，写出前把数据范围核对一遍，超量程会被截断且不报错。
- 患者信息字段会被原样写进头部。导出用于共享的文件时清空 `raw.info['subject_info']`。

**优先不导出 EDF。** 中间结果存 `.fif`（MNE 原生，无损、带完整元数据）或 `.npy` + 一份
JSON 元数据。EDF 是交换格式，每次往返都会丢信息。

## 存成制品

读入并核对之后，把「核对结论」本身存成制品，而不只是存数据：

```python
summary = {
    'sfreq': raw.info['sfreq'],
    'channels': raw.ch_names,
    'duration_h': raw.n_times / raw.info['sfreq'] / 3600,
    'units_checked': 'uV',
    'channel_map': mapping,      # 你做的重命名
    'discontinuities': [a['onset'] for a in raw.annotations if 'SKIP' in a['description']],
}
```

保存时带上生成它的代码。没有这份记录，「这份数据是怎么被解读的」在复现时答不出来。
