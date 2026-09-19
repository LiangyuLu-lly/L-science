# 为本机创建分析内核环境。不把 conda 打进安装包。
# 需要 conda 已在 PATH。失败时退出码非 0。

$ErrorActionPreference = 'Stop'

function Assert-Conda {
  $conda = Get-Command conda -ErrorAction SilentlyContinue
  if ($null -eq $conda) {
    Write-Error '找不到 conda。先安装 Miniconda/Anaconda 并勾选 Add to PATH，再跑本脚本。'
  }
}

Assert-Conda

Write-Host '创建 lsci (Python 3.13 + ipykernel)…'
conda create -n lsci python=3.13 ipykernel -y
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '创建 lsci-r (R + IRkernel)…'
conda create -n lsci-r -c conda-forge r-base r-irkernel -y
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '完成。回到 L-science「工具与环境」点重新检查。'
