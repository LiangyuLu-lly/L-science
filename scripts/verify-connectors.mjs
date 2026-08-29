/**
 * 连接器端到端验证（任务 12.13、12.14，需求 14.1）。
 *
 * 单元测试用假 fetch 验的是桥的逻辑；**端点声明本身对不对，只有打真实 API 才知道**。
 * 路径写错、`pick` 路径写错、参数名写错、上游改了字段名——这四类错误在假 fetch 下
 * 全部通不过检验，而它们会让一个连接器在用户第一次用到时就失败。
 *
 * 这个脚本给**每个**内置连接器打一次真实查询，检查返回结构是否与声明一致。
 * 覆盖到每一个是刻意的：只抽查一部分时，没被抽到的那些照样是坏的，而且要等用户来发现。
 *
 * ## 三种结果
 *
 * - `PASS`：拿到数据且结构符合声明。
 * - `FAIL`：**声明有问题**——路径不存在、pick 取空、字段名对不上。要改代码。
 * - `SKIP`：上游连不上（DNS/超时/该服务此刻挂了）。这不是声明问题，本机网络策略
 *   也会造成它（比如 arXiv 与 GitHub 在部分网络下需要代理）。分开报是必要的：
 *   把网络问题算成失败会让这个脚本在一半的环境里永远红着，红久了就没人看了。
 *
 * **需要联网。** 部分公共 API 有速率限制，脚本已在调用之间留了间隔。全跑约三到五分钟。
 *
 * 用法：
 *   node scripts/verify-connectors.mjs              # 全部
 *   node scripts/verify-connectors.mjs pubchem go    # 只跑指定连接器
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AppStore,
  BRIDGE_SPECS,
  BUILTIN_CONNECTORS,
  BUILTIN_CONNECTOR_GROUPS,
  ConnectorRepo,
  McpBridgeServer,
  McpManager,
  syncBuiltinConnectors,
} from '../packages/core/dist/index.js';

let passed = 0;
let failed = 0;
let skipped = 0;

const check = (ok, label, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)}  ${String(detail).replace(/\s+/g, ' ').slice(0, 108)}\n`,
  );
};
const skip = (label, why) => {
  skipped += 1;
  process.stdout.write(
    `SKIP  ${label.padEnd(34)}  ${String(why).replace(/\s+/g, ' ').slice(0, 108)}\n`,
  );
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 判断一次失败是不是「上游连不上」而不是「声明错」。 */
const isUnreachable = (text) =>
  /fetch failed|超时|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|返回 5\d\d|返回 429/i.test(
    text,
  );

const root = mkdtempSync(join(tmpdir(), 'lsci-conn-'));
const store = AppStore.open(join(root, 'app'));
let bridge = null;
let manager = null;

/**
 * 每个连接器一条探针。
 *
 * 判据函数刻意写得具体（断言字段名而不是只看「是个数组」）：`pick` 路径写错时会静默
 * 返回 null，上游改字段名时会静默少字段，两者都是「看起来成功」的失败。
 */
const PROBES = [
  /* ---- 基因组 ---- */
  {
    connector: 'ensembl',
    tool: 'lookup_symbol',
    args: { species: 'homo_sapiens', symbol: 'BRCA1' },
    expect: (d) =>
      d !== null && /^ENSG\d+$/.test(String(d.id ?? '')) && d.biotype === 'protein_coding',
    note: 'REST + 多路径参数',
  },
  {
    connector: 'ucsc',
    tool: 'list_genomes',
    args: {},
    expect: (d) => d !== null && typeof d === 'object' && typeof d.hg38?.organism === 'string',
    note: 'pick 到对象',
  },

  /* ---- 基因与本体 ---- */
  {
    connector: 'mygene',
    tool: 'query',
    args: { q: 'symbol:BRCA1', species: 'human' },
    expect: (d) => Array.isArray(d) && d[0]?.symbol === 'BRCA1',
    note: 'REST + 查询参数 + pick 数组',
  },
  {
    connector: 'uniprot',
    tool: 'get_entry',
    args: { accession: 'P38398' },
    expect: (d) => d?.primaryAccession === 'P38398' && typeof d.sequence?.value === 'string',
    note: 'REST + 路径参数',
  },
  {
    connector: 'uniprot',
    tool: 'get_fasta',
    args: { accession: 'P38398' },
    expect: (_d, text) => text.startsWith('>sp|P38398'),
    note: '纯文本响应（非 JSON）',
  },
  {
    connector: 'gene-ontology',
    tool: 'autocomplete_genes',
    args: { query: 'autophagy', rows: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].label === 'string',
    note: 'autocomplete 路径（旧的 /search/entity 已 404）',
  },
  {
    connector: 'gene-ontology',
    tool: 'get_term',
    args: { id: 'GO:0006914' },
    expect: (d) => d?.label === 'autophagy' && typeof d.definition === 'string',
    note: 'GO ID → 术语定义',
  },
  {
    connector: 'gene-ontology',
    tool: 'gene_annotations',
    // 刻意用 UniProtKB 前缀：NCBIGene 在这个接口上查不到
    args: { id: 'UniProtKB:P38398', rows: 3 },
    expect: (d) => Array.isArray(d) && d[0]?.subject?.id === 'UniProtKB:P38398',
    note: 'CURIE 前缀敏感',
  },
  {
    connector: 'reactome',
    tool: 'pathways_for_gene',
    args: { id: 'P38398' },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^R-HSA-/.test(String(d[0].stId ?? '')),
    note: '通路映射',
  },
  {
    connector: 'ols',
    tool: 'search',
    args: { q: 'sleep apnea', rows: 5 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].obo_id === 'string',
    note: '深层 pick（response.docs）',
  },

  /* ---- 变异 ---- */
  {
    connector: 'gnomad',
    tool: 'gene_constraint',
    // 刻意不传 referenceGenome：它是 GraphQL 的必需变量但声明里有默认值，
    // 桥必须把默认值填进 variables，否则模型省略它时查询就会失败
    args: { geneSymbol: 'BRCA1' },
    expect: (d) =>
      /^ENSG\d+$/.test(String(d?.gene_id ?? '')) && typeof d.gnomad_constraint?.pLI === 'number',
    note: 'GraphQL + 默认变量填充',
  },
  {
    connector: 'clinvar',
    tool: 'search',
    args: { term: 'BRCA1[gene] AND pathogenic[clinsig]', retmax: 5 },
    expect: (d) => Array.isArray(d?.idlist) && d.idlist.length > 0,
    note: 'NCBI E-utilities',
  },
  {
    connector: 'dbsnp',
    tool: 'get_rsid',
    args: { rsid: '113488022' },
    expect: (d) => d?.refsnp_id === '113488022' && d.primary_snapshot_data !== undefined,
    note: 'NCBI variation service',
  },

  /* ---- 人类遗传学 ---- */
  {
    connector: 'gwas-catalog',
    tool: 'associations_for_gene',
    args: { geneName: 'BRCA1', size: 5 },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^rs\d+/.test(String(d[0].rsId ?? '')),
    note: 'HAL 风格 _embedded pick',
  },
  {
    connector: 'eqtl-catalogue',
    tool: 'list_datasets',
    args: {},
    // REST API 已下线，现在拿的是制表符分隔的目录表
    expect: (_d, text) => text.includes('study_label') || /QTD\d{6}/.test(text),
    note: 'API 已下线，改用目录表',
  },
  {
    connector: 'finngen',
    tool: 'gene_results',
    args: { gene: 'BRCA1' },
    expect: (d) => Array.isArray(d?.phenotypes) && d.phenotypes.length > 0,
    note: '芬兰人群 GWAS',
  },
  {
    connector: 'biobank-japan',
    tool: 'list_phenotypes',
    args: {},
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].phenocode === 'string',
    note: '跨人群一致性检验的数据源',
  },

  /* ---- 临床基因组学 ---- */
  {
    connector: 'clingen',
    tool: 'variant_classifications',
    args: { gene: 'BRCA1', limit: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && Array.isArray(d[0].hgvs),
    note: 'erepo 主机（search 子站是网页应用）',
  },
  {
    connector: 'clingen',
    tool: 'actionability',
    args: { context: 'Adult' },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^AC\d+/.test(String(d[0].docId ?? '')),
    note: '端点级 baseUrl 覆盖',
  },
  {
    connector: 'civic',
    tool: 'gene_summary',
    args: { entrezSymbol: 'BRCA1', first: 3 },
    expect: (d) => d?.name === 'BRCA1' && d.entrezId === 672 && Array.isArray(d.variants?.nodes),
    note: 'GraphQL：gene(entrezSymbol) 单数形式',
  },
  {
    connector: 'civic',
    tool: 'variant_evidence',
    args: { featureName: 'BRCA1', first: 3 },
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      d[0].featureName === 'BRCA1' &&
      typeof d[0].evidenceItemCount === 'number',
    note: 'browseVariants 连接',
  },
  {
    connector: 'open-targets',
    tool: 'target_associations',
    // size 传字符串：模型经常这么干，而 GraphQL 的 Int! 会拒绝 "5"
    args: { ensemblId: 'ENSG00000012048', size: '5' },
    expect: (d) => d?.approvedSymbol === 'BRCA1' && Array.isArray(d.associatedDiseases?.rows),
    note: 'GraphQL + 变量类型收敛',
  },

  /* ---- 表达 ---- */
  {
    connector: 'gtex',
    tool: 'gene_search',
    args: { geneId: 'BRCA1' },
    expect: (d) => Array.isArray(d) && /^ENSG\d+/.test(String(d[0]?.gencodeId ?? '')),
    note: 'gencodeId 带版本号，下游查询要用它',
  },

  /* ---- 调控 ---- */
  {
    connector: 'encode',
    tool: 'search_experiments',
    args: { searchTerm: 'BRCA1', limit: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^ENCSR/.test(String(d[0].accession ?? '')),
    note: '@graph pick',
  },
  {
    connector: 'jaspar',
    tool: 'search_matrix',
    args: { search: 'TP53' },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^MA\d+/.test(String(d[0].matrix_id ?? '')),
    note: '基序矩阵',
  },
  {
    connector: 'unibind',
    tool: 'search_datasets',
    // tf_name 才是真正的过滤参数；写成 tf 时服务端会忽略过滤并回全库前几条
    args: { tf_name: 'CTCF', species: 'Homo sapiens' },
    expect: (d) => Array.isArray(d) && d.length > 0 && d.every((x) => x.tf_name === 'CTCF'),
    note: '过滤参数名必须是 tf_name',
  },

  /* ---- 蛋白注释 ---- */
  {
    connector: 'interpro',
    tool: 'entries_for_protein',
    args: { accession: 'P38398' },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].metadata?.accession === 'string',
    note: '结构域注释',
  },
  {
    connector: 'pfam',
    tool: 'domains_for_protein',
    args: { accession: 'P38398' },
    expect: (d) =>
      Array.isArray(d) && d.length > 0 && /^PF\d+/.test(String(d[0].metadata?.accession ?? '')),
    note: 'Pfam 子集',
  },
  {
    connector: 'human-protein-atlas',
    tool: 'search',
    args: { search: 'BRCA1' },
    expect: (d) => Array.isArray(d) && d.length > 0 && d[0].Gene === 'BRCA1',
    note: '字段名带空格',
  },
  {
    connector: 'string',
    tool: 'interaction_partners',
    args: { identifiers: 'TP53', species: 9606, limit: 5 },
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      typeof d[0].stringId_A === 'string' &&
      typeof d[0].preferredName_B === 'string',
    note: '相互作用网络',
  },

  /* ---- 结构 ---- */
  {
    connector: 'pdb',
    tool: 'get_entry',
    args: { pdbId: '1TUP' },
    expect: (d) => d?.rcsb_id === '1TUP' && Array.isArray(d.exptl),
    note: 'REST 大写路径参数',
  },
  {
    connector: 'alphafold-db',
    tool: 'prediction',
    args: { accession: 'P38398' },
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      typeof d[0].pdbUrl === 'string' &&
      // omit 生效：序列不该出现在结构查询的返回里
      !('sequence' in d[0]) &&
      !('uniprotSequence' in d[0]),
    note: '预计算结构 + 大字段剪裁',
  },
  {
    connector: 'emdb',
    tool: 'get_entry',
    args: { emdbId: 'EMD-3061' },
    expect: (d) => d?.emdb_id === 'EMD-3061' && d.structure_determination_list !== undefined,
    note: '冷冻电镜条目',
  },
  {
    connector: 'complex-portal',
    tool: 'search',
    args: { query: 'BRCA1', number: 5 },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^CPX-/.test(String(d[0].complexAC ?? '')),
    note: 'pick elements（不是整个响应）',
  },
  {
    connector: 'intact',
    tool: 'search_interactions',
    args: { query: 'BRCA1', pageSize: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].idA === 'string',
    note: '分页 content pick',
  },

  /* ---- RNA ---- */
  {
    connector: 'rfam',
    tool: 'get_family',
    args: { accession: 'RF00001' },
    expect: (d) => d?.acc === 'RF00001' && d.id === '5S_rRNA',
    note: 'pick rfam（响应外层多一层）',
  },

  /* ---- 组学归档 ---- */
  {
    connector: 'geo',
    tool: 'search',
    args: { term: 'sleep apnea expression', retmax: 5 },
    expect: (d) => Array.isArray(d?.idlist) && d.idlist.length > 0,
    note: 'GEO 检索',
  },
  {
    connector: 'arrayexpress',
    tool: 'search',
    args: { query: 'sleep apnea', pageSize: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].accession === 'string',
    note: 'BioStudies hits pick',
  },
  {
    connector: 'pride',
    tool: 'search_projects',
    args: { keyword: 'brain', pageSize: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^PXD\d+/.test(String(d[0].accession ?? '')),
    note: '蛋白组学归档',
  },
  {
    connector: 'mgnify',
    tool: 'search_studies',
    args: { search: 'gut', page_size: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^MGYS\d+/.test(String(d[0].id ?? '')),
    note: 'JSON:API data pick',
  },
  {
    connector: 'metabolights',
    tool: 'list_studies',
    args: {},
    expect: (d) => Array.isArray(d) && d.length > 0 && /^MTBLS\d+/.test(String(d[0] ?? '')),
    note: '字符串数组',
  },

  /* ---- 肿瘤队列 ---- */
  {
    connector: 'cbioportal',
    tool: 'list_studies',
    args: {},
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      typeof d[0].studyId === 'string' &&
      // omit 生效：说明字段是一大段 HTML，不该占预算
      !('description' in d[0]),
    note: '大字段剪裁',
  },

  /* ---- 化学 ---- */
  {
    connector: 'pubchem',
    tool: 'compound_by_name',
    args: { name: 'aspirin' },
    // PubChem 2025 年把 CanonicalSMILES/IsomericSMILES 改成了 ConnectivitySMILES/SMILES。
    // 请求旧名不报错，只是响应里静默少字段——所以这里必须断言字段真的在
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      typeof d[0].SMILES === 'string' &&
      typeof d[0].ConnectivitySMILES === 'string' &&
      typeof d[0].InChIKey === 'string',
    note: '深层 pick + 属性名现行',
  },
  {
    connector: 'chebi',
    tool: 'search',
    args: { term: 'glucose', size: 3 },
    expect: (d) =>
      Array.isArray(d) && d.length > 0 && typeof d[0]._source?.chebi_accession === 'string',
    note: 'pick results',
  },
  {
    connector: 'rhea',
    tool: 'search',
    args: { query: 'glucose', limit: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].equation === 'string',
    note: '生化反应',
  },
  {
    connector: 'bindingdb',
    tool: 'affinities_by_uniprot',
    args: { uniprot: 'P00533', cutoff: 100 },
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      typeof d[0].affinity === 'string' &&
      typeof d[0].smile === 'string',
    note: '/rest 路径 + 服务端键名拼错也要照着写',
  },
  {
    connector: 'zinc',
    tool: 'get_substance',
    args: { zincId: 'ZINC000004175630' },
    expect: (d) => typeof d?.smiles === 'string' && d.tranche_details !== undefined,
    note: 'cartblanche 主机（zinc20 的 .json 只回单页应用）',
  },
  {
    connector: 'ketcher',
    tool: 'how_to_use',
    args: {},
    // 静态端点：不发网络请求，回一段说明。旧实现请求 127.0.0.1 会永远 fetch failed
    expect: (_d, text) => text.includes('RDKit') && text.includes('手性'),
    note: '静态说明端点，不发请求',
  },

  /* ---- 药物与监管 ---- */
  {
    connector: 'openfda',
    tool: 'drug_label',
    args: { search: 'openfda.brand_name:"aspirin"', limit: 2 },
    expect: (d) => Array.isArray(d) && d.length > 0 && d[0].openfda !== undefined,
    note: 'openFDA 检索语法',
  },

  /* ---- 文献图谱 ---- */
  {
    connector: 'openalex',
    tool: 'search_works',
    args: { search: 'obstructive sleep apnea cognition', per_page: 3 },
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      /^https:\/\/openalex\.org\/W\d+$/.test(String(d[0].id ?? '')) &&
      typeof d[0].title === 'string',
    note: '文献图谱',
  },
  {
    connector: 'arxiv',
    tool: 'search',
    args: { search_query: 'all:"obstructive sleep apnea"', max_results: 3 },
    // Atom XML，不是 JSON
    expect: (_d, text) => text.includes('<feed') && text.includes('<entry>'),
    note: 'Atom XML（responseType: text）',
  },

  /* ---- 科研资源 ---- */
  {
    connector: 'grants-gov',
    tool: 'search_opportunities',
    args: { keyword: 'sleep', rows: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].number === 'string',
    note: 'POST + JSON body',
  },
  {
    connector: 'antibody-registry',
    tool: 'search',
    args: { search: 'calnexin', size: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].catalogNum === 'string',
    note: '试剂可追溯性',
  },

  /* ---- 目录里的文献与试验 ---- */
  {
    connector: 'pubmed',
    tool: 'search',
    args: { term: 'sleep apnea cognition', retmax: 5 },
    expect: (d) => Array.isArray(d?.idlist) && d.idlist.length > 0,
    note: 'NCBI E-utilities',
  },
  {
    connector: 'clinicaltrials',
    tool: 'search_studies',
    args: { 'query.cond': 'sleep apnea', pageSize: 3 },
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      typeof d[0].protocolSection?.identificationModule?.nctId === 'string',
    note: '带点号的参数名',
  },
  {
    connector: 'chembl',
    tool: 'search_target',
    args: { q: 'EGFR', limit: 3 },
    expect: (d) =>
      Array.isArray(d) &&
      d.length > 0 &&
      /^CHEMBL\d+$/.test(String(d[0].target_chembl_id ?? '')) &&
      typeof d[0].pref_name === 'string',
    note: '化学库检索',
  },
  {
    connector: 'biorxiv',
    tool: 'by_doi',
    // DOI 自带斜杠：整值编码会变成 %2F 而服务端回 404
    args: { server: 'biorxiv', doi: '10.1101/2020.11.17.384578' },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].title === 'string',
    note: '路径参数含斜杠',
  },

  /* ================================================================
   * 第二组：上面每个连接器已验过一条主端点，这里把**剩下的每个端点**也各打一次。
   *
   * 覆盖到端点而不止连接器，是因为声明错误是按端点犯的：同一个连接器上
   * 一个端点对、另一个端点的 pick 写错，是最常见的形态。
   * ================================================================ */

  {
    connector: 'ensembl',
    tool: 'lookup_id',
    args: { id: 'ENSG00000012048' },
    expect: (d) => d?.display_name === 'BRCA1' && d.object_type === 'Gene',
  },
  {
    connector: 'ensembl',
    tool: 'sequence',
    // 基因 ID + type=protein 会因为「一个基因有多条蛋白」而报错，
    // 所以这里用转录本 ID —— 这也是描述里提醒的用法
    args: { id: 'ENST00000357654', type: 'protein' },
    expect: (d) => typeof d?.seq === 'string' && d.seq.length > 100,
  },
  {
    connector: 'ensembl',
    tool: 'vep_hgvs',
    args: { species: 'homo_sapiens', hgvs: 'ENST00000357654.9:c.5324T>A' },
    expect: (d) => Array.isArray(d) && d.length > 0 && Array.isArray(d[0].transcript_consequences),
  },
  {
    connector: 'ensembl',
    tool: 'overlap_region',
    args: { species: 'homo_sapiens', region: '17:43044295-43125483', feature: 'gene' },
    expect: (d) => Array.isArray(d) && d.some((g) => g.external_name === 'BRCA1'),
  },
  {
    connector: 'ucsc',
    tool: 'get_sequence',
    args: { genome: 'hg38', chrom: 'chr17', start: 43044295, end: 43044345 },
    expect: (d) => typeof d?.dna === 'string' && d.dna.length === 50,
  },
  {
    connector: 'ucsc',
    tool: 'track_data',
    args: { genome: 'hg38', track: 'knownGene', chrom: 'chr17', start: 43044295, end: 43125483 },
    expect: (d) => d !== null && typeof d === 'object' && d.chrom === 'chr17',
  },
  {
    connector: 'mygene',
    tool: 'get_gene',
    args: { id: '672' },
    expect: (d) => d?.symbol === 'BRCA1',
  },
  {
    connector: 'uniprot',
    tool: 'search',
    args: { query: 'gene:BRCA1 AND organism_id:9606 AND reviewed:true', size: 3 },
    expect: (d) => Array.isArray(d) && d.some((r) => r.primaryAccession === 'P38398'),
  },
  {
    connector: 'gene-ontology',
    tool: 'genes_for_term',
    args: { id: 'GO:0006914', rows: 5 },
    expect: (d) => Array.isArray(d) && d.length > 0 && d[0].object?.id === 'GO:0006914',
  },
  {
    connector: 'reactome',
    tool: 'search',
    args: { query: 'BRCA1' },
    expect: (d) => d !== null && typeof d === 'object' && Array.isArray(d.results),
  },
  {
    connector: 'reactome',
    tool: 'pathway_participants',
    args: { stId: 'R-HSA-5685942' },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].stId === 'string',
  },
  {
    connector: 'gnomad',
    tool: 'variant_frequency',
    // PCSK9 上一个真实存在的位点。gnomAD 对不存在的变异回 GraphQL 错误而不是空结果
    args: { variantId: '1-55039774-C-T' },
    expect: (d) => typeof d?.variant_id === 'string',
  },
  {
    connector: 'clinvar',
    tool: 'summary',
    args: { id: '55606' },
    expect: (d) => d !== null && Array.isArray(d.uids) && d.uids.length > 0,
  },
  {
    connector: 'gwas-catalog',
    tool: 'find_trait',
    args: { trait: 'asthma' },
    expect: (d) => Array.isArray(d) && d.some((t) => typeof t.shortForm === 'string'),
  },
  {
    connector: 'gwas-catalog',
    tool: 'studies_for_trait',
    args: { efoTrait: 'asthma', size: 3 },
    expect: (d) =>
      Array.isArray(d) && d.length > 0 && /^GCST\d+$/.test(String(d[0].accessionId ?? '')),
  },
  {
    connector: 'gwas-catalog',
    tool: 'associations_for_study',
    // 这个研究确实有整理出的显著位点；很多研究只提交了汇总统计，关联数组是空的
    args: { accessionId: 'GCST007266', size: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].pvalue === 'number',
  },
  {
    connector: 'eqtl-catalogue',
    tool: 'tabix_paths',
    args: {},
    expect: (_d, text) => text.includes('ftp.ebi.ac.uk') || /QTD\d{6}/.test(text),
  },
  {
    connector: 'eqtl-catalogue',
    tool: 'column_docs',
    args: {},
    expect: (_d, text) => /pvalue|beta/i.test(text),
  },
  {
    connector: 'finngen',
    tool: 'list_phenotypes',
    args: {},
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].phenocode === 'string',
  },
  {
    connector: 'biobank-japan',
    tool: 'variant',
    // BBJ 对不在数据集里的变异回字面 null 而不是 404，所以这里必须用一个真实位点
    args: { variant: '9-136120091-G-A' },
    expect: (d) => d !== null && Array.isArray(d.phenos) && d.phenos.length > 0,
  },
  {
    connector: 'clingen',
    tool: 'gene_validity',
    args: {},
    expect: (_d, text) => text.includes('CLASSIFICATION') || text.includes('GENE SYMBOL'),
  },
  {
    connector: 'clingen',
    tool: 'dosage_sensitivity',
    args: {},
    expect: (_d, text) => /haploinsufficiency/i.test(text) || text.includes('#gene'),
  },
  {
    connector: 'open-targets',
    tool: 'target_tractability',
    args: { ensemblId: 'ENSG00000146648' },
    expect: (d) =>
      d?.approvedSymbol === 'EGFR' &&
      Array.isArray(d.tractability) &&
      // Tractability 上没有 id 字段，只有 label/modality/value
      typeof d.tractability[0]?.label === 'string',
  },
  {
    connector: 'open-targets',
    tool: 'disease_targets',
    args: { efoId: 'MONDO_0007254', size: 5 },
    expect: (d) => typeof d?.name === 'string' && Array.isArray(d.associatedTargets?.rows),
  },
  {
    connector: 'gtex',
    tool: 'median_expression',
    // gencodeId 必须带版本号，这是 GTEx 最容易踩的一条
    args: { gencodeId: 'ENSG00000012048.20' },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].median === 'number',
  },
  {
    connector: 'jaspar',
    tool: 'get_matrix',
    args: { matrix_id: 'MA0106.1' },
    expect: (d) => d?.matrix_id === 'MA0106.1' && d.pfm !== undefined,
  },
  {
    connector: 'unibind',
    tool: 'list_tfs',
    args: {},
    expect: (d) => Array.isArray(d) && d.some((t) => t.tf_name === 'CTCF'),
  },
  {
    connector: 'unibind',
    tool: 'list_cell_types',
    args: {},
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].name === 'string',
  },
  {
    connector: 'pfam',
    tool: 'get_family',
    args: { accession: 'PF00097' },
    expect: (d) => d?.metadata?.accession === 'PF00097',
  },
  {
    connector: 'string',
    tool: 'enrichment',
    args: { identifiers: 'TP53%0dMDM2%0dCDKN1A', species: 9606 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].term === 'string',
  },
  {
    connector: 'pdb',
    tool: 'entry_ligands',
    // 1TUP（p53-DNA）没有非聚合物实体 2；1M17 是 EGFR + 厄洛替尼，实体 2 就是配体
    args: { pdbId: '1M17', entityId: '2' },
    expect: (d) => d?.pdbx_entity_nonpoly?.comp_id === 'AQ4',
  },
  {
    connector: 'emdb',
    tool: 'search',
    args: { query: 'ribosome', rows: 5 },
    expect: (d) => d !== null && typeof d === 'object',
  },
  {
    connector: 'complex-portal',
    tool: 'get_complex',
    args: { ac: 'CPX-4425' },
    expect: (d) => typeof d?.systematicName === 'string' && d.systematicName.includes('BRCA1'),
  },
  {
    connector: 'rfam',
    tool: 'search',
    args: { query: 'tRNA' },
    expect: (d) => Array.isArray(d) && d.length > 0 && /^RF\d+/.test(String(d[0].acc ?? '')),
  },
  {
    connector: 'geo',
    tool: 'summary',
    args: { id: '200333507' },
    expect: (d) => d !== null && Array.isArray(d.uids),
  },
  {
    connector: 'metabolights',
    tool: 'get_study',
    args: { studyId: 'MTBLS1' },
    expect: (d) => d !== null && typeof d === 'object',
  },
  {
    connector: 'cbioportal',
    tool: 'gene_mutations',
    // entrezGeneId 是服务端必填项，缺它会 400
    args: {
      molecularProfileId: 'brca_tcga_mutations',
      entrezGeneId: 672,
      sampleListId: 'brca_tcga_all',
      pageSize: 5,
    },
    expect: (d) => Array.isArray(d) && d.length > 0 && d[0].entrezGeneId === 672,
  },
  {
    connector: 'pubchem',
    tool: 'compound_by_cid',
    args: { cid: '2244' },
    expect: (d) => Array.isArray(d) && d[0]?.CID === 2244 && typeof d[0].SMILES === 'string',
  },
  {
    connector: 'pubchem',
    tool: 'similarity_search',
    args: { smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O', Threshold: 95, MaxRecords: 5 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0] === 'number',
  },
  {
    connector: 'bindingdb',
    tool: 'affinities_by_pdb',
    args: { pdb: '1Q0L', cutoff: 10000 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].smile === 'string',
  },

  {
    connector: 'openfda',
    tool: 'adverse_events',
    args: { search: 'patient.drug.medicinalproduct:"aspirin"', limit: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0,
  },
  {
    connector: 'openalex',
    tool: 'get_work',
    args: { id: 'W2124052130' },
    expect: (d) => typeof d?.title === 'string' && d.id === 'https://openalex.org/W2124052130',
  },
  {
    connector: 'openalex',
    tool: 'cited_by',
    args: { filter: 'cites:W2124052130', per_page: 3 },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].id === 'string',
  },
  {
    connector: 'pubmed',
    tool: 'summary',
    args: { id: '36841492' },
    expect: (d) => d !== null && Array.isArray(d.uids) && d.uids.includes('36841492'),
  },
  {
    connector: 'pubmed',
    tool: 'abstract',
    args: { id: '36841492' },
    expect: (_d, text) => text.length > 200 && /\d{4}/.test(text),
  },
  {
    connector: 'pubmed',
    tool: 'pmc_fulltext',
    args: { id: 'PMC1790863' },
    expect: (_d, text) => text.includes('<article') || text.includes('<pmc-articleset'),
  },
  {
    connector: 'clinicaltrials',
    tool: 'get_study',
    args: { nctId: 'NCT00000102' },
    expect: (d) => d?.protocolSection?.identificationModule?.nctId === 'NCT00000102',
  },
  {
    connector: 'chembl',
    tool: 'search_molecule',
    args: { q: 'aspirin', limit: 3 },
    expect: (d) =>
      Array.isArray(d) && d.length > 0 && /^CHEMBL\d+$/.test(String(d[0].molecule_chembl_id ?? '')),
  },
  {
    connector: 'chembl',
    tool: 'target_activities',
    args: { target_chembl_id: 'CHEMBL203', standard_type: 'IC50', limit: 5 },
    expect: (d) => Array.isArray(d) && d.length > 0 && d[0].target_chembl_id === 'CHEMBL203',
  },
  {
    connector: 'biorxiv',
    tool: 'recent_preprints',
    // 区间是两个路径段，斜杠不能被编码成 %2F
    args: { server: 'biorxiv', interval: '2026-07-20/2026-07-22' },
    expect: (d) => Array.isArray(d) && d.length > 0 && typeof d[0].doi === 'string',
  },
];

try {
  /* ---------------- 1. 目录一致性（不联网）---------------- */

  process.stdout.write('\n--- 1. 目录一致性 ---\n');

  const repo = new ConnectorRepo(store.db);
  bridge = new McpBridgeServer({
    specs: BRIDGE_SPECS,
    onLog: (line) => process.stderr.write(`[bridge] ${line}\n`),
  });
  await bridge.start();
  check(bridge.port > 0, '桥已监听', bridge.baseUrl);

  const sync = syncBuiltinConnectors({ repo, bridgeUrl: bridge.baseUrl });
  check(
    sync.added === BUILTIN_CONNECTORS.length,
    '内置目录已同步',
    `${sync.added} 个连接器 / ${sync.groups} 组`,
  );
  check(
    BUILTIN_CONNECTORS.length >= 45 && BUILTIN_CONNECTOR_GROUPS.length >= 15,
    '目录规模达到对标要求',
    `${BUILTIN_CONNECTORS.length} 个连接器，${BUILTIN_CONNECTOR_GROUPS.length} 组`,
  );

  // 每个内置连接器的 bridge 必须真的存在。写错一个字母就会得到一个握手失败的连接器，
  // 而那个失败要等用户点开设置页才看得到
  const bridgeIdSet = new Set(BRIDGE_SPECS.map((s) => s.id));
  const danglingBridge = BUILTIN_CONNECTORS.filter((c) => !bridgeIdSet.has(c.bridge));
  check(
    danglingBridge.length === 0,
    '每个连接器都指向一个真实的桥',
    danglingBridge.length === 0
      ? `${bridgeIdSet.size} 个桥定义`
      : danglingBridge.map((c) => `${c.id}→${c.bridge}`).join(', '),
  );

  // 反向：定义了桥却没有连接器引用它，说明目录漏了一个
  const usedBridges = new Set(BUILTIN_CONNECTORS.map((c) => c.bridge));
  const orphanBridge = [...bridgeIdSet].filter((id) => !usedBridges.has(id));
  check(orphanBridge.length === 0, '没有无人引用的桥', orphanBridge.join(', '));

  const effective = repo.listEffective();
  check(effective.length > 0, '有生效的连接器', `${effective.length} 个`);
  check(
    repo.effectiveDomains().length > 0,
    '域名清单可用于出口白名单联动',
    `${repo.effectiveDomains().length} 个域名`,
  );

  /*
   * 探针必须覆盖到每一个**端点**，不是每一个连接器。
   *
   * 按连接器算覆盖会漏掉最常见的那类 bug：同一个连接器上主端点是对的、第二个端点的
   * `pick` 写错了。而且这条断言还有个作用——以后往目录里加端点时，如果不同时加探针，
   * 这里就会红，逼着新端点也被真实调用验过一次。
   */
  const probedTools = new Set(PROBES.map((p) => `${p.connector}.${p.tool}`));
  const connectorOfBridge = new Map(BUILTIN_CONNECTORS.map((c) => [c.bridge, c.id]));
  const unprobed = [];
  for (const spec of BRIDGE_SPECS) {
    const connectorId = connectorOfBridge.get(spec.id) ?? spec.id;
    for (const endpoint of spec.endpoints) {
      if (!probedTools.has(`${connectorId}.${endpoint.name}`)) {
        unprobed.push(`${connectorId}.${endpoint.name}`);
      }
    }
  }
  check(
    unprobed.length === 0,
    '每个端点都有探针',
    unprobed.length === 0 ? `${PROBES.length} 条探针覆盖全部端点` : `缺：${unprobed.join(', ')}`,
  );

  // 探针不能指向不存在的端点（改名后忘了改探针）
  const declared = new Set();
  for (const spec of BRIDGE_SPECS) {
    const connectorId = connectorOfBridge.get(spec.id) ?? spec.id;
    for (const endpoint of spec.endpoints) declared.add(`${connectorId}.${endpoint.name}`);
  }
  const stale = [...probedTools].filter((t) => !declared.has(t));
  check(stale.length === 0, '没有指向已消失端点的探针', stale.join(', '));

  /* ---------------- 2. 握手与工具清单 ---------------- */

  process.stdout.write('\n--- 2. 握手与工具清单 ---\n');

  manager = new McpManager({
    repo,
    connectTimeoutMs: 20_000,
    onLog: (line) => process.stderr.write(`[mcp] ${line}\n`),
  });

  const allTools = await manager.tools();
  const withTools = new Set(allTools.map((t) => t.connectorId));
  const noTools = effective.filter((c) => !withTools.has(c.id));
  check(
    noTools.length === 0,
    '每个生效连接器都暴露了工具',
    noTools.length === 0 ? `共 ${allTools.length} 个工具` : noTools.map((c) => c.id).join(', '),
  );

  // 工具的输入 schema 必须自洽：required 里的名字要真的在 properties 里
  const schemaBroken = allTools.filter((t) => {
    const schema = t.tool.inputSchema ?? {};
    const props = Object.keys(schema.properties ?? {});
    return (schema.required ?? []).some((r) => !props.includes(r));
  });
  check(
    schemaBroken.length === 0,
    '工具 schema 自洽',
    schemaBroken.map((t) => `${t.connectorId}.${t.tool.name}`).join(', '),
  );

  /* ---------------- 3. 真实查询 ---------------- */

  process.stdout.write('\n--- 3. 真实查询（每个连接器至少一条）---\n');

  const only = process.argv.slice(2);
  for (const probe of PROBES) {
    if (only.length > 0 && !only.includes(probe.connector)) continue;
    const label = `${probe.connector}.${probe.tool}`;
    try {
      const out = await manager.callTool(probe.connector, probe.tool, probe.args, {
        conversationId: null,
        projectId: null,
      });

      if (out.denied) {
        // 内置目录全部只读，被授权门拦下说明 readOnly 注解丢了
        check(false, label, '被授权门拦下——只读注解可能没生效');
      } else if (!out.ok) {
        if (isUnreachable(out.text)) skip(label, out.text);
        else check(false, label, out.text);
      } else {
        // `McpCallOutcome` 的结构化字段叫 structured（对应 MCP 的 structuredContent）
        const good = probe.expect(out.structured, out.text);
        check(good, label, good ? probe.note : `结构不符声明：${out.text.slice(0, 90)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isUnreachable(message)) skip(label, message);
      else check(false, label, message);
    }
    // 公共 API 有速率限制，留间隔
    await sleep(350);
  }

  /* ---------------- 4. 授权门与两级开关 ---------------- */

  process.stdout.write('\n--- 4. 授权门与开关 ---\n');

  // 内置目录全部只读，因此不该产生任何工具授权记录
  check(
    repo.listToolGrants().length === 0,
    '只读工具没有产生授权记录',
    '只读不需要审批，也不该落授权',
  );

  const group = BUILTIN_CONNECTOR_GROUPS.find((g) => g.id === 'genes-ontologies');
  repo.setGroupEnabled('genes-ontologies', false);
  const afterOff = repo.listEffective().some((c) => c.groupId === 'genes-ontologies');
  check(!afterOff, '关掉一组后该组连接器全部失效', group?.name ?? '');

  const domainsAfterOff = new Set(repo.effectiveDomains());
  check(
    !domainsAfterOff.has('mygene.info'),
    '关组后它的域名从清单里撤回',
    '否则用户以为断网了而内核里的代码照样能连',
  );

  await manager.disconnect('mygene');
  let blocked = false;
  try {
    await manager.client('mygene');
  } catch {
    blocked = true;
  }
  check(blocked, '关组后拒绝重新连接', '');

  repo.setGroupEnabled('genes-ontologies', true);
  check(repo.effectiveDomains().includes('mygene.info'), '重新开组后域名回来', '');

  /* ---------------- 5. 健康检查 ---------------- */

  process.stdout.write('\n--- 5. 健康检查 ---\n');

  const health = await manager.check('uniprot');
  check(
    health.ok && health.toolCount > 0,
    'check 返回服务端信息与工具数',
    `${health.detail}，${health.toolCount} 个工具`,
  );

  const bad = await manager.check('no-such-connector');
  check(!bad.ok, '不存在的连接器如实报失败', bad.detail.slice(0, 60));
} catch (err) {
  failed += 1;
  process.stdout.write(
    `\n未预期的异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
} finally {
  if (manager !== null) await manager.close().catch(() => undefined);
  if (bridge !== null) await bridge.stop().catch(() => undefined);
  store.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  `\n通过 ${passed}，失败 ${failed}${skipped > 0 ? `，跳过 ${skipped}（上游连不上，非声明问题）` : ''}\n`,
);
process.exit(failed === 0 ? 0 : 1);
