# IRkernel 启动器。
#
# 不用 `R --slave -e "IRkernel::main()" --args <file>` 的原因很实际：那条命令
# 里的引号要穿过 PowerShell、cmd 和 conda 多层传参，实测会被剥掉导致 R 报
# "unexpected end of input"。走脚本文件就没有引号问题。
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1L) {
  stop("用法：Rscript irkernel-launch.R <connection_file>")
}
IRkernel::main(args[[1L]])
