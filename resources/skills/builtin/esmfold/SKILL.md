---
slug: esmfold
name: ESMFold 单序列折叠
version: 1.0.0
---

# ESMFold 单序列折叠

## 它解决的是哪个问题

ESMFold 把 ESM-2 语言模型的表示直接接到一个折叠头上，**不需要 MSA**。这带来一个具体的
能力差异：单条序列从提交到出结构是秒到十几秒量级，而 AlphaFold2 的时间主要花在检索
同源序列上。

因此它的定位是**通量**，不是精度：

| 场景 | 用哪个 |
| --- | --- |
| 几千条序列筛一遍，挑出值得细看的 | ESMFold |
| 论文里要给出的那个结构 | AlphaFold2（或 OpenFold3 / Boltz-2） |
| 设计序列的快速自检回路 | ESMFold |
| MSA 极浅、AF2 也做不好的孤儿蛋白 | 两个都跑，比一比。**别假设 ESMFold 在这里更强** |
| 复合物、配体、核酸 | 都不用 ESMFold，它是单链模型 |

最后两行是最容易搞错的。「不需要 MSA」听起来像「在没有 MSA 的地方更强」，但 ESM-2 的
表示本身是从海量序列里学来的，它对稀有序列同样吃力。天然蛋白上 ESMFold 的平均精度
**低于** AF2，这是它的已知代价。

## 调用

```python
import torch, esm

model = esm.pretrained.esmfold_v1()
model = model.eval().cuda()
# 长序列显存不够时开分块注意力。数字越小越省显存、越慢
model.set_chunk_size(128)

seq = 'MKVLWAALLVTFLAGCQAKVEQAVETEPEPELRQQTEWQSGQRWELALGRFWDYLRWVQTLSEQVQEELLSSQVTQELRALMDETMKELKAYKSELEEQLTPVAEETRARLSKELQAAQARLGADMEDVCGRLVQYRGEVQAMLGQSTEELRVRLASHLRKLRKRLLRDADDLQKRLAVYQAGAREGAERGLSAIRERLGPLVEQGRVRAATVGSLAGQPLQERAQAWGERLRARMEEMGSRTRDRLDEVKEQVAEVRAKLEEQAQQIRLQAEAFQARLKSWFEPLVEDMQRQWAGLVEKVQAAVGTSAAPVPSDNH'
with torch.no_grad():
    pdb_str = model.infer_pdb(seq)
open('pred.pdb', 'w').write(pdb_str)
```

批量用 `infer_pdbs`（列表进、列表出）并按长度排序分批——同一批里最长的那条决定显存占用，
不排序会让短序列陪着长序列一起 OOM。

```python
seqs = sorted(records, key=lambda r: len(r.seq))       # 短的在前
for batch in chunks(seqs, size=4):
    outs = model.infer_pdbs([str(r.seq) for r in batch])
```

拿逐残基置信度：

```python
with torch.no_grad():
    out = model.infer([seq])
plddt = out['plddt'][0, :, 1].cpu().numpy()   # 索引 1 是 CA 原子
ptm = float(out['ptm'][0])
```

## 置信度的读法与 AF2 一致但有一条例外

pLDDT 的区间含义与 `alphafold2` 里那张表相同（>90 / 70-90 / 50-70 / <50），**但**
ESMFold 没有 PAE 矩阵那一层的域间判据。它给 pTM，而 pTM 是全局标量，回答不了
「两个域的相对摆放对不对」。

后果很具体：**多域蛋白用 ESMFold 时，域间取向基本不可用**。看到一个漂亮的双域结构，
不能据此讨论域间接触。需要那个信息就得回到 AF2 / OpenFold3 的 PAE。

## 三个会出错的地方

1. **设计序列的置信度同样虚高。** 这不是 AF2 独有的问题。从头设计的序列在 ESMFold 上
   也常拿到 pLDDT > 85，而实验里不折叠。快速自检回路里用它没问题（它就是干这个的），
   但**不能把它当成设计成功的证据**。判据见 `proteinmpnn` 的自一致性流程。
2. **把它当单体以外的东西用。** 它没有链间机制。把两条序列用连接子拼起来喂进去会得到
   一个「融合蛋白」的预测，那不是复合物预测，界面是假的。
3. **长序列静默降质。** `set_chunk_size` 只影响显存与速度，不影响正确性；但超过约
   1000 残基后精度本身会掉。跨过这个量级时要么切域分别预测，要么换 AF2。

## 与 ESM-2 的关系

ESMFold 的骨干就是 ESM-2（见 `esm2`）。因此两者可以共用一次前向：如果你已经在算 ESM-2
的表示做变异效应预测，结构预测可以顺带出来。反过来也成立——ESMFold 的中间表示可以直接
用于下游任务，省一次编码。

## 验证清单

- [ ] 明确写出为什么用 ESMFold 而不是 AF2（通量？自检回路？）
- [ ] pLDDT 分布记录了；多域蛋白已注明域间取向不可用
- [ ] 没有把它用在复合物、配体或核酸上
- [ ] 若结论依赖某个具体结构，已用 AF2 或实验结构复核过
- [ ] 权重版本（`esmfold_v1`）与 torch 版本记录了

## 存成制品

批量筛选的产出是**一张表**（序列 id、长度、pLDDT 中位数、pTM、耗时）加上入选者的坐标，
而不是几千个 PDB 文件。表进制品、坐标只存进入下一步的那些。筛选阈值写进代码，
别只写在聊天里——阈值是这一步唯一的方法学选择，它必须可复现。
