# Create local kernel envs. Does not bundle conda into the installer.
# Existing envs are skipped.

$ErrorActionPreference = 'Stop'

function Assert-Conda {
  param()
  $conda = Get-Command conda -ErrorAction SilentlyContinue
  if (-not $conda) {
    Write-Error 'conda not found. Install Miniconda/Anaconda and add it to PATH.'
  }
}

function Test-CondaEnv {
  param([string]$Name)
  $json = conda env list --json | ConvertFrom-Json
  foreach ($p in $json.envs) {
    if ((Split-Path -Leaf $p) -eq $Name) {
      return $true
    }
  }
  return $false
}

Assert-Conda

if (Test-CondaEnv -Name 'lsci') {
  Write-Host 'lsci exists, skip.'
} else {
  Write-Host 'conda create -n lsci python=3.13 ipykernel'
  conda create -n lsci python=3.13 ipykernel -y
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (Test-CondaEnv -Name 'lsci-r') {
  Write-Host 'lsci-r exists, skip.'
} else {
  Write-Host 'conda create -n lsci-r'
  conda create -n lsci-r -c conda-forge r-base r-irkernel -y
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host 'Done. Re-run env doctor in L-science.'
