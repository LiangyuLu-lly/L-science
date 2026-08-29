/**
 * 内置连接器目录（任务 12.14，需求 14.1）。
 *
 * 对标 Claude Science 的 Featured 连接器：一批公共生命科学数据库，**默认开启、只读、
 * 免账号免 key**，按组管理。
 *
 * ## 为什么用 HTTP 而不是各写一个 stdio 服务端
 *
 * 这些数据库都有公开的 REST / GraphQL 接口。走 HTTP 传输意味着零安装——用户不需要
 * `pip install` 五十个 MCP 服务端包，也不需要 Node 去 spawn 五十个子进程。代价是需要
 * 一个把 REST 适配成 MCP 的桥（`bridgeUrl`），平台自带一个本地桥。
 *
 * ## 域名与出口白名单联动
 *
 * 每个连接器声明它依赖的域名。启用一组连接器时，这些域名进出口代理白名单；关掉时撤回。
 * 不联动会出现两种半开状态，两种都没人能解释：
 * - 连接器开着但域名没放行 → 每次调用都弹审批
 * - 连接器关了但域名还在白名单 → 用户以为断网了，实际上内核里的代码照样能连
 *
 * ## 许可提醒
 *
 * 部分底层数据库有非商业或署名条款（例如某些人类遗传学资源、化学数据库）。平台不替用户
 * 判断，但在组说明里点出来，让他在用于商业用途前知道要去看条款。
 */

import type { ConnectorRepo } from '../repo/connectors.js';
import { connectorFingerprint } from './manager.js';

export interface BuiltinConnectorGroup {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  /** 该组底层资源是否存在需要用户自查的许可条款。 */
  licenseNote?: string;
}

export interface BuiltinConnector {
  id: string;
  name: string;
  groupId: string;
  /** 数据源清单，写进说明让用户知道这个连接器背后是什么。 */
  sources: readonly string[];
  /** 需要放行的域名。 */
  domains: readonly string[];
  /** REST → MCP 桥的资源标识。桥按它决定要暴露哪些工具。 */
  bridge: string;
  description: string;
  /** 默认是否启用。目录连接器（非 Featured）默认关闭。 */
  enabledByDefault?: boolean;
}

/* ------------------------------------------------------------------ *
 * 组
 * ------------------------------------------------------------------ */

export const BUILTIN_CONNECTOR_GROUPS: readonly BuiltinConnectorGroup[] = [
  {
    id: 'genomes',
    name: '基因组与注释',
    description: '参考基因组、基因结构、变异注释效应预测。',
    sortOrder: 10,
  },
  {
    id: 'genes-ontologies',
    name: '基因与本体',
    description: '基因标识符映射、蛋白条目、功能本体与通路。',
    sortOrder: 20,
  },
  {
    id: 'variants',
    name: '变异与群体频率',
    description: '群体等位频率、临床变异解释、变异标识符。',
    sortOrder: 30,
    licenseNote: '部分资源要求署名并限制再分发，商业用途前请查各自条款。',
  },
  {
    id: 'human-genetics',
    name: '人类遗传学关联',
    description: 'GWAS 关联、eQTL、生物样本库队列级统计量。',
    sortOrder: 40,
    licenseNote: '生物样本库派生数据常有使用协议，商业用途前请查条款。',
  },
  {
    id: 'clinical-genomics',
    name: '临床基因组学',
    description: '基因-疾病效度、体细胞变异临床意义、靶点-疾病证据整合。',
    sortOrder: 50,
  },
  {
    id: 'expression',
    name: '表达',
    description: '组织与细胞类型层面的基因表达。',
    sortOrder: 60,
  },
  {
    id: 'regulation',
    name: '调控',
    description: '调控元件、转录因子结合基序与结合位点。',
    sortOrder: 70,
  },
  {
    id: 'protein-annotation',
    name: '蛋白注释',
    description: '结构域、家族、亚细胞定位、蛋白相互作用网络。',
    sortOrder: 80,
  },
  {
    id: 'structures',
    name: '结构与相互作用',
    description: '实验结构、预测结构、冷冻电镜图谱、复合物与相互作用。',
    sortOrder: 90,
  },
  { id: 'rna', name: 'RNA', description: 'RNA 家族与二级结构。', sortOrder: 100 },
  {
    id: 'omics-archives',
    name: '组学归档',
    description: '公共表达、蛋白组、宏基因组与代谢组数据集归档。',
    sortOrder: 110,
  },
  {
    id: 'cancer-models',
    name: '肿瘤队列与模型',
    description: '肿瘤基因组队列、突变频谱与临床关联。',
    sortOrder: 120,
  },
  {
    id: 'chemistry',
    name: '化学',
    description: '化合物、反应、结合数据与可采购化学空间。',
    sortOrder: 130,
    licenseNote: '部分化学数据库对批量下载与商业用途有限制。',
  },
  {
    id: 'drug-regulatory',
    name: '药物与监管',
    description: '已批准药物信息、说明书、不良事件报告。',
    sortOrder: 140,
  },
  {
    id: 'literature-graph',
    name: '文献图谱',
    description: '文献元数据、引用网络、预印本。',
    sortOrder: 150,
  },
  {
    id: 'research-resources',
    name: '科研资源',
    description: '基金机会、抗体与试剂标识。',
    sortOrder: 160,
  },
  {
    id: 'directory',
    name: '目录连接器',
    description: '同时可用于其他 Claude 产品的目录连接器。默认关闭，需要时逐个开启。',
    sortOrder: 200,
  },
];

/* ------------------------------------------------------------------ *
 * 连接器
 * ------------------------------------------------------------------ */

export const BUILTIN_CONNECTORS: readonly BuiltinConnector[] = [
  /* ---- 基因组与注释 ---- */
  {
    id: 'ensembl',
    name: 'Ensembl（含 VEP）',
    groupId: 'genomes',
    sources: ['Ensembl REST', 'Variant Effect Predictor'],
    domains: ['rest.ensembl.org', 'ensembl.org'],
    bridge: 'ensembl',
    description:
      '基因、转录本、外显子结构查询；序列取用；VEP 变异效应注释（后果类型、SIFT/PolyPhen、' +
      '受影响转录本）。做变异解读时它给的是标准注释，与序列模型的打分互补。',
  },
  {
    id: 'ucsc',
    name: 'UCSC Genome Browser',
    groupId: 'genomes',
    sources: ['UCSC REST API'],
    domains: ['api.genome.ucsc.edu', 'genome.ucsc.edu'],
    bridge: 'ucsc',
    description: '基因组坐标转换（liftOver）、轨道数据、序列取用。跨基因组版本对齐时常用。',
  },

  /* ---- 基因与本体 ---- */
  {
    id: 'mygene',
    name: 'MyGene.info',
    groupId: 'genes-ontologies',
    sources: ['MyGene.info'],
    domains: ['mygene.info'],
    bridge: 'mygene',
    description:
      '基因标识符批量映射（Ensembl ID ↔ 基因符号 ↔ Entrez ↔ RefSeq）。' +
      '几乎每个组学流程的第一步都需要它——标识符类型不匹配是最高频的静默错误。',
  },
  {
    id: 'uniprot',
    name: 'UniProt',
    groupId: 'genes-ontologies',
    sources: ['UniProt REST'],
    domains: ['rest.uniprot.org', 'uniprot.org'],
    bridge: 'uniprot',
    description:
      '蛋白条目：序列、功能注释、翻译后修饰、变异、结构域、交叉引用。' +
      '结构预测的输入序列应当从这里取而不是手抄。',
  },
  {
    id: 'gene-ontology',
    name: 'Gene Ontology',
    groupId: 'genes-ontologies',
    sources: ['GO API'],
    domains: ['api.geneontology.org', 'geneontology.org'],
    bridge: 'go',
    description: 'GO 术语、基因产物注释、富集分析所需的注释集合。',
  },
  {
    id: 'reactome',
    name: 'Reactome',
    groupId: 'genes-ontologies',
    sources: ['Reactome ContentService'],
    domains: ['reactome.org'],
    bridge: 'reactome',
    description: '通路层级、参与实体、通路图。做通路富集与机制假设时用。',
  },
  {
    id: 'ols',
    name: 'Ontology Lookup Service',
    groupId: 'genes-ontologies',
    sources: ['EBI OLS'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'ols',
    description:
      '跨本体术语检索（EFO、MONDO、HPO、UBERON、CL 等）。' +
      '把自由文本的表型或组织名映射到标准术语，是数据整合的前提。',
  },

  /* ---- 变异与群体频率 ---- */
  {
    id: 'gnomad',
    name: 'gnomAD',
    groupId: 'variants',
    sources: ['gnomAD GraphQL'],
    domains: ['gnomad.broadinstitute.org'],
    bridge: 'gnomad',
    description:
      '群体等位频率、基因约束指标（pLI / LOEUF / o-e）、功能缺失变异。' +
      '判断变异是否常见、以及一个基因能否容忍功能缺失，都靠它。',
  },
  {
    id: 'clinvar',
    name: 'ClinVar',
    groupId: 'variants',
    sources: ['NCBI E-utilities（ClinVar）'],
    domains: ['eutils.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov'],
    bridge: 'clinvar',
    description:
      '变异的临床意义提交记录、证据等级、提交者与冲突情况。' +
      '注意：有冲突的记录要看具体提交者与评审状态，不能只取一个「致病」标签。',
  },
  {
    id: 'dbsnp',
    name: 'dbSNP',
    groupId: 'variants',
    sources: ['NCBI dbSNP'],
    domains: ['eutils.ncbi.nlm.nih.gov', 'api.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov'],
    bridge: 'dbsnp',
    description: 'rsID 与基因组坐标、等位的互查。跨数据源对齐变异标识符时需要。',
  },

  /* ---- 人类遗传学关联 ---- */
  {
    id: 'gwas-catalog',
    name: 'GWAS Catalog',
    groupId: 'human-genetics',
    sources: ['GWAS Catalog REST'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'gwas-catalog',
    description:
      '已发表的 GWAS 关联：性状、效应量、p 值、样本量、报告基因与映射基因。' +
      '注意报告的「最近基因」常常不是效应基因，要配共定位证据看。',
  },
  {
    id: 'eqtl-catalogue',
    name: 'eQTL Catalogue',
    groupId: 'human-genetics',
    sources: ['eQTL Catalogue 资源表', 'EBI FTP（tabix）'],
    // 原来的 REST API 已下线（回 410）。目录表托管在项目仓库，汇总统计按区间从 FTP 取，
    // 所以 raw.githubusercontent.com 与 ftp.ebi.ac.uk 两个域名都要在白名单里
    domains: ['raw.githubusercontent.com', 'ftp.ebi.ac.uk', 'www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'eqtl-catalogue',
    description:
      '统一处理的 eQTL / sQTL 统计量，按组织与细胞类型。做共定位分析的输入。' +
      'REST API 已下线，本连接器给出数据集目录与 tabix 路径，按位点取区间。',
  },
  {
    id: 'finngen',
    name: 'FinnGen',
    groupId: 'human-genetics',
    sources: ['FinnGen 公开结果'],
    domains: ['r12.finngen.fi', 'finngen.fi'],
    bridge: 'finngen',
    description: '芬兰队列的表型-基因型关联汇总统计。人群特异的富集变异在这里信号更强。',
  },
  {
    id: 'biobank-japan',
    name: 'BioBank Japan',
    groupId: 'human-genetics',
    sources: ['BBJ PheWeb'],
    domains: ['pheweb.jp'],
    bridge: 'biobank-japan',
    description: '东亚人群的关联汇总统计。做跨人群一致性检验时必要——多数 GWAS 以欧洲人群为主。',
  },

  /* ---- 临床基因组学 ---- */
  {
    id: 'clingen',
    name: 'ClinGen',
    groupId: 'clinical-genomics',
    sources: ['ClinGen Allele Registry / Gene Validity'],
    // ClinGen 的能力散在多个主机：erepo 是变异判读，actionability 是临床可干预性，
    // ftp 是效度与剂量敏感性全量表，search 是网页应用
    domains: [
      'erepo.clinicalgenome.org',
      'actionability.clinicalgenome.org',
      'ftp.clinicalgenome.org',
      'search.clinicalgenome.org',
      'reg.clinicalgenome.org',
      'ldh.clinicalgenome.org',
      'clinicalgenome.org',
    ],
    bridge: 'clingen',
    description: '基因-疾病关系的效度评级、剂量敏感性、变异解读专家组结论。',
  },
  {
    id: 'civic',
    name: 'CIViC',
    groupId: 'clinical-genomics',
    sources: ['CIViC GraphQL'],
    domains: ['civicdb.org'],
    bridge: 'civic',
    description: '体细胞变异的临床可操作性证据：诊断、预后、用药相关，带证据等级与文献。',
  },
  {
    id: 'open-targets',
    name: 'Open Targets',
    groupId: 'clinical-genomics',
    sources: ['Open Targets Platform GraphQL', 'Open Targets Genetics'],
    domains: ['api.platform.opentargets.org', 'platform.opentargets.org', 'opentargets.org'],
    bridge: 'open-targets',
    description:
      '靶点-疾病证据整合（遗传学、体细胞、药物、通路、文献、动物模型）与可成药性评估。' +
      '`indication-dossier` 技能的主要数据源。',
  },

  /* ---- 表达 ---- */
  {
    id: 'gtex',
    name: 'GTEx',
    groupId: 'expression',
    sources: ['GTEx Portal API'],
    domains: ['gtexportal.org'],
    bridge: 'gtex',
    description:
      '正常组织的基因表达与 eQTL。评估「靶点在关键正常组织表达吗」这个安全性问题的第一站。',
  },

  /* ---- 调控 ---- */
  {
    id: 'encode',
    name: 'ENCODE',
    groupId: 'regulation',
    sources: ['ENCODE Portal API'],
    domains: ['www.encodeproject.org', 'encodeproject.org'],
    bridge: 'encode',
    description: '调控元件、染色质可及性、组蛋白修饰、TF ChIP-seq 实验与处理后文件。',
  },
  {
    id: 'jaspar',
    name: 'JASPAR',
    groupId: 'regulation',
    sources: ['JASPAR REST'],
    domains: ['jaspar.elixir.no', 'jaspar.genereg.net'],
    bridge: 'jaspar',
    description: '转录因子结合基序矩阵（PWM）。做基序富集与结合位点预测的输入。',
  },
  {
    id: 'unibind',
    name: 'UniBind',
    groupId: 'regulation',
    sources: ['UniBind'],
    domains: ['unibind.uio.no'],
    bridge: 'unibind',
    description: '经 ChIP-seq 数据校准的高置信 TF 结合位点。比纯基序扫描的假阳性低得多。',
  },

  /* ---- 蛋白注释 ---- */
  {
    id: 'interpro',
    name: 'InterPro',
    groupId: 'protein-annotation',
    sources: ['InterPro API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'interpro',
    description: '蛋白家族、结构域、位点的整合注释。判断一段序列属于哪个家族时用。',
  },
  {
    id: 'pfam',
    name: 'Pfam',
    groupId: 'protein-annotation',
    sources: ['Pfam（经 InterPro）'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'pfam',
    description: '蛋白结构域家族与隐马尔可夫模型。做结构域边界划分与域级分析。',
  },
  {
    id: 'human-protein-atlas',
    name: 'Human Protein Atlas',
    groupId: 'protein-annotation',
    sources: ['HPA API'],
    domains: ['www.proteinatlas.org', 'proteinatlas.org'],
    bridge: 'human-protein-atlas',
    description:
      '蛋白层面的组织与细胞类型表达、亚细胞定位、病理关联。' +
      '判断模态可行性（胞外可做抗体、胞内需小分子）要看这里的定位。',
  },
  {
    id: 'string',
    name: 'STRING',
    groupId: 'protein-annotation',
    sources: ['STRING API'],
    domains: ['string-db.org'],
    bridge: 'string',
    description:
      '蛋白相互作用与功能关联网络，带证据来源与置信度。' +
      '注意它混合了实验、共表达与文本挖掘证据，用的时候要按证据类型过滤。',
  },

  /* ---- 结构与相互作用 ---- */
  {
    id: 'pdb',
    name: 'RCSB PDB',
    groupId: 'structures',
    sources: ['RCSB Data / Search API'],
    domains: ['data.rcsb.org', 'search.rcsb.org', 'files.rcsb.org', 'rcsb.org'],
    bridge: 'pdb',
    description:
      '实验测定的生物大分子结构：坐标、配体、分辨率、方法、序列比对。' +
      '做对接或结构分析前**先查这里有没有实验结构**——有的话不必用预测结构。',
  },
  {
    id: 'alphafold-db',
    name: 'AlphaFold DB',
    groupId: 'structures',
    sources: ['AlphaFold Protein Structure Database'],
    domains: ['alphafold.ebi.ac.uk'],
    bridge: 'alphafold-db',
    description:
      '已预计算的 AlphaFold 结构与 pLDDT / PAE。' +
      '`alphafold2` 技能的第一步就是查它——天然序列不必自己重算。',
  },
  {
    id: 'emdb',
    name: 'EMDB',
    groupId: 'structures',
    sources: ['EMDB API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'emdb',
    description: '冷冻电镜与电子断层图谱：密度图、分辨率、拟合模型。',
  },
  {
    id: 'complex-portal',
    name: 'Complex Portal',
    groupId: 'structures',
    sources: ['Complex Portal API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'complex-portal',
    description:
      '经手工整理的稳定蛋白复合物及其化学计量。' +
      '做复合物预测前查它——化学计量必须显式给出，模型不会自己发现。',
  },
  {
    id: 'intact',
    name: 'IntAct',
    groupId: 'structures',
    sources: ['IntAct / PSICQUIC'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'intact',
    description: '分子相互作用的实验证据，带检测方法与置信度评分。',
  },

  /* ---- RNA ---- */
  {
    id: 'rfam',
    name: 'Rfam',
    groupId: 'rna',
    sources: ['Rfam API'],
    domains: ['rfam.org'],
    bridge: 'rfam',
    description: 'RNA 家族、共变模型与二级结构。做非编码 RNA 注释时用。',
  },

  /* ---- 组学归档 ---- */
  {
    id: 'geo',
    name: 'GEO',
    groupId: 'omics-archives',
    sources: ['NCBI GEO'],
    domains: ['eutils.ncbi.nlm.nih.gov', 'ftp.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov'],
    bridge: 'geo',
    description: '公共表达数据集检索与元数据。找可复用的对照数据或做外部验证集时的首选。',
  },
  {
    id: 'arrayexpress',
    name: 'ArrayExpress / BioStudies',
    groupId: 'omics-archives',
    sources: ['BioStudies API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'arrayexpress',
    description: '功能基因组学实验归档，元数据结构化程度较高。',
  },
  {
    id: 'pride',
    name: 'PRIDE',
    groupId: 'omics-archives',
    sources: ['PRIDE Archive API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'pride',
    description: '蛋白组学质谱数据归档：项目、实验设计、鉴定结果。',
  },
  {
    id: 'mgnify',
    name: 'MGnify',
    groupId: 'omics-archives',
    sources: ['MGnify API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'mgnify',
    description: '宏基因组与微生物组分析结果：分类组成、功能注释、样本元数据。',
  },
  {
    id: 'metabolights',
    name: 'MetaboLights',
    groupId: 'omics-archives',
    sources: ['MetaboLights API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'metabolights',
    description: '代谢组学研究归档：实验设计、代谢物鉴定、原始与处理数据。',
  },

  /* ---- 肿瘤队列与模型 ---- */
  {
    id: 'cbioportal',
    name: 'cBioPortal',
    groupId: 'cancer-models',
    sources: ['cBioPortal API'],
    domains: ['www.cbioportal.org', 'cbioportal.org'],
    bridge: 'cbioportal',
    description:
      '肿瘤基因组队列：突变频率、拷贝数、表达、临床数据与生存关联。' +
      '做生存分析时注意队列的随访完整度与删失模式（见 `survival-analysis`）。',
  },

  /* ---- 化学 ---- */
  {
    id: 'pubchem',
    name: 'PubChem',
    groupId: 'chemistry',
    sources: ['PubChem PUG-REST'],
    domains: ['pubchem.ncbi.nlm.nih.gov'],
    bridge: 'pubchem',
    description:
      '化合物标识、性质、生物活性、专利与文献。SMILES / InChI 从这里取而不是手写——' +
      '手抄 SMILES 最容易丢手性（见 `diffdock`）。',
  },
  {
    id: 'chebi',
    name: 'ChEBI',
    groupId: 'chemistry',
    sources: ['ChEBI API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'chebi',
    description: '生物相关小分子的本体与标识符，含代谢物与辅因子。',
  },
  {
    id: 'rhea',
    name: 'Rhea',
    groupId: 'chemistry',
    sources: ['Rhea API'],
    domains: ['www.rhea-db.org', 'rhea-db.org'],
    bridge: 'rhea',
    description: '生化反应库，反应式与 ChEBI、UniProt 交叉引用。做代谢通路建模时用。',
  },
  {
    id: 'bindingdb',
    name: 'BindingDB',
    groupId: 'chemistry',
    sources: ['BindingDB API'],
    domains: ['www.bindingdb.org', 'bindingdb.org'],
    bridge: 'bindingdb',
    description:
      '实测结合亲和力（Kd / Ki / IC50）。' +
      '**校验亲和力预测的排序质量就靠它**（见 `boltz-2` 里的 Spearman 核验）。',
  },
  {
    id: 'zinc',
    name: 'ZINC',
    groupId: 'chemistry',
    sources: ['ZINC / Tranche'],
    domains: [
      'cartblanche22.docking.org',
      'zinc.docking.org',
      'zinc20.docking.org',
      'files.docking.org',
    ],
    bridge: 'zinc',
    description: '可采购化学空间，按性质与相似性检索。虚拟筛选的化合物库来源。',
  },
  {
    id: 'ketcher',
    name: 'Ketcher 结构编辑',
    groupId: 'chemistry',
    sources: ['本地 Ketcher'],
    domains: [],
    bridge: 'ketcher',
    description:
      '二维分子结构编辑与格式互转（SMILES / MOL / InChI）。' + '不联网，纯本地转换与规范化。',
  },

  /* ---- 药物与监管 ---- */
  {
    id: 'openfda',
    name: 'openFDA',
    groupId: 'drug-regulatory',
    sources: ['openFDA（药品、不良事件、召回）'],
    domains: ['api.fda.gov'],
    bridge: 'openfda',
    description:
      '已批准药品信息、说明书、不良事件报告（FAERS）、召回。' +
      '注意 FAERS 是自发上报数据，不能用来算发生率——没有分母。',
  },

  /* ---- 文献图谱 ---- */
  {
    id: 'openalex',
    name: 'OpenAlex',
    groupId: 'literature-graph',
    sources: ['OpenAlex API'],
    domains: ['api.openalex.org', 'openalex.org'],
    bridge: 'openalex',
    description:
      '跨学科文献元数据与引用图。覆盖最广，做引文前向/后向追踪的主力（见 `literature-review`）。',
  },
  {
    id: 'arxiv',
    name: 'arXiv',
    groupId: 'literature-graph',
    sources: ['arXiv API'],
    domains: ['export.arxiv.org', 'arxiv.org'],
    bridge: 'arxiv',
    description: '预印本检索与元数据，方法学类问题必查。**结果须标注未经同行评议**。',
  },

  /* ---- 科研资源 ---- */
  {
    id: 'grants-gov',
    name: 'Grants.gov',
    groupId: 'research-resources',
    sources: ['Grants.gov API'],
    domains: ['api.grants.gov', 'grants.gov'],
    bridge: 'grants-gov',
    description: '美国联邦基金机会检索：申请截止、资助机构、金额范围。',
  },
  {
    id: 'antibody-registry',
    name: 'Antibody Registry',
    groupId: 'research-resources',
    sources: ['Antibody Registry'],
    domains: ['www.antibodyregistry.org', 'antibodyregistry.org'],
    bridge: 'antibody-registry',
    description:
      '抗体的 RRID 标识与供应商信息。方法学部分写抗体时应给 RRID 而不只是货号——' +
      '货号会变，RRID 不会。',
  },

  /* ---- 目录连接器（默认关闭）---- */
  {
    id: 'pubmed',
    name: 'PubMed',
    groupId: 'directory',
    sources: ['PubMed', 'PubMed Central'],
    domains: ['eutils.ncbi.nlm.nih.gov', 'www.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov'],
    bridge: 'pubmed',
    description:
      '生物医学文献检索、摘要与元数据，PMC 全文（开放获取部分）。' +
      'MeSH 主题词检索的精度优势明显，`literature-review` 的主力来源之一。',
    enabledByDefault: true,
  },
  {
    id: 'clinicaltrials',
    name: 'ClinicalTrials.gov',
    groupId: 'directory',
    sources: ['ClinicalTrials.gov API v2'],
    domains: ['clinicaltrials.gov'],
    bridge: 'clinicaltrials',
    description:
      '注册临床试验：设计、入组标准、终点、状态与结果。' +
      '**识别发表偏倚要靠它**——注册但无结果的试验往往是阴性的。',
    enabledByDefault: true,
  },
  {
    id: 'chembl',
    name: 'ChEMBL',
    groupId: 'directory',
    sources: ['ChEMBL API'],
    domains: ['www.ebi.ac.uk', 'ebi.ac.uk'],
    bridge: 'chembl',
    description: '生物活性分子与靶点活性数据，含药物开发阶段与作用机制。',
    enabledByDefault: true,
  },
  {
    id: 'biorxiv',
    name: 'bioRxiv / medRxiv',
    groupId: 'directory',
    sources: ['bioRxiv API', 'medRxiv API'],
    domains: ['api.biorxiv.org', 'biorxiv.org', 'medrxiv.org'],
    bridge: 'biorxiv',
    description: '生物与医学预印本。最新工作在这里，**结果须标注未经同行评议**。',
    enabledByDefault: true,
  },
];

/* ------------------------------------------------------------------ *
 * 同步
 * ------------------------------------------------------------------ */

export interface SyncBuiltinResult {
  groups: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

/**
 * 把内置目录同步进注册表。
 *
 * 幂等，且**不覆盖用户的启用选择**（`upsert` 不写 enabled）。源里下架的内置连接器会被删；
 * 用户自建的绝不碰——这正是 `builtin` 标记存在的理由。
 *
 * `bridgeUrl` 是本地 REST→MCP 桥的地址。桥按 `bridge` 标识决定暴露哪些工具。
 */
export function syncBuiltinConnectors(input: {
  repo: ConnectorRepo;
  bridgeUrl: string;
  onLog?: (line: string) => void;
}): SyncBuiltinResult {
  const { repo, bridgeUrl } = input;
  const log = input.onLog ?? ((): void => {});

  for (const group of BUILTIN_CONNECTOR_GROUPS) {
    repo.upsertGroup({
      id: group.id,
      name: group.name,
      description:
        group.description +
        (group.licenseNote === undefined ? '' : `\n许可提示：${group.licenseNote}`),
      sortOrder: group.sortOrder,
    });
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const def of BUILTIN_CONNECTORS) {
    const config = {
      url: `${bridgeUrl.replace(/\/+$/, '')}/mcp/${def.bridge}`,
      bridge: def.bridge,
      sources: def.sources,
    };
    const fingerprint = connectorFingerprint({
      id: def.id,
      kind: 'mcp-http',
      config,
      domains: def.domains,
    });

    const existing = repo.get(def.id);
    if (existing !== null && existing.sourceSha256 === fingerprint) {
      unchanged += 1;
      continue;
    }

    repo.upsert({
      id: def.id,
      kind: 'mcp-http',
      name: def.name,
      groupId: def.groupId,
      builtin: true,
      config,
      domains: def.domains,
      sourceSha256: fingerprint,
      enabledByDefault: def.enabledByDefault !== false,
    });

    if (existing === null) added += 1;
    else updated += 1;
  }

  const removed = repo.pruneBuiltins(BUILTIN_CONNECTORS.map((c) => c.id));

  if (added + updated + removed > 0) {
    log(
      `内置连接器同步：新增 ${String(added)}，更新 ${String(updated)}，` +
        `下架 ${String(removed)}，未变 ${String(unchanged)}`,
    );
  }

  return {
    groups: BUILTIN_CONNECTOR_GROUPS.length,
    added,
    updated,
    removed,
    unchanged,
  };
}
