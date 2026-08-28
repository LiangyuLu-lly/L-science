---
slug: compute-hpc
name: HPC 与远程算力
version: 1.0.0
---

# HPC 与远程算力

## 提交之前

**在本地用一个被试、一小段数据跑通全流程。** 集群上调试的代价极高：
排队几小时，然后因为一个路径错误在三秒内失败。

本地验证清单：

- [ ] 脚本能从命令行参数接收输入（不是硬编码路径）。
- [ ] 单个被试跑通，输出格式正确。
- [ ] 记录了单个被试的**耗时与峰值内存**（用于估算资源申请）。
- [ ] 输出路径是参数，不会互相覆盖。

```python
# 峰值内存
import resource, time
t0 = time.time()
main(sys.argv[1], sys.argv[2])
print(f'elapsed={time.time()-t0:.1f}s '
      f'maxrss={resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1e6:.2f}GB')
```

## Slurm 作业脚本

```bash
#!/bin/bash
#SBATCH --job-name=psg-preproc
#SBATCH --account=<你的账户>
#SBATCH --partition=<分区名>
#SBATCH --array=1-44                  # 44 个被试，每个一个任务
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x_%A_%a.out    # %x 作业名 %A 作业号 %a 数组索引
#SBATCH --error=logs/%x_%A_%a.err

set -euo pipefail                      # 出错立刻停，不要带着错继续跑

mkdir -p logs results

source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate psg

SUBJECT=$(sed -n "${SLURM_ARRAY_TASK_ID}p" subjects.txt)
echo "host=$(hostname) subject=${SUBJECT} start=$(date -Is)"

python preprocess.py \
  --subject "${SUBJECT}" \
  --input  "${DATA_DIR}/${SUBJECT}.edf" \
  --output "results/${SUBJECT}_prep.fif" \
  --scratch "${SLURM_TMPDIR:-/tmp}"

echo "end=$(date -Is)"
```

要点：

- **`set -euo pipefail`**。没有它，中间步骤失败后脚本继续跑，最后产出一个不完整的结果
  而退出码是 0 —— 这种失败最难发现。
- **作业数组**（`--array`）而不是循环。数组任务独立排队、独立失败、独立重跑；
  写成循环时一个被试失败会浪费整个作业。
- **日志名带作业号与数组索引**，否则并行任务互相覆盖日志。
- **打印 hostname 与时间**。事后诊断「为什么这个被试慢十倍」时，节点信息是关键。

## 资源申请

按本地实测值加余量，不要随手填：

| 项 | 怎么定 |
|---|---|
| `--mem` | 本地峰值 × 1.5。**超了会被直接 kill**（OOM），日志里常只有一行 `Killed` |
| `--time` | 本地耗时 × 2-3。超时同样被 kill，且部分调度器不保留部分结果 |
| `--cpus-per-task` | 代码真的能并行才申请多核。numpy/MKL 默认会用满所有核，需显式控制 |
| `--gres=gpu:1` | 只有真用 GPU 才申请。空占 GPU 会让排队时间大幅变长 |

**申请过多资源会让排队时间变长**（调度器要凑出足够的空闲资源），
申请过少会被 kill。两边都要避免，所以本地实测很重要。

控制线程数避免超订：

```bash
export OMP_NUM_THREADS=${SLURM_CPUS_PER_TASK:-1}
export MKL_NUM_THREADS=${SLURM_CPUS_PER_TASK:-1}
export OPENBLAS_NUM_THREADS=${SLURM_CPUS_PER_TASK:-1}
```

不设这几个变量时，numpy 会在一个申请了 4 核的任务里开 64 个线程，
导致严重的上下文切换开销，反而更慢——而且会影响同节点上别人的任务。

## 数据

- **原始数据放共享存储**（`/scratch`、`/project`），不放家目录（家目录配额小且往往慢）。
- **计算过程用节点本地暂存**（`$SLURM_TMPDIR`），结束时把结果拷回共享存储。
  在共享存储上做频繁小 IO 是集群性能问题的主要来源。
- 传输用 `rsync -avP --partial`（可续传）而不是 `scp`。大数据集考虑 Globus。
- **传完核对校验和**。静默的传输损坏会让分析结果莫名其妙，而且极难归因。

```bash
sha256sum data/*.edf > checksums.txt          # 本地
rsync -avP data/ remote:/scratch/proj/data/
ssh remote "cd /scratch/proj && sha256sum -c checksums.txt"
```

## 环境一致性

集群上的环境必须与本地一致，否则「本地能跑集群不能」：

```bash
# 本地导出
conda env export --no-builds > environment.yml
# 集群创建
conda env create -f environment.yml -n psg
```

`--no-builds` 去掉平台相关的 build 字符串（Windows 与 Linux 的不同）。
仍然可能有包在 Linux 上版本不同——**在集群上也导出一份 lock 文件并存进制品**，
两份都留着，日后才能解释差异。

部分集群用 `module load` 管理编译器与 MPI；conda 环境与 module 混用时注意
`LD_LIBRARY_PATH` 冲突（症状是导入 numpy 时报 libstdc++ 版本错）。

## 跟踪与诊断

```bash
squeue -u "$USER"                       # 排队与运行中
sacct -j <jobid> --format=JobID,State,Elapsed,MaxRSS,ReqMem,ExitCode
seff <jobid>                            # 效率摘要（部分集群提供）
scancel <jobid>                         # 取消
```

`sacct` 的 `MaxRSS` 是下次申请内存的依据。`ExitCode`：

| 现象 | 原因 |
|---|---|
| `OUT_OF_MEMORY` 或日志只有 `Killed` | 超 `--mem` |
| `TIMEOUT` | 超 `--time` |
| `ExitCode 1:0` | 脚本本身报错，看 `.err` |
| `ExitCode 0:53`（信号 53） | 被节点故障或抢占中断，重跑 |
| 长期 `PD (Priority)` | 排队中；申请资源过多会加剧 |

## 平台内的使用

远程算力目标（SSH / Slurm）在平台里是**受审批门控**的：首次连接、
以及每次提交作业都会请求放行，并说明将要执行什么。作业状态会被跟踪到终止态，
结果可回收为制品。

**算力环境笔记**跨项目共享（同一台集群的模块名、分区名、配额），
但只记环境本身的知识——项目内容与分析结果不写进去。
