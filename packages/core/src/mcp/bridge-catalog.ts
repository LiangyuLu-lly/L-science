/**
 * 内置连接器的端点声明（任务 12.14，需求 14.1）。
 *
 * 每个数据源列出**真正会被用到的那几个端点**，不追求覆盖整个 API。理由具体：工具清单会进
 * 模型的上下文，一个数据源暴露三十个工具的话，五十个数据源就是一千五百个工具描述——
 * 那会把上下文预算吃光，而模型在一千五百个选项里的选择质量比在三五个里差得多。
 *
 * 选端点的标准是「研究流程里真的会走到这一步吗」。比如 UniProt 暴露「按 accession 取条目」
 * 与「按基因名检索」，不暴露「取该条目的第 N 版历史」。
 *
 * 每个工具的 `description` 写给模型看，因此要说清**什么时候用它**与**参数是什么格式**。
 * 标识符格式是这里最容易出错的地方（Ensembl ID vs 基因符号 vs UniProt accession），
 * 因此凡涉及标识符的都在描述里点明。
 */

import type { BridgeSpec } from './bridge.js';

/**
 * 礼貌性标识。
 *
 * NCBI、EBI 等公共服务都要求或建议请求带上可识别的 UA（有的在超限时按 UA 限流而不是
 * 直接封 IP）。不带的后果是在高频使用下被静默降速，而那个现象看起来像「数据源今天很慢」。
 */
const UA = { 'user-agent': 'L-science/1 (research workbench; local-first)' } as const;

/**
 * 「慢端点」的超时。
 *
 * 少数接口本身就需要一分钟以上（BindingDB 按 UniProt 查亲和力实测五十多秒，
 * GWAS Catalog 按大性状取全部关联更久）。默认的 45 秒会让它们在正常使用下就超时。
 *
 * 上限来自 `McpClient` 的 `DEFAULT_CALL_TIMEOUT_MS`（120 秒）：**桥的超时必须更短**，
 * 否则客户端先放弃，而上游还在为一个没人接收的结果干活。留十秒余量给往返与解析。
 */
const LONG_TIMEOUT_MS = 110_000;

export const BRIDGE_SPECS: readonly BridgeSpec[] = [
  /* ================= 基因组与注释 ================= */
  {
    id: 'ensembl',
    baseUrl: 'https://rest.ensembl.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'lookup_symbol',
        description:
          '按物种与基因符号查基因（拿 Ensembl 稳定 ID、坐标、链向、生物类型）。' +
          'species 用 Ensembl 的物种名，如 homo_sapiens、mus_musculus。',
        path: '/lookup/symbol/{species}/{symbol}',
        params: [
          {
            name: 'species',
            in: 'path',
            type: 'string',
            required: true,
            description: '物种名，如 homo_sapiens',
          },
          {
            name: 'symbol',
            in: 'path',
            type: 'string',
            required: true,
            description: '基因符号，如 BRCA1',
          },
          {
            name: 'expand',
            in: 'query',
            type: 'number',
            description: '设为 1 时一并返回转录本列表',
          },
        ],
        fixedQuery: { 'content-type': 'application/json' },
      },
      {
        name: 'lookup_id',
        description: '按 Ensembl 稳定 ID（ENSG/ENST/ENSP）查对象详情。',
        path: '/lookup/id/{id}',
        params: [
          {
            name: 'id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Ensembl 稳定 ID',
          },
          { name: 'expand', in: 'query', type: 'number', description: '设为 1 时展开子对象' },
        ],
        fixedQuery: { 'content-type': 'application/json' },
      },
      {
        name: 'sequence',
        description:
          '取序列。type 可为 genomic / cds / cdna / protein。做结构预测的输入序列应当从这里取，' +
          '不要手抄。',
        path: '/sequence/id/{id}',
        params: [
          {
            name: 'id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Ensembl 稳定 ID',
          },
          {
            name: 'type',
            in: 'query',
            type: 'string',
            description: '序列类型',
            enum: ['genomic', 'cds', 'cdna', 'protein'],
            default: 'protein',
          },
        ],
        fixedQuery: { 'content-type': 'application/json' },
      },
      {
        name: 'vep_hgvs',
        description:
          'VEP 变异效应注释，输入 HGVS 记法（如 ENST00000366667:c.803C>T 或 9:g.22125504G>C）。' +
          '返回后果类型、受影响转录本、SIFT/PolyPhen 预测。做变异解读的标准注释来源。',
        path: '/vep/{species}/hgvs/{hgvs}',
        params: [
          {
            name: 'species',
            in: 'path',
            type: 'string',
            required: true,
            description: '物种名',
            default: 'homo_sapiens',
          },
          { name: 'hgvs', in: 'path', type: 'string', required: true, description: 'HGVS 记法' },
        ],
        fixedQuery: { 'content-type': 'application/json' },
      },
      {
        name: 'overlap_region',
        description:
          '取某个基因组区间内的特征。feature 可为 gene / transcript / exon / regulatory 等。' +
          'region 格式 chr:start-end（不带 chr 前缀，如 7:140424943-140624564）。',
        path: '/overlap/region/{species}/{region}',
        params: [
          {
            name: 'species',
            in: 'path',
            type: 'string',
            required: true,
            description: '物种名',
            default: 'homo_sapiens',
          },
          {
            name: 'region',
            in: 'path',
            type: 'string',
            required: true,
            description: '区间，如 7:140424943-140624564',
          },
          {
            name: 'feature',
            in: 'query',
            type: 'string',
            required: true,
            description: '特征类型',
            default: 'gene',
          },
        ],
        fixedQuery: { 'content-type': 'application/json' },
        limit: 200,
      },
    ],
  },
  {
    id: 'ucsc',
    baseUrl: 'https://api.genome.ucsc.edu',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'list_genomes',
        description: '列出可用的基因组版本（hg38、hg19、mm39…）。跨版本对齐前先确认版本标识。',
        path: '/list/ucscGenomes',
        pick: 'ucscGenomes',
      },
      {
        name: 'get_sequence',
        description:
          '取某个基因组区间的序列。chrom 要带 chr 前缀（chr7），start 是 0-based，end 是 exclusive。' +
          '**坐标系与 Ensembl 不同**，跨源使用时必须换算。',
        path: '/getData/sequence',
        params: [
          {
            name: 'genome',
            in: 'query',
            type: 'string',
            required: true,
            description: '基因组版本，如 hg38',
          },
          {
            name: 'chrom',
            in: 'query',
            type: 'string',
            required: true,
            description: '染色体，如 chr7',
          },
          {
            name: 'start',
            in: 'query',
            type: 'number',
            required: true,
            description: '起点（0-based）',
          },
          {
            name: 'end',
            in: 'query',
            type: 'number',
            required: true,
            description: '终点（exclusive）',
          },
        ],
      },
      {
        name: 'track_data',
        description: '取某条轨道在指定区间的数据。track 名用 list_tracks 查。',
        path: '/getData/track',
        params: [
          {
            name: 'genome',
            in: 'query',
            type: 'string',
            required: true,
            description: '基因组版本',
          },
          { name: 'track', in: 'query', type: 'string', required: true, description: '轨道名' },
          { name: 'chrom', in: 'query', type: 'string', required: true, description: '染色体' },
          { name: 'start', in: 'query', type: 'number', description: '起点（0-based）' },
          { name: 'end', in: 'query', type: 'number', description: '终点' },
        ],
        limit: 500,
      },
    ],
  },

  /* ================= 基因与本体 ================= */
  {
    id: 'mygene',
    baseUrl: 'https://mygene.info/v3',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'query',
        description:
          '基因检索与标识符映射。q 支持字段限定，如 symbol:BRCA1、ensembl.gene:ENSG00000012048。' +
          '**几乎每个组学流程的第一步**：把手上的标识符统一成下游需要的那种。',
        path: '/query',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: '检索式' },
          { name: 'species', in: 'query', type: 'string', description: '物种', default: 'human' },
          {
            name: 'fields',
            in: 'query',
            type: 'string',
            description: '返回字段，逗号分隔',
            default: 'symbol,name,entrezgene,ensembl.gene,uniprot.Swiss-Prot,alias',
          },
          { name: 'size', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: 'hits',
        limit: 50,
      },
      {
        name: 'get_gene',
        description: '按 Entrez ID 或 Ensembl gene ID 取基因详情。',
        path: '/gene/{id}',
        params: [
          {
            name: 'id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Entrez ID 或 Ensembl gene ID',
          },
          { name: 'fields', in: 'query', type: 'string', description: '返回字段，逗号分隔' },
        ],
      },
    ],
  },
  {
    id: 'uniprot',
    baseUrl: 'https://rest.uniprot.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'get_entry',
        description:
          '按 UniProt accession（如 P38398）取蛋白条目：序列、功能、结构域、修饰、变异、交叉引用。',
        path: '/uniprotkb/{accession}',
        params: [
          {
            name: 'accession',
            in: 'path',
            type: 'string',
            required: true,
            description: 'UniProt accession',
          },
          {
            name: 'fields',
            in: 'query',
            type: 'string',
            description: '限定返回字段可显著减小体积',
            default:
              'accession,id,protein_name,gene_names,organism_name,sequence,ft_domain,cc_function,cc_subcellular_location',
          },
        ],
      },
      {
        name: 'search',
        description:
          '检索蛋白条目。query 支持 Lucene 语法，如 gene:BRCA1 AND organism_id:9606 AND reviewed:true。' +
          '**加上 reviewed:true 只取 Swiss-Prot**，否则会混进大量未审阅条目。',
        path: '/uniprotkb/search',
        params: [
          { name: 'query', in: 'query', type: 'string', required: true, description: '检索式' },
          { name: 'size', in: 'query', type: 'number', description: '条数上限', default: 10 },
          {
            name: 'fields',
            in: 'query',
            type: 'string',
            description: '返回字段',
            default: 'accession,id,protein_name,gene_names,organism_name,length',
          },
        ],
        fixedQuery: { format: 'json' },
        pick: 'results',
        limit: 25,
      },
      {
        name: 'get_fasta',
        // FASTA 不是 JSON。不声明的话桥会按「期望 JSON 却拿到别的东西」报错
        responseType: 'text',
        description: '取蛋白序列的 FASTA。结构预测的输入。',
        path: '/uniprotkb/{accession}.fasta',
        params: [
          {
            name: 'accession',
            in: 'path',
            type: 'string',
            required: true,
            description: 'UniProt accession',
          },
        ],
        headers: { accept: 'text/plain' },
      },
    ],
  },
  {
    id: 'go',
    baseUrl: 'https://api.geneontology.org/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'autocomplete_genes',
        description:
          '按关键词模糊匹配基因产物，返回与该关键词相关的 GO 注释所涉及的基因。' +
          '**关键词换 GO ID 不要用这个**——它无论 category 传什么都只回基因产物；' +
          '要「autophagy → GO:0006914」请用 `ols.search`（传 ontology=go），' +
          '拿到 GO ID 后再用本连接器的 `get_term` 或 `genes_for_term`。' +
          '结果里的 highlight 字段说明是哪个注释命中了关键词。',
        path: '/search/entity/autocomplete/{query}',
        params: [
          { name: 'query', in: 'path', type: 'string', required: true, description: '关键词' },
          { name: 'rows', in: 'query', type: 'number', description: '条数上限', default: 15 },
          {
            name: 'category',
            in: 'query',
            type: 'string',
            // 服务端只接受 gene / term 两个值，传别的会回 422（不是被忽略）
            description: '服务端只接受 gene 或 term；两者返回的都是基因产物，只是排序不同',
            enum: ['gene', 'term'],
            default: 'gene',
          },
        ],
        pick: 'docs',
        limit: 25,
      },
      {
        name: 'get_term',
        description: '按 GO ID 取术语元数据（定义、同义词、所属命名空间）。id 形如 GO:0006914。',
        path: '/go/{id}',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'GO ID' }],
      },
      {
        name: 'gene_annotations',
        description:
          '取某个基因产物的 GO 注释。' +
          '**id 必须是 CURIE 且前缀要对**：人类蛋白用 `UniProtKB:P38398`。' +
          'NCBIGene 前缀在这个接口上查不到（会回 404 说 bioentity 不存在），' +
          '基因符号先经 `mygene.query` 或 `uniprot.search` 换成 UniProt accession。',
        path: '/bioentity/gene/{id}/function',
        params: [
          {
            name: 'id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'CURIE 形式的基因标识，如 UniProtKB:P38398',
          },
          { name: 'rows', in: 'query', type: 'number', description: '条数上限', default: 50 },
        ],
        pick: 'associations',
        limit: 100,
      },
      {
        name: 'genes_for_term',
        description:
          '反向查询：某个 GO 术语注释了哪些基因产物。做富集分析的背景集合时用。' +
          'id 形如 GO:0006914，taxon 用 NCBITaxon:9606 限定人类。',
        path: '/bioentity/function/{id}/genes',
        params: [
          { name: 'id', in: 'path', type: 'string', required: true, description: 'GO ID' },
          {
            name: 'taxon',
            in: 'query',
            type: 'string',
            description: '物种 CURIE',
            default: 'NCBITaxon:9606',
          },
          { name: 'rows', in: 'query', type: 'number', description: '条数上限', default: 100 },
        ],
        pick: 'associations',
        limit: 200,
      },
    ],
  },
  {
    id: 'reactome',
    baseUrl: 'https://reactome.org/ContentService',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description: '检索通路与实体。返回 stId（稳定标识）供后续查询。',
        path: '/search/query',
        params: [
          { name: 'query', in: 'query', type: 'string', required: true, description: '关键词' },
          {
            name: 'species',
            in: 'query',
            type: 'string',
            description: '物种',
            default: 'Homo sapiens',
          },
        ],
        limit: 30,
      },
      {
        name: 'pathways_for_gene',
        description:
          '取某个基因/蛋白参与的通路。id 可用 UniProt accession 或基因符号。做机制假设时的起点。',
        path: '/data/mapping/UniProt/{id}/pathways',
        params: [
          {
            name: 'id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'UniProt accession',
          },
          {
            name: 'species',
            in: 'query',
            type: 'string',
            description: '物种',
            default: 'Homo sapiens',
          },
        ],
        limit: 60,
      },
      {
        name: 'pathway_participants',
        description: '取某条通路的参与实体。stId 形如 R-HSA-68886。',
        path: '/data/pathway/{stId}/containedEvents',
        params: [
          {
            name: 'stId',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Reactome 稳定标识',
          },
        ],
        limit: 100,
      },
    ],
  },
  {
    id: 'ols',
    baseUrl: 'https://www.ebi.ac.uk/ols4/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '跨本体术语检索（EFO、MONDO、HPO、UBERON、CL…）。' +
          '**把自由文本的表型/组织名映射到标准术语**，是跨数据源整合的前提。' +
          'ontology 参数可限定单个本体，如 mondo。',
        path: '/search',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: '关键词' },
          { name: 'ontology', in: 'query', type: 'string', description: '限定本体（小写缩写）' },
          { name: 'rows', in: 'query', type: 'number', description: '条数上限', default: 15 },
        ],
        pick: 'response.docs',
        limit: 25,
      },
    ],
  },

  /* ================= 变异与群体频率 ================= */
  {
    id: 'gnomad',
    baseUrl: 'https://gnomad.broadinstitute.org/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'gene_constraint',
        description:
          '取基因的约束指标（pLI、LOEUF、o/e）与功能缺失变异统计。' +
          '**判断一个基因能否容忍功能缺失**——高约束意味着抑制该靶点可能有安全风险。' +
          'geneSymbol 用基因符号，dataset 通常 gnomad_r4。',
        path: '/',
        graphql: `query GeneConstraint($geneSymbol: String!, $referenceGenome: ReferenceGenomeId!) {
  gene(gene_symbol: $geneSymbol, reference_genome: $referenceGenome) {
    gene_id
    symbol
    gnomad_constraint { pLI oe_lof oe_lof_lower oe_lof_upper exp_lof obs_lof oe_mis }
  }
}`,
        params: [
          {
            name: 'geneSymbol',
            in: 'body',
            type: 'string',
            required: true,
            description: '基因符号，如 BRCA1',
          },
          {
            name: 'referenceGenome',
            in: 'body',
            type: 'string',
            description: '参考基因组',
            enum: ['GRCh37', 'GRCh38'],
            default: 'GRCh38',
          },
        ],
        pick: 'data.gene',
      },
      {
        name: 'variant_frequency',
        description:
          '取单个变异的群体等位频率。variantId 形如 1-55516888-G-GA（chrom-pos-ref-alt，不带 chr）。' +
          '判断变异是否常见——常见变异通常不是致病变异。',
        path: '/',
        graphql: `query VariantFreq($variantId: String!, $dataset: DatasetId!) {
  variant(variantId: $variantId, dataset: $dataset) {
    variant_id
    rsids
    genome { ac an af homozygote_count populations { id ac an } }
    exome { ac an af homozygote_count }
  }
}`,
        params: [
          {
            name: 'variantId',
            in: 'body',
            type: 'string',
            required: true,
            description: 'chrom-pos-ref-alt',
          },
          {
            name: 'dataset',
            in: 'body',
            type: 'string',
            description: '数据集版本',
            default: 'gnomad_r4',
          },
        ],
        pick: 'data.variant',
      },
    ],
  },
  {
    id: 'clinvar',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '检索 ClinVar 记录，返回 UID 列表。term 支持字段限定，如 BRCA1[gene] AND "pathogenic"[Clinical significance]。',
        path: '/esearch.fcgi',
        params: [
          { name: 'term', in: 'query', type: 'string', required: true, description: '检索式' },
          { name: 'retmax', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { db: 'clinvar', retmode: 'json' },
        pick: 'esearchresult',
      },
      {
        name: 'summary',
        description:
          '按 UID 取记录摘要：临床意义、评审状态、提交者、关联疾病。' +
          '**有冲突的记录要看具体提交者与评审状态**，不能只取一个标签。',
        path: '/esummary.fcgi',
        params: [
          { name: 'id', in: 'query', type: 'string', required: true, description: 'UID，逗号分隔' },
        ],
        fixedQuery: { db: 'clinvar', retmode: 'json' },
        pick: 'result',
      },
    ],
  },
  {
    id: 'dbsnp',
    baseUrl: 'https://api.ncbi.nlm.nih.gov/variation/v0',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'get_rsid',
        description:
          '按 rsID 取变异信息：基因组位置、等位、频率来源。rs 号只给数字部分（如 328 而不是 rs328）。' +
          '跨数据源对齐变异标识符时用。',
        path: '/refsnp/{rsid}',
        params: [
          {
            name: 'rsid',
            in: 'path',
            type: 'string',
            required: true,
            description: 'rs 号的数字部分',
          },
        ],
      },
    ],
  },

  /* ================= 人类遗传学关联 ================= */
  {
    id: 'gwas-catalog',
    baseUrl: 'https://www.ebi.ac.uk/gwas/rest/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'associations_for_gene',
        description:
          '取与某基因关联的 GWAS 信号。**注意报告的「最近基因」常常不是效应基因**，' +
          '要配 eQTL 共定位证据一起看。',
        path: '/singleNucleotidePolymorphisms/search/findByGene',
        params: [
          {
            name: 'geneName',
            in: 'query',
            type: 'string',
            required: true,
            description: '基因符号',
          },
          { name: 'size', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: '_embedded.singleNucleotidePolymorphisms',
        limit: 50,
      },
      {
        name: 'find_trait',
        description:
          '按性状名找它在 GWAS Catalog 里的本体编号与规范名称。' +
          '很多性状已从 EFO 迁到 MONDO（asthma 现在是 MONDO_0004979 而非旧的 EFO 编号），' +
          '拿本体编号去别的库（Open Targets、OLS）做交叉查询时用这个先对齐。' +
          '按性状找信号则用 `studies_for_trait`，它接受性状名本身。',
        path: '/efoTraits/search/findByEfoTrait',
        params: [
          {
            name: 'trait',
            in: 'query',
            type: 'string',
            required: true,
            description: '性状名，如 asthma',
          },
        ],
        pick: '_embedded.efoTraits',
        limit: 20,
      },
      {
        name: 'studies_for_trait',
        description:
          '取研究过某性状的 GWAS 研究列表：样本量、人群构成、平台、是否有完整汇总统计（fullPvalueSet）。' +
          '**按性状找信号要走这条路**：先拿研究列表，再用 `associations_for_study` 逐个取关联。' +
          '直接按性状取全部关联的接口在服务端要跑两分钟以上，做不成交互式工具。' +
          '**人群构成必须看**：以欧洲人群为主的效应量不能直接搬到别的人群上。',
        path: '/studies/search/findByEfoTrait',
        params: [
          {
            name: 'efoTrait',
            in: 'query',
            type: 'string',
            required: true,
            description: '性状名，如 asthma',
          },
          { name: 'size', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: '_embedded.studies',
        limit: 40,
      },
      {
        name: 'associations_for_study',
        description:
          '取某个 GWAS 研究报告的关联信号（p 值、效应量、风险等位频率、报告的基因）。' +
          'accessionId 用 `studies_for_trait` 返回的 GCST 编号。' +
          '**返回空数组是正常情况**——只提交了完整汇总统计而没有整理出显著位点的研究就是空的，' +
          '那不是查询失败，换下一个研究即可。',
        path: '/studies/{accessionId}/associations',
        params: [
          {
            name: 'accessionId',
            in: 'path',
            type: 'string',
            required: true,
            description: 'GCST 编号',
          },
          { name: 'size', in: 'query', type: 'number', description: '条数上限', default: 50 },
        ],
        pick: '_embedded.associations',
        limit: 50,
      },
    ],
  },
  {
    id: 'eqtl-catalogue',
    /*
     * eQTL Catalogue 的 REST API（`www.ebi.ac.uk/eqtl/api/v2`）已下线，现在会回
     * HTTP 410 并指向数据下载文档。数据本身没有停：目录表在项目的资源仓库里，
     * 汇总统计走 FTP + tabix 按区间取。
     *
     * 因此这个连接器提供的是**目录与路径**，具体区间由内核里的 tabix / pandas 去取
     * （`ftp.ebi.ac.uk` 已在本连接器的域名清单里，出口代理会放行）。
     */
    baseUrl: 'https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'list_datasets',
        description:
          '列出 eQTL Catalogue 的数据集目录（研究、组织/细胞类型、定量方式、样本量），制表符分隔。' +
          '先查它拿到 QTD 编号，再用 `tabix_paths` 取对应汇总统计文件的地址。',
        path: '/data_tables/dataset_metadata_r8.tsv',
        responseType: 'text',
      },
      {
        name: 'tabix_paths',
        description:
          '列出每个数据集汇总统计文件的 FTP 地址（可直接给 tabix 用）。' +
          '按区间取关联的写法：`tabix <ftp_path> 20:46120612-46120613`。' +
          '**不要在这里下整个文件**——单个数据集的全量汇总统计有数 GB，' +
          '按位点取区间才是设计意图；共定位分析要的正是区间。',
        path: '/tabix/tabix_ftp_paths.tsv',
        responseType: 'text',
      },
      {
        name: 'column_docs',
        description: '汇总统计文件的列定义（效应等位、beta 方向、pvalue 等）。解读结果前先看它。',
        path: '/tabix/Columns.md',
        responseType: 'text',
      },
    ],
  },
  {
    id: 'finngen',
    baseUrl: 'https://r12.finngen.fi/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'list_phenotypes',
        description: '列出 FinnGen 的表型端点及其病例数。芬兰人群富集变异在这里信号更强。',
        path: '/phenos',
        limit: 200,
      },
      {
        name: 'gene_results',
        description: '取某基因区域内的关联结果。gene 用基因符号。',
        path: '/gene_phenos/{gene}',
        params: [
          { name: 'gene', in: 'path', type: 'string', required: true, description: '基因符号' },
        ],
        limit: 100,
      },
    ],
  },
  {
    id: 'biobank-japan',
    baseUrl: 'https://pheweb.jp/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'list_phenotypes',
        description:
          '列出 BioBank Japan 的表型。**做跨人群一致性检验时必要**——多数 GWAS 以欧洲人群为主。',
        path: '/phenotypes.json',
        limit: 300,
      },
      {
        name: 'variant',
        description: '取某变异在各表型上的关联。variant 形如 1-55516888-G-A。',
        path: '/variant/{variant}',
        params: [
          {
            name: 'variant',
            in: 'path',
            type: 'string',
            required: true,
            description: 'chrom-pos-ref-alt',
          },
        ],
      },
    ],
  },

  /* ================= 临床基因组学 ================= */
  {
    id: 'clingen',
    /*
     * ClinGen 的能力散在三个主机上，而 `search.clinicalgenome.org` 是给人看的网页应用
     * （带 CSRF token 的 HTML，加 `format=json` 也还是 HTML）。可编程访问的是：
     *
     * - `erepo`：专家组判定的变异致病性（Variant Pathogenicity）
     * - `actionability`：基因-疾病对的临床可干预性评分
     * - `ftp`：基因效度与剂量敏感性的全量表（按基因查要自己过滤）
     *
     * 端点各自覆盖 baseUrl，见 `EndpointSpec.baseUrl`。
     */
    baseUrl: 'https://erepo.clinicalgenome.org/evrepo/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'variant_classifications',
        description:
          '取变异致病性判读（Pathogenic / Likely pathogenic / VUS / Likely benign / Benign），' +
          '由 ClinGen 的疾病专家组按该病种的特化 ACMG 规则做出。' +
          '**比 ClinVar 的聚合结论更权威**——ClinVar 汇总提交者意见，这里是专家组裁定。',
        path: '/classifications',
        params: [
          { name: 'gene', in: 'query', type: 'string', description: '基因符号，如 BRCA1' },
          { name: 'hgvs', in: 'query', type: 'string', description: 'HGVS 表达式' },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: 'variantInterpretations',
        limit: 40,
      },
      {
        name: 'gene_validity',
        description:
          '取基因-疾病效度评级的全量表（Definitive / Strong / Moderate / Limited / Disputed / Refuted），' +
          'CSV 文本。**这是全量下载而不是按基因查询**——ClinGen 没有提供按基因过滤的接口，' +
          '拿到后在内核里按基因符号列过滤。判断「这个基因真的与该疾病相关吗」用它。',
        baseUrl: 'https://search.clinicalgenome.org',
        path: '/kb/gene-validity/download',
        fixedQuery: { format: 'json' },
        responseType: 'text',
      },
      {
        name: 'dosage_sensitivity',
        description:
          '取基因的单倍剂量不足与三倍剂量敏感性评级全量表，制表符分隔。拷贝数变异解读用。' +
          '同样是全量表，按基因在内核里过滤。',
        baseUrl: 'https://ftp.clinicalgenome.org',
        path: '/ClinGen_gene_curation_list_GRCh38.tsv',
        responseType: 'text',
      },
      {
        name: 'actionability',
        description:
          '取临床可干预性评分：某个基因-疾病对在该年龄段人群里是否有可落地的干预措施。' +
          'context 选 Adult 或 Pediatric。返回全部已发布的评估，按基因在结果里筛。',
        baseUrl: 'https://actionability.clinicalgenome.org',
        path: '/ac/{context}/api/summ',
        params: [
          {
            name: 'context',
            in: 'path',
            type: 'string',
            required: true,
            description: '人群',
            enum: ['Adult', 'Pediatric'],
            default: 'Adult',
          },
        ],
        limit: 60,
      },
    ],
  },
  {
    id: 'civic',
    baseUrl: 'https://civicdb.org/api/graphql',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'gene_summary',
        description:
          '取某基因在 CIViC 里的概述与已收录变异清单。' +
          '先用它确认基因收录情况，再用 `variant_evidence` 拿具体变异的临床证据。',
        path: '',
        graphql: `query GeneSummary($entrezSymbol: String!, $first: Int!) {
  gene(entrezSymbol: $entrezSymbol) {
    id
    name
    entrezId
    description
    variants(first: $first) {
      totalCount
      nodes { id name }
    }
  }
}`,
        params: [
          {
            name: 'entrezSymbol',
            in: 'body',
            type: 'string',
            required: true,
            description: '基因符号，如 BRCA1',
          },
          { name: 'first', in: 'body', type: 'number', description: '变异条数上限', default: 25 },
        ],
        pick: 'data.gene',
      },
      {
        name: 'variant_evidence',
        description:
          '取某基因下各变异的临床证据规模、关联疾病与疗法。肿瘤变异的可操作性判断用它。' +
          'featureName 传基因符号；evidenceItemCount 为 0 的变异只是被收录、还没有证据条目。',
        path: '',
        graphql: `query VariantEvidence($featureName: String!, $first: Int!) {
  browseVariants(featureName: $featureName, first: $first) {
    totalCount
    nodes {
      id
      name
      featureName
      evidenceItemCount
      diseases { name doid }
      therapies { name ncitId }
      variantTypes { name }
    }
  }
}`,
        params: [
          {
            name: 'featureName',
            in: 'body',
            type: 'string',
            required: true,
            description: '基因符号，如 BRCA1',
          },
          { name: 'first', in: 'body', type: 'number', description: '条数上限', default: 25 },
        ],
        pick: 'data.browseVariants.nodes',
        limit: 50,
      },
    ],
  },
  {
    id: 'open-targets',
    baseUrl: 'https://api.platform.opentargets.org/api/v4/graphql',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'target_associations',
        description:
          '取某靶点关联的疾病及各类证据分数（遗传学、体细胞、药物、通路、文献、动物模型）。' +
          'ensemblId 用 ENSG 形式。`indication-dossier` 技能的主要数据源。',
        path: '',
        graphql: `query TargetAssoc($ensemblId: String!, $size: Int!) {
  target(ensemblId: $ensemblId) {
    approvedSymbol
    biotype
    associatedDiseases(page: { index: 0, size: $size }) {
      count
      rows { disease { id name } score datatypeScores { id score } }
    }
  }
}`,
        params: [
          {
            name: 'ensemblId',
            in: 'body',
            type: 'string',
            required: true,
            description: 'Ensembl gene ID（ENSG…）',
          },
          { name: 'size', in: 'body', type: 'number', description: '条数上限', default: 25 },
        ],
        pick: 'data.target',
      },
      {
        name: 'target_tractability',
        description:
          '取靶点的可成药性评估与已知药物。判断模态可行性（小分子/抗体/其他）时用。' +
          '`tractability` 每条是「某模态下某个证据桶是否成立」：' +
          'label 是桶名（如 Approved Drug、High-Quality Pocket），modality 是模态，value 是布尔。',
        path: '',
        // `knownDrugs` 已被 `drugAndClinicalCandidates` 取代，
        // 药物阶段字段也从 maximumClinicalTrialPhase 改成了 maximumClinicalStage
        graphql: `query Tractability($ensemblId: String!) {
  target(ensemblId: $ensemblId) {
    approvedSymbol
    tractability { label modality value }
    subcellularLocations { location source }
    targetClass { label }
    drugAndClinicalCandidates {
      count
      rows {
        maxClinicalStage
        drug {
          id
          name
          drugType
          maximumClinicalStage
          mechanismsOfAction { rows { mechanismOfAction actionType } }
        }
        diseases { disease { id name } }
      }
    }
  }
}`,
        params: [
          {
            name: 'ensemblId',
            in: 'body',
            type: 'string',
            required: true,
            description: 'Ensembl gene ID',
          },
        ],
        pick: 'data.target',
      },
      {
        name: 'disease_targets',
        description: '反向查询：某疾病关联的靶点排序。efoId 用 EFO/MONDO ID。',
        path: '',
        graphql: `query DiseaseTargets($efoId: String!, $size: Int!) {
  disease(efoId: $efoId) {
    name
    associatedTargets(page: { index: 0, size: $size }) {
      count
      rows { target { id approvedSymbol } score datatypeScores { id score } }
    }
  }
}`,
        params: [
          {
            name: 'efoId',
            in: 'body',
            type: 'string',
            required: true,
            description: 'EFO 或 MONDO ID',
          },
          { name: 'size', in: 'body', type: 'number', description: '条数上限', default: 25 },
        ],
        pick: 'data.disease',
      },
    ],
  },

  /* ================= 表达 ================= */
  {
    id: 'gtex',
    baseUrl: 'https://gtexportal.org/api/v2',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'median_expression',
        description:
          '取基因在各组织的中位表达（TPM）。**评估「靶点在关键正常组织表达吗」这个安全性问题的第一站**。' +
          'gencodeId 用带版本的 Ensembl ID（如 ENSG00000012048.23），不确定时先用 gene_search 查。',
        path: '/expression/medianGeneExpression',
        params: [
          {
            name: 'gencodeId',
            in: 'query',
            type: 'string',
            required: true,
            description: '带版本的 Ensembl gene ID',
          },
          {
            name: 'datasetId',
            in: 'query',
            type: 'string',
            description: '数据集',
            default: 'gtex_v8',
          },
        ],
        pick: 'data',
        limit: 60,
      },
      {
        name: 'gene_search',
        description: '按基因符号查 GTEx 的 gencodeId。上面那个端点需要它。',
        path: '/reference/gene',
        params: [
          { name: 'geneId', in: 'query', type: 'string', required: true, description: '基因符号' },
        ],
        pick: 'data',
        limit: 20,
      },
    ],
  },

  /* ================= 调控 ================= */
  {
    id: 'encode',
    baseUrl: 'https://www.encodeproject.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_experiments',
        description:
          '检索 ENCODE 实验。assay_title 如 "TF ChIP-seq"、"DNase-seq"、"ATAC-seq"；' +
          'biosample_ontology.term_name 是细胞类型/组织名。',
        path: '/search/',
        params: [
          { name: 'searchTerm', in: 'query', type: 'string', description: '自由文本' },
          { name: 'assay_title', in: 'query', type: 'string', description: '实验类型' },
          {
            name: 'target.label',
            in: 'query',
            type: 'string',
            description: '靶蛋白（TF ChIP-seq 用）',
          },
          {
            name: 'biosample_ontology.term_name',
            in: 'query',
            type: 'string',
            description: '细胞类型或组织',
          },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { type: 'Experiment', format: 'json', status: 'released' },
        pick: '@graph',
        limit: 40,
      },
    ],
  },
  {
    id: 'jaspar',
    baseUrl: 'https://jaspar.elixir.no/api/v1',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_matrix',
        description: '按转录因子名检索结合基序矩阵。返回 matrix_id 供取 PWM。',
        path: '/matrix/',
        params: [
          { name: 'search', in: 'query', type: 'string', required: true, description: 'TF 名称' },
          { name: 'collection', in: 'query', type: 'string', description: '集合', default: 'CORE' },
          {
            name: 'tax_group',
            in: 'query',
            type: 'string',
            description: '分类群',
            default: 'vertebrates',
          },
        ],
        fixedQuery: { format: 'json' },
        pick: 'results',
        limit: 40,
      },
      {
        name: 'get_matrix',
        description: '按 matrix_id 取 PWM 矩阵本体。做基序扫描的输入。',
        path: '/matrix/{matrix_id}/',
        params: [
          {
            name: 'matrix_id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'JASPAR matrix ID，如 MA0139.1',
          },
        ],
        fixedQuery: { format: 'json' },
      },
    ],
  },
  {
    id: 'unibind',
    baseUrl: 'https://unibind.uio.no/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_datasets',
        description:
          '检索经 ChIP-seq 校准的高置信 TF 结合位点数据集。**比纯基序扫描的假阳性低得多**——' +
          '要「这个 TF 确实结合在这里」的证据时用它而不是 JASPAR 扫描。' +
          '每条结果的 url 指向该数据集，追加 `?format=bed` 可取位点坐标。' +
          '过滤参数名是 `tf_name` 而不是 `tf`（写成 `tf` 不报错，但过滤会被忽略，' +
          '于是你拿到的是全库前几条）。',
        path: '/v1/datasets',
        params: [
          { name: 'tf_name', in: 'query', type: 'string', description: 'TF 名称，如 CTCF' },
          { name: 'cell_line', in: 'query', type: 'string', description: '细胞类型/细胞系' },
          {
            name: 'collection',
            in: 'query',
            type: 'string',
            description: 'Robust 只保留高置信集合，Permissive 覆盖更广',
            enum: ['Robust', 'Permissive'],
          },
          {
            name: 'species',
            in: 'query',
            type: 'string',
            description: '物种拉丁名，如 Homo sapiens',
          },
          { name: 'page', in: 'query', type: 'number', description: '页码（每页 10 条）' },
        ],
        fixedQuery: { format: 'json' },
        pick: 'results',
        limit: 50,
      },
      {
        name: 'list_tfs',
        description: '列出 UniBind 收录的全部 TF 名称。用来确认某个 TF 是否有实验数据。',
        path: '/v1/tfs',
        fixedQuery: { format: 'json' },
        pick: 'results',
        limit: 700,
      },
      {
        name: 'list_cell_types',
        description: '列出收录的细胞类型/细胞系。挑与研究体系最接近的那个。',
        path: '/v1/celltypes',
        fixedQuery: { format: 'json' },
        pick: 'results',
        limit: 200,
      },
    ],
  },

  /* ================= 蛋白注释 ================= */
  {
    id: 'interpro',
    baseUrl: 'https://www.ebi.ac.uk/interpro/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'entries_for_protein',
        description:
          '取某蛋白上的 InterPro 条目（家族、结构域、位点）与它们的位置。' +
          '判断一段序列属于哪个家族、结构域边界在哪，用它。accession 用 UniProt accession。',
        path: '/entry/all/protein/uniprot/{accession}',
        params: [
          {
            name: 'accession',
            in: 'path',
            type: 'string',
            required: true,
            description: 'UniProt accession',
          },
        ],
        fixedQuery: { format: 'json', page_size: '100' },
        pick: 'results',
        limit: 100,
      },
    ],
  },
  {
    id: 'pfam',
    baseUrl: 'https://www.ebi.ac.uk/interpro/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'domains_for_protein',
        description: '取某蛋白上的 Pfam 结构域及位置。做域级分析与切域预测时用。',
        path: '/entry/pfam/protein/uniprot/{accession}',
        params: [
          {
            name: 'accession',
            in: 'path',
            type: 'string',
            required: true,
            description: 'UniProt accession',
          },
        ],
        fixedQuery: { format: 'json', page_size: '100' },
        pick: 'results',
        limit: 100,
      },
      {
        name: 'get_family',
        description: '取 Pfam 家族详情。accession 形如 PF00533。',
        path: '/entry/pfam/{accession}',
        params: [
          {
            name: 'accession',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Pfam accession',
          },
        ],
        fixedQuery: { format: 'json' },
      },
    ],
  },
  {
    id: 'human-protein-atlas',
    baseUrl: 'https://www.proteinatlas.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '取蛋白的组织/细胞类型表达与亚细胞定位。' +
          '**判断模态可行性靠这里的定位**：膜与分泌蛋白可做抗体，胞内需小分子或降解剂。' +
          'search 用基因符号。',
        path: '/api/search_download.php',
        params: [
          { name: 'search', in: 'query', type: 'string', required: true, description: '基因符号' },
          {
            name: 'columns',
            in: 'query',
            type: 'string',
            description: '返回列',
            default: 'g,gs,eg,rnatsm,rnatd,scl,scml,up',
          },
        ],
        fixedQuery: { format: 'json', compress: 'no' },
        limit: 20,
      },
    ],
  },
  {
    id: 'string',
    baseUrl: 'https://string-db.org/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'interaction_partners',
        description:
          '取某蛋白的相互作用伙伴，带各类证据分数。' +
          '**注意它混合了实验、共表达与文本挖掘证据**——用的时候按证据类型过滤，' +
          '只看 combined_score 会把文本挖掘的弱证据当成实验证据。' +
          'species 用 NCBI 分类 ID（人是 9606）。',
        path: '/json/interaction_partners',
        params: [
          {
            name: 'identifiers',
            in: 'query',
            type: 'string',
            required: true,
            description: '基因符号或 UniProt，多个用 %0d 分隔',
          },
          {
            name: 'species',
            in: 'query',
            type: 'number',
            description: 'NCBI 分类 ID',
            default: 9606,
          },
          { name: 'limit', in: 'query', type: 'number', description: '伙伴数上限', default: 20 },
          {
            name: 'required_score',
            in: 'query',
            type: 'number',
            description: '最低组合分（0-1000）',
            default: 700,
          },
        ],
        limit: 50,
      },
      {
        name: 'enrichment',
        description: '对一组基因做功能富集（GO、KEGG、Pfam…）。identifiers 用换行或 %0d 分隔。',
        path: '/json/enrichment',
        params: [
          {
            name: 'identifiers',
            in: 'query',
            type: 'string',
            required: true,
            description: '基因列表',
          },
          {
            name: 'species',
            in: 'query',
            type: 'number',
            description: 'NCBI 分类 ID',
            default: 9606,
          },
        ],
        limit: 60,
      },
    ],
  },

  /* ================= 结构与相互作用 ================= */
  {
    id: 'pdb',
    baseUrl: 'https://data.rcsb.org/rest/v1',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'get_entry',
        description:
          '按 PDB ID 取结构条目：分辨率、方法、配体、实体。' +
          '**做对接或结构分析前先查这里有没有实验结构**——有的话不必用预测结构。',
        path: '/core/entry/{pdbId}',
        params: [
          {
            name: 'pdbId',
            in: 'path',
            type: 'string',
            required: true,
            description: '四字符 PDB ID',
          },
        ],
      },
      {
        name: 'entry_ligands',
        description:
          '取某条目的某个配体（非聚合物实体）的化学身份与描述。找共晶配体与化学起点时用。' +
          '**entityId 不能猜**：它是该条目内部的实体编号，只有含配体的条目才有非聚合物实体，' +
          '编号也不一定从 1 开始。先用 `get_entry` 读 ' +
          '`rcsb_entry_container_identifiers.non_polymer_entity_ids` 拿到可用编号。' +
          '猜错会得到 404，而那个 404 读起来像「这个结构没有配体」。',
        path: '/core/nonpolymer_entity/{pdbId}/{entityId}',
        params: [
          { name: 'pdbId', in: 'path', type: 'string', required: true, description: 'PDB ID' },
          {
            name: 'entityId',
            in: 'path',
            type: 'string',
            required: true,
            description: '非聚合物实体编号，从 get_entry 里取',
          },
        ],
      },
    ],
  },
  {
    id: 'alphafold-db',
    baseUrl: 'https://alphafold.ebi.ac.uk/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'prediction',
        description:
          '按 UniProt accession 取已预计算的 AlphaFold 结构，返回坐标与 PAE 文件的 URL 以及 pLDDT。' +
          '**`alphafold2` 技能的第一步就是查它**——天然序列不必自己重算。' +
          '长蛋白会被切成多个片段，每条记录的 sequenceStart/sequenceEnd 给出覆盖区间。' +
          '序列本身不在返回里，需要时用 `uniprot.get_fasta`。',
        path: '/prediction/{accession}',
        params: [
          {
            name: 'accession',
            in: 'path',
            type: 'string',
            required: true,
            description: 'UniProt accession',
          },
        ],
        // BRCA1 会返回 8 个片段，每片段带 sequence 与 uniprotSequence 两份 1863 aa 的序列。
        // 三万字符，而调用方要的是 pdbUrl
        omit: ['sequence', 'uniprotSequence', 'allVersions'],
        limit: 12,
      },
    ],
  },
  {
    id: 'emdb',
    baseUrl: 'https://www.ebi.ac.uk/emdb/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'get_entry',
        description: '按 EMD ID 取冷冻电镜图谱条目：分辨率、样品、拟合模型。emdbId 形如 EMD-1234。',
        path: '/entry/{emdbId}',
        params: [
          { name: 'emdbId', in: 'path', type: 'string', required: true, description: 'EMDB ID' },
        ],
      },
      {
        name: 'search',
        description: '检索 EMDB 条目。',
        path: '/search/{query}',
        params: [
          { name: 'query', in: 'path', type: 'string', required: true, description: '检索式' },
          { name: 'rows', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { wt: 'json' },
        limit: 40,
      },
    ],
  },
  {
    id: 'complex-portal',
    baseUrl: 'https://www.ebi.ac.uk/intact/complex-ws',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '检索经手工整理的稳定蛋白复合物及其**化学计量**。' +
          '做复合物结构预测前查它——化学计量必须显式给出，模型不会自己发现。',
        path: '/search/{query}',
        params: [
          {
            name: 'query',
            in: 'path',
            type: 'string',
            required: true,
            description: '基因符号或复合物名',
          },
          { name: 'number', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: 'elements',
        limit: 40,
      },
      {
        name: 'get_complex',
        description:
          '取某复合物的详情与组分（含每个组分的化学计量）。ac 是 Complex Portal 的 accession（CPX-…）。',
        // `/detail/{ac}` 会 404；当前路径是 /complex/{ac}
        path: '/complex/{ac}',
        params: [
          { name: 'ac', in: 'path', type: 'string', required: true, description: 'CPX accession' },
        ],
      },
    ],
  },
  {
    id: 'intact',
    baseUrl: 'https://www.ebi.ac.uk/intact/ws',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_interactions',
        description:
          '检索分子相互作用的实验证据，带检测方法与置信度。' +
          '要「这个相互作用有实验支持吗」时用它而不是 STRING（后者混了文本挖掘）。',
        path: '/interaction/findInteractions/{query}',
        params: [
          {
            name: 'query',
            in: 'path',
            type: 'string',
            required: true,
            description: '基因符号或 UniProt accession',
          },
          { name: 'page', in: 'query', type: 'number', description: '页码', default: 0 },
          { name: 'pageSize', in: 'query', type: 'number', description: '每页条数', default: 25 },
        ],
        pick: 'content',
        limit: 50,
      },
    ],
  },

  /* ================= RNA ================= */
  {
    id: 'rfam',
    baseUrl: 'https://rfam.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'get_family',
        description: '按 Rfam accession（RF00001 形式）取 RNA 家族详情与共变模型信息。',
        path: '/family/{accession}',
        params: [
          {
            name: 'accession',
            in: 'path',
            type: 'string',
            required: true,
            description: 'Rfam accession',
          },
        ],
        fixedQuery: { content_type: 'application/json' },
        pick: 'rfam',
      },
      {
        name: 'search',
        description:
          '按关键词检索 RNA 家族，返回 Rfam accession、家族类型与描述。' +
          '拿到 accession 后用 `get_family` 取共变模型细节。',
        // `/search?q=` 是给人看的网页（回 200 + HTML）；JSON 检索在 /search/keyword
        path: '/search/keyword',
        params: [
          { name: 'query', in: 'query', type: 'string', required: true, description: '关键词' },
        ],
        pick: 'results',
        limit: 30,
      },
    ],
  },

  /* ================= 组学归档 ================= */
  {
    id: 'geo',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '检索 GEO 数据集。term 支持字段限定，如 "sleep apnea"[All Fields] AND "Homo sapiens"[Organism] AND "expression profiling by high throughput sequencing"[DataSet Type]。' +
          '找可复用的对照数据或外部验证集时的首选。',
        path: '/esearch.fcgi',
        params: [
          { name: 'term', in: 'query', type: 'string', required: true, description: '检索式' },
          { name: 'retmax', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { db: 'gds', retmode: 'json' },
        pick: 'esearchresult',
      },
      {
        name: 'summary',
        description: '按 UID 取数据集摘要：标题、样本数、平台、物种、发布日期。',
        path: '/esummary.fcgi',
        params: [
          { name: 'id', in: 'query', type: 'string', required: true, description: 'UID，逗号分隔' },
        ],
        fixedQuery: { db: 'gds', retmode: 'json' },
        pick: 'result',
      },
    ],
  },
  {
    id: 'arrayexpress',
    baseUrl: 'https://www.ebi.ac.uk/biostudies/api/v1',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description: '检索 ArrayExpress / BioStudies 里的功能基因组学研究。元数据结构化程度较高。',
        path: '/search',
        params: [
          { name: 'query', in: 'query', type: 'string', required: true, description: '检索式' },
          { name: 'pageSize', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { collection: 'arrayexpress' },
        pick: 'hits',
        limit: 40,
      },
    ],
  },
  {
    id: 'pride',
    baseUrl: 'https://www.ebi.ac.uk/pride/ws/archive/v2',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_projects',
        description: '检索蛋白组学质谱项目：实验设计、物种、仪器、修饰。',
        path: '/search/projects',
        params: [
          { name: 'keyword', in: 'query', type: 'string', required: true, description: '关键词' },
          { name: 'pageSize', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        limit: 40,
      },
    ],
  },
  {
    id: 'mgnify',
    baseUrl: 'https://www.ebi.ac.uk/metagenomics/api/v1',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_studies',
        description: '检索宏基因组研究：环境类型、测序策略、样本数。',
        path: '/studies',
        params: [
          { name: 'search', in: 'query', type: 'string', description: '关键词' },
          { name: 'page_size', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: 'data',
        limit: 40,
      },
    ],
  },
  {
    id: 'metabolights',
    baseUrl: 'https://www.ebi.ac.uk/metabolights/ws',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'list_studies',
        description:
          '列出公开的代谢组学研究标识（只有 MTBLS 编号，没有标题）。' +
          '全库三千多条，这里只回前几十个；要找特定主题的研究应当用 `arrayexpress.search`' +
          '或 `europepmc`/`openalex` 定位到文章再回来取 `get_study`。',
        path: '/studies',
        pick: 'content',
        // 三千多个纯编号字符串对模型没有信息量，回一整页只是浪费预算
        limit: 60,
      },
      {
        name: 'get_study',
        description: '取某研究的详情。studyId 形如 MTBLS1。',
        path: '/studies/{studyId}',
        params: [
          {
            name: 'studyId',
            in: 'path',
            type: 'string',
            required: true,
            description: 'MetaboLights 研究 ID',
          },
        ],
      },
    ],
  },

  /* ================= 肿瘤队列 ================= */
  {
    id: 'cbioportal',
    baseUrl: 'https://www.cbioportal.org/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'list_studies',
        description:
          '列出可用的肿瘤队列研究。先查它拿到 studyId，再用它拼出分子谱 ID。' +
          'keyword 会在服务端过滤（按癌种或研究名），不传则返回前几十个。',
        path: '/studies',
        params: [
          { name: 'keyword', in: 'query', type: 'string', description: '按癌种或研究名过滤' },
        ],
        // 五百多个研究、每条都带一段 HTML 说明；描述字段剪掉，条数压到能读完的量
        omit: ['description', 'resourceCounts', 'readPermission', 'groups'],
        limit: 80,
      },
      {
        name: 'gene_mutations',
        description:
          '取某研究里某基因的突变。**做生存分析前注意队列的随访完整度与删失模式**' +
          '（见 `survival-analysis` 技能）。' +
          'entrezGeneId 是服务端要求的必填项（不给会 400），基因符号先用 `mygene.query` 换成 Entrez ID。' +
          'sampleListId 通常是 `<studyId>_all`。',
        path: '/molecular-profiles/{molecularProfileId}/mutations',
        params: [
          {
            name: 'molecularProfileId',
            in: 'path',
            type: 'string',
            required: true,
            description: '分子谱 ID，通常形如 <studyId>_mutations',
          },
          {
            name: 'entrezGeneId',
            in: 'query',
            type: 'number',
            required: true,
            description: 'Entrez 基因 ID（BRCA1 是 672）',
          },
          {
            name: 'sampleListId',
            in: 'query',
            type: 'string',
            description: '样本列表 ID，如 brca_tcga_all',
          },
          { name: 'pageSize', in: 'query', type: 'number', description: '条数上限', default: 100 },
        ],
        limit: 200,
      },
    ],
  },

  /* ================= 化学 ================= */
  {
    id: 'pubchem',
    baseUrl: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'compound_by_name',
        description:
          '按名称查化合物，取 CID、SMILES、InChIKey、分子式与性质。' +
          '**SMILES 从这里取而不是手写**——手抄最容易丢手性（见 `diffdock`）。' +
          '`SMILES` 带立体化学，`ConnectivitySMILES` 只有连接关系（无手性）。',
        // PubChem 2025 年改了属性名：CanonicalSMILES → ConnectivitySMILES，IsomericSMILES → SMILES。
        // 用旧名不会报错，只是响应里静默少这个字段——那种失败看起来像「这个化合物没有 SMILES」
        path: '/compound/name/{name}/property/SMILES,ConnectivitySMILES,InChIKey,MolecularFormula,MolecularWeight,XLogP,HBondDonorCount,HBondAcceptorCount,TPSA/JSON',
        params: [
          { name: 'name', in: 'path', type: 'string', required: true, description: '化合物名称' },
        ],
        pick: 'PropertyTable.Properties',
        limit: 10,
      },
      {
        name: 'compound_by_cid',
        description:
          '按 CID 取化合物性质。`SMILES` 带手性，做对接要用它；`ConnectivitySMILES` 不带。',
        path: '/compound/cid/{cid}/property/SMILES,ConnectivitySMILES,InChIKey,MolecularFormula,MolecularWeight,XLogP,TPSA/JSON',
        params: [
          { name: 'cid', in: 'path', type: 'string', required: true, description: 'PubChem CID' },
        ],
        pick: 'PropertyTable.Properties',
      },
      {
        name: 'similarity_search',
        description:
          '按 SMILES 做二维相似性检索，找类似物。threshold 是 Tanimoto 百分比（默认 90）。',
        path: '/compound/fastsimilarity_2d/smiles/{smiles}/cids/JSON',
        params: [
          {
            name: 'smiles',
            in: 'path',
            type: 'string',
            required: true,
            description: '查询 SMILES',
          },
          {
            name: 'Threshold',
            in: 'query',
            type: 'number',
            description: 'Tanimoto 阈值（百分比）',
            default: 90,
          },
          { name: 'MaxRecords', in: 'query', type: 'number', description: '条数上限', default: 50 },
        ],
        pick: 'IdentifierList.CID',
        limit: 100,
      },
    ],
  },
  {
    id: 'chebi',
    baseUrl: 'https://www.ebi.ac.uk/chebi/backend/api/public',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '检索生物相关小分子（代谢物、辅因子）的 ChEBI 条目与本体关系。' +
          '每条结果的 `_source.chebi_accession` 是 CHEBI: 编号，`stars` 是整理质量（3 星为人工审校）。',
        path: '/es_search/',
        params: [
          { name: 'term', in: 'query', type: 'string', required: true, description: '关键词' },
          { name: 'size', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: 'results',
        limit: 40,
      },
    ],
  },
  {
    id: 'rhea',
    baseUrl: 'https://www.rhea-db.org/rhea',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description: '检索生化反应。返回反应式与 ChEBI / UniProt 交叉引用。做代谢通路建模时用。',
        path: '/',
        params: [
          {
            name: 'query',
            in: 'query',
            type: 'string',
            required: true,
            description: '检索式（化合物名、EC 号、UniProt）',
          },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { format: 'json' },
        pick: 'results',
        limit: 40,
      },
    ],
  },
  {
    id: 'bindingdb',
    baseUrl: 'https://bindingdb.org/rest',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'affinities_by_uniprot',
        description:
          '取某靶点（UniProt accession）的实测结合亲和力（Ki / IC50 / Kd），带 SMILES 与文献 PMID。' +
          '**校验亲和力预测的排序质量就靠它**——见 `boltz-2` 里的 Spearman 核验。' +
          'cutoff 是亲和力上限（nM）；**放宽 cutoff 的代价很大**：EGFR 在 10 μM 下返回约 5 MB，' +
          '这个接口本身也要数十秒。先用 100 nM 试，不够再放宽。',
        path: '/getLigandsByUniprots',
        params: [
          {
            name: 'uniprot',
            in: 'query',
            type: 'string',
            required: true,
            description: 'UniProt accession，多个用逗号',
          },
          {
            name: 'cutoff',
            in: 'query',
            type: 'number',
            description: '亲和力上限（nM）',
            default: 100,
          },
        ],
        fixedQuery: { response: 'application/json' },
        // 服务端的键名就是这么拼的（少了 iga），不是笔误
        pick: 'getLindsByUniprotsResponse.affinities',
        limit: 150,
        // 实测 P00533 + cutoff 100 需要五十秒以上
        timeoutMs: LONG_TIMEOUT_MS,
      },
      {
        name: 'affinities_by_pdb',
        description:
          '按 PDB 条目取共晶配体的实测亲和力。有结构又有实测值时，这是对接打分最好的校准集。' +
          'identity 是靶点序列一致性阈值（百分比），放低会带进同源蛋白的数据。',
        path: '/getLigandsByPDBs',
        params: [
          {
            name: 'pdb',
            in: 'query',
            type: 'string',
            required: true,
            description: 'PDB ID，多个用逗号',
          },
          {
            name: 'cutoff',
            in: 'query',
            type: 'number',
            description: '亲和力上限（nM）',
            default: 1000,
          },
          {
            name: 'identity',
            in: 'query',
            type: 'number',
            description: '序列一致性阈值（%）',
            default: 100,
          },
        ],
        fixedQuery: { response: 'application/json' },
        // 与上面一样，服务端把 Ligands 拼成了 Linds
        pick: 'getLindsByPDBsResponse.affinities',
        limit: 150,
        timeoutMs: LONG_TIMEOUT_MS,
      },
    ],
  },
  {
    id: 'zinc',
    /*
     * `zinc20.docking.org` 现在把 `.json` 路径也交给单页应用渲染——请求它会得到 200 加
     * 一整页 HTML，而不是 404。可编程访问在 CartBlanche 上。
     */
    baseUrl: 'https://cartblanche22.docking.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'get_substance',
        description:
          '按 ZINC ID 取化合物：SMILES、分子量、logP、可采购目录与供应商编号。' +
          '虚拟筛选打分完成后用它确认候选物真的买得到——**买不到的先导化合物不能进实验**。' +
          'zincId 用补零的完整形式（ZINC000004175630），去零的短形式查不到。',
        path: '/substance/{zincId}.json',
        params: [
          {
            name: 'zincId',
            in: 'path',
            type: 'string',
            required: true,
            description: '完整 ZINC ID，如 ZINC000004175630',
          },
        ],
      },
      /*
       * `.smi` 路径在服务端会 500（不是 404），所以没有做成工具。
       * SMILES 已经在 `get_substance` 的返回里，不需要单独一个端点。
       */
      /*
       * 按 SMILES 做相似性检索没有做成工具。
       *
       * ZINC 现在的检索入口（CartBlanche）是**异步**的：POST 提交后只回一个任务 id，
       * 结果通过 WebSocket 推回来，没有可轮询的 REST 端点。声明式的桥表达不了这个形态，
       * 硬做会给出一个「提交成功但永远拿不到结果」的工具——那比没有这个工具更糟。
       * 结构相似性检索请用 `pubchem.similarity_search`，它是同步的，覆盖也更广。
       */
    ],
  },

  /* ================= 药物与监管 ================= */
  {
    id: 'openfda',
    baseUrl: 'https://api.fda.gov',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'drug_label',
        description:
          '检索药品说明书：适应症、警告、黑框警告、不良反应。' +
          'search 用 openFDA 语法，如 openfda.generic_name:"metformin"。',
        path: '/drug/label.json',
        params: [
          {
            name: 'search',
            in: 'query',
            type: 'string',
            required: true,
            description: 'openFDA 检索式',
          },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 5 },
        ],
        pick: 'results',
        limit: 10,
      },
      {
        name: 'adverse_events',
        description:
          '检索 FAERS 不良事件报告。' +
          '**注意 FAERS 是自发上报数据，不能用来算发生率——没有分母。** ' +
          '它能回答「有没有人报告过这类事件」，不能回答「多少人会发生」。' +
          'count 参数可做聚合，如 patient.reaction.reactionmeddrapt.exact。',
        path: '/drug/event.json',
        params: [
          {
            name: 'search',
            in: 'query',
            type: 'string',
            required: true,
            description: 'openFDA 检索式',
          },
          { name: 'count', in: 'query', type: 'string', description: '聚合字段' },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: 'results',
        limit: 50,
      },
    ],
  },

  /* ================= 文献图谱 ================= */
  {
    id: 'openalex',
    baseUrl: 'https://api.openalex.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_works',
        description:
          '检索文献。覆盖最广，**做引文前向/后向追踪的主力**（见 `literature-review`）。' +
          'filter 支持 from_publication_date、type、is_oa 等。',
        path: '/works',
        params: [
          { name: 'search', in: 'query', type: 'string', description: '全文检索词' },
          {
            name: 'filter',
            in: 'query',
            type: 'string',
            description: '过滤条件，如 from_publication_date:2020-01-01',
          },
          { name: 'per_page', in: 'query', type: 'number', description: '条数上限', default: 25 },
          {
            name: 'sort',
            in: 'query',
            type: 'string',
            description: '排序，如 cited_by_count:desc',
          },
        ],
        pick: 'results',
        limit: 50,
      },
      {
        name: 'get_work',
        description:
          '按 DOI 或 OpenAlex ID 取单篇文献，含参考文献列表与被引信息。' +
          'id 可以是 doi:10.1038/xxx 形式。',
        path: '/works/{id}',
        params: [
          {
            name: 'id',
            in: 'path',
            type: 'string',
            required: true,
            description: 'DOI 或 OpenAlex ID',
          },
        ],
      },
      {
        name: 'cited_by',
        description: '取引用了某篇文献的作品（前向追踪）。id 用 OpenAlex work ID（W…）。',
        path: '/works',
        params: [
          {
            name: 'filter',
            in: 'query',
            type: 'string',
            required: true,
            description: '用 cites:W… 形式',
          },
          { name: 'per_page', in: 'query', type: 'number', description: '条数上限', default: 25 },
        ],
        pick: 'results',
        limit: 50,
      },
    ],
  },
  {
    id: 'arxiv',
    baseUrl: 'https://export.arxiv.org/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '检索 arXiv 预印本。search_query 支持字段前缀，如 all:"protein design" 或 cat:q-bio.BM。' +
          '**结果须标注未经同行评议。** 返回的是 Atom XML，不是 JSON。' +
          '多词短语要加引号：`all:sleep apnea` 会被当成 `all:sleep OR all:apnea`，' +
          '因为空格在查询串里就是分隔符。',
        path: '/query',
        params: [
          {
            name: 'search_query',
            in: 'query',
            type: 'string',
            required: true,
            description: 'arXiv 检索式',
          },
          {
            name: 'max_results',
            in: 'query',
            type: 'number',
            description: '条数上限',
            default: 20,
          },
          {
            name: 'sortBy',
            in: 'query',
            type: 'string',
            description: '排序',
            enum: ['relevance', 'lastUpdatedDate', 'submittedDate'],
            default: 'relevance',
          },
        ],
        headers: { accept: 'application/atom+xml' },
        responseType: 'text',
      },
    ],
  },

  /* ================= 科研资源 ================= */
  {
    id: 'grants-gov',
    baseUrl: 'https://api.grants.gov/v1/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_opportunities',
        description: '检索美国联邦基金机会：截止日期、资助机构、金额范围。',
        path: '/search2',
        method: 'POST',
        params: [
          { name: 'keyword', in: 'body', type: 'string', required: true, description: '关键词' },
          { name: 'rows', in: 'body', type: 'number', description: '条数上限', default: 20 },
          {
            name: 'oppStatuses',
            in: 'body',
            type: 'string',
            description: '状态过滤',
            default: 'forecasted|posted',
          },
        ],
        pick: 'data.oppHits',
        limit: 40,
      },
    ],
  },
  {
    id: 'antibody-registry',
    baseUrl: 'https://www.antibodyregistry.org/api',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '按靶点或货号检索抗体的 RRID。' +
          '**方法学部分应给 RRID 而不只是货号**——货号会变，RRID 不会。',
        path: '/antibodies',
        params: [
          {
            name: 'search',
            in: 'query',
            type: 'string',
            required: true,
            description: '靶点名或货号',
          },
          { name: 'size', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        pick: 'items',
        limit: 40,
      },
    ],
  },

  /* ================= 目录连接器 ================= */
  {
    id: 'pubmed',
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search',
        description:
          '检索 PubMed，返回 PMID 列表与总命中数。' +
          'term 支持 MeSH 与字段限定，如 "Sleep Apnea, Obstructive"[Mesh] AND cognition[tiab]。' +
          '**MeSH 检索的精度优势明显**，能用主题词就不要只用自由词。',
        path: '/esearch.fcgi',
        params: [
          {
            name: 'term',
            in: 'query',
            type: 'string',
            required: true,
            description: 'PubMed 检索式',
          },
          { name: 'retmax', in: 'query', type: 'number', description: '条数上限', default: 50 },
          {
            name: 'sort',
            in: 'query',
            type: 'string',
            description: '排序',
            enum: ['relevance', 'pub_date'],
            default: 'relevance',
          },
          { name: 'mindate', in: 'query', type: 'string', description: '起始年份或 YYYY/MM/DD' },
          { name: 'maxdate', in: 'query', type: 'string', description: '结束年份或 YYYY/MM/DD' },
        ],
        fixedQuery: { db: 'pubmed', retmode: 'json' },
        pick: 'esearchresult',
      },
      {
        name: 'summary',
        description: '按 PMID 取文献摘要元数据：标题、作者、期刊、年份、DOI、类型。',
        path: '/esummary.fcgi',
        params: [
          {
            name: 'id',
            in: 'query',
            type: 'string',
            required: true,
            description: 'PMID，逗号分隔',
          },
        ],
        fixedQuery: { db: 'pubmed', retmode: 'json' },
        pick: 'result',
      },
      {
        name: 'abstract',
        description:
          '按 PMID 取摘要全文（文本）。' +
          '**抽取数据时数字要从正文而非摘要抄**——摘要里的数字常与正文表格不一致。',
        path: '/efetch.fcgi',
        params: [
          {
            name: 'id',
            in: 'query',
            type: 'string',
            required: true,
            description: 'PMID，逗号分隔',
          },
        ],
        fixedQuery: { db: 'pubmed', rettype: 'abstract', retmode: 'text' },
        headers: { accept: 'text/plain' },
        responseType: 'text',
      },
      {
        name: 'pmc_fulltext',
        description: '按 PMCID 取 PMC 全文 XML（仅开放获取部分）。拿不到时如实记录已尝试的来源。',
        path: '/efetch.fcgi',
        params: [
          {
            name: 'id',
            in: 'query',
            type: 'string',
            required: true,
            description: 'PMCID，如 PMC1234567',
          },
        ],
        fixedQuery: { db: 'pmc', retmode: 'xml' },
        headers: { accept: 'application/xml' },
        responseType: 'text',
      },
    ],
  },
  {
    id: 'clinicaltrials',
    baseUrl: 'https://clinicaltrials.gov/api/v2',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_studies',
        description:
          '检索注册临床试验：设计、入组标准、终点、状态、赞助方。' +
          '**识别发表偏倚要靠它**——注册但无结果的试验往往是阴性的。' +
          'query.cond 是疾病，query.intr 是干预，filter.overallStatus 可限定状态。',
        path: '/studies',
        params: [
          { name: 'query.cond', in: 'query', type: 'string', description: '疾病/适应症' },
          { name: 'query.intr', in: 'query', type: 'string', description: '干预措施' },
          { name: 'query.term', in: 'query', type: 'string', description: '自由文本' },
          {
            name: 'filter.overallStatus',
            in: 'query',
            type: 'string',
            description: '状态，如 COMPLETED|TERMINATED',
          },
          { name: 'pageSize', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { format: 'json', countTotal: 'true' },
        pick: 'studies',
        limit: 40,
      },
      {
        name: 'get_study',
        description: '按 NCT 号取单个试验的完整记录（含结果，若已上传）。',
        path: '/studies/{nctId}',
        params: [
          { name: 'nctId', in: 'path', type: 'string', required: true, description: 'NCT 号' },
        ],
        fixedQuery: { format: 'json' },
      },
    ],
  },
  {
    id: 'chembl',
    baseUrl: 'https://www.ebi.ac.uk/chembl/api/data',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'search_molecule',
        description: '按名称检索化合物，取 ChEMBL ID、结构、开发阶段与作用机制。',
        path: '/molecule/search',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: '化合物名' },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { format: 'json' },
        pick: 'molecules',
        limit: 40,
      },
      {
        name: 'target_activities',
        description:
          '取某靶点上的生物活性数据（pChEMBL、活性类型、来源文献）。' +
          'target_chembl_id 形如 CHEMBL203。做同靶点已有配体调研时用。',
        path: '/activity',
        params: [
          {
            name: 'target_chembl_id',
            in: 'query',
            type: 'string',
            required: true,
            description: 'ChEMBL 靶点 ID',
          },
          {
            name: 'standard_type',
            in: 'query',
            type: 'string',
            description: '活性类型，如 IC50、Ki',
          },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 50 },
        ],
        fixedQuery: { format: 'json' },
        pick: 'activities',
        limit: 100,
      },
      {
        name: 'search_target',
        description: '按基因符号或名称检索靶点，取 target_chembl_id。上面那个端点需要它。',
        path: '/target/search',
        params: [
          {
            name: 'q',
            in: 'query',
            type: 'string',
            required: true,
            description: '靶点名或基因符号',
          },
          { name: 'limit', in: 'query', type: 'number', description: '条数上限', default: 20 },
        ],
        fixedQuery: { format: 'json' },
        pick: 'targets',
        limit: 40,
      },
    ],
  },
  {
    id: 'biorxiv',
    baseUrl: 'https://api.biorxiv.org',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'recent_preprints',
        description:
          '按日期区间取预印本。server 可为 biorxiv 或 medrxiv。' + '**结果须标注未经同行评议。**',
        path: '/details/{server}/{interval}',
        params: [
          {
            name: 'server',
            in: 'path',
            type: 'string',
            required: true,
            description: '服务器',
            enum: ['biorxiv', 'medrxiv'],
            default: 'biorxiv',
          },
          // 区间是两个路径段：`/details/biorxiv/2026-07-20/2026-07-22`。
          // 按整值编码会把斜杠变成 %2F，服务端回 404，而那个 404 看起来像「这几天没有预印本」
          {
            name: 'interval',
            in: 'path',
            type: 'string',
            required: true,
            slashes: true,
            description: '日期区间，如 2026-01-01/2026-07-31',
          },
        ],
        pick: 'collection',
        limit: 100,
      },
      {
        name: 'by_doi',
        description:
          '按 DOI 取预印本详情，含是否已正式发表（published 字段）。去重时用它配对预印本与正式版。',
        path: '/details/{server}/{doi}',
        params: [
          {
            name: 'server',
            in: 'path',
            type: 'string',
            required: true,
            description: '服务器',
            enum: ['biorxiv', 'medrxiv'],
            default: 'biorxiv',
          },
          // DOI 自带一个斜杠（10.1101/2020.11.17.384578），这里同样不能整值编码
          {
            name: 'doi',
            in: 'path',
            type: 'string',
            required: true,
            slashes: true,
            description: '预印本 DOI',
          },
        ],
        pick: 'collection',
      },
    ],
  },
  {
    id: 'ketcher',
    /*
     * Ketcher 是本地二维结构编辑器，没有查询接口。这里的端点是**静态说明**而不是网络调用：
     * 让它去请求 `http://127.0.0.1/` 只会得到一个永远 fetch failed 的工具，
     * 而模型会把那个错误当成暂时故障反复重试。
     */
    baseUrl: 'http://127.0.0.1',
    defaultHeaders: UA,
    endpoints: [
      {
        name: 'how_to_use',
        description:
          '说明结构编辑与格式转换该怎么做。Ketcher 本身通过界面使用，没有可调用的查询端点。',
        path: '/',
        readOnly: true,
        staticText: [
          'Ketcher 是随平台一起提供的本地二维结构编辑器，用于画结构和核对手性，通过界面使用，没有查询端点。',
          '',
          '需要程序化的结构处理时按下面选：',
          '- 格式转换（SMILES ↔ MOL ↔ InChI ↔ InChIKey）、加氢、生成三维构象：在 `python` 内核里用 RDKit。',
          '  这样转换过程会进代码血缘，别人能复现你手里的那个分子。',
          '- 查已知化合物的 SMILES：用 `pubchem.compound_by_name`（`SMILES` 字段带立体化学）。',
          '  **不要手抄 SMILES**，手抄最容易丢手性，而丢了手性的对接结果看上去一样合理。',
          '- 相似化合物检索：`pubchem.similarity_search`。',
          '- 可采购性核对：`zinc.get_substance`。',
        ].join('\n'),
      },
    ],
  },
];

/** 桥标识集合。用于校验内置连接器目录与桥定义是否一一对应。 */
export function bridgeIds(): readonly string[] {
  return BRIDGE_SPECS.map((s) => s.id).sort();
}
