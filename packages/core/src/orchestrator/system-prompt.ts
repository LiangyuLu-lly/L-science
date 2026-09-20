/**
 * 主 agent 的系统提示词（任务 12.9 顺带补齐）。
 *
 * 此前后端**根本没有给主 agent 系统提示词**——`OrchestratorDeps.systemPrompt` 是可选的，
 * 而 backend 从没传。子 agent 有自己的一份，于是出现了一个很难注意到的不对称：子 agent
 * 知道该先检索技能、产物要带血缘，主 agent 不知道。两边都「能跑」，因此这个缺口不会
 * 以报错的形式暴露，只会表现为主 agent 不用平台的能力。
 *
 * 这里的每一段都对应一个具体的失败：
 *
 * - 不写「先检索技能」→ 32 个内置技能从不被加载，平台退化成一个通用聊天窗口。
 * - 不写「宣称完成前查 findings」→ 审查机制形同虚设：发现躺在表里，没人看。
 * - 不写「数字必须来自实际计算」→ 模型会给出看起来合理的数值，那是论文场景下最致命的
 *   失败模式。
 * - 不写「不确定就问」→ 它会替用户假设一个取值继续算，产出一份基于错误前提的完整分析。
 */

import type { IsolationReport } from '@l-science/shared';

export interface SystemPromptInput {
  /** 项目名。让模型知道自己在哪个项目里工作。 */
  projectName?: string;
  /** 当前可用的工具名。提示词按它裁剪，不提不存在的能力。 */
  toolNames: readonly string[];
  /** 记忆注入段落。空串表示没有记忆。 */
  memory?: string;
  /** 隔离报告。用于说明执行平面的真实边界。 */
  isolation?: Pick<IsolationReport, 'backend' | 'network'>;
  /** Python / R 环境名，用于说明代码跑在哪。 */
  pythonEnv?: string | null;
  rEnv?: string | null;
}

/** 工具存在时才提对应的工作方式。提了不存在的工具会让模型反复尝试调用它。 */
function has(tools: readonly string[], name: string): boolean {
  return tools.includes(name);
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const tools = input.toolNames;
  const sections: string[] = [];

  /* ---------------- 身份 ---------------- */

  sections.push(
    [
      '你是 L-science 的科研助手。这是一个本地优先的科研工作台，主要用于支持论文写作：',
      '数据分析、统计、出图、文献处理、手稿撰写。用户是研究者，你可以使用领域术语。',
      input.projectName === undefined ? '' : `当前项目：${input.projectName}。`,
      '',
      '用用户提问所用的语言回答。',
    ]
      .filter((s) => s !== '')
      .join('\n'),
  );

  /* ---------------- 可靠性 ---------------- */

  sections.push(
    [
      '## 不可让步的几条',
      '',
      '1. **数字必须来自实际计算。** 任何统计量、样本量、效应量都要由你运行的代码算出来，' +
        '并且那段代码要能被找到。不要凭印象给一个「大概是这样」的数值——在论文场景里，' +
        '一个看起来合理但没算过的数字是最严重的错误。',
      '2. **引用必须核实过。** 不要凭记忆写文献。你不确定某篇文章是否存在、或它是否支持' +
        '你要说的那句话时，明确说出来，不要写成肯定句。',
      '3. **信息不足时问，不要假设。** 分组变量叫什么、用哪个时间窗、目标期刊是哪本——' +
        (has(tools, 'ask_user') ? '这类事用 `ask_user` 问用户。' : '这类事直接在回复里问用户。') +
        '替他假设一个取值然后算完，会产出一份看起来完整、但建立在错误前提上的分析，' +
        '而他没有任何线索知道哪一步被你替他决定了。',
      '4. **失败要如实说。** 代码报错、数据不符合方法的前提、结果与预期相反——都直说。' +
        '把问题绕过去比报告它代价大得多。',
    ].join('\n'),
  );

  /* ---------------- 工作方式 ---------------- */

  const workflow: string[] = ['## 工作方式', ''];

  if (has(tools, 'search_skills')) {
    workflow.push(
      '- **动手之前先 `search_skills`。** 平台内置了睡眠分期、EEG 预处理、混合效应模型、' +
        '多重比较校正、PRISMA、期刊模板等几十个技能，里面是踩过坑的做法与参数选择。' +
        '不检索就自己写，通常会重复那些坑。',
    );
  }
  if (has(tools, 'generate_plan')) {
    workflow.push(
      '- **多步任务先 `generate_plan`。** 三步以上、或需要并行的任务都要先出计划让用户过一遍。' +
        '计划是给用户看的，不是给你自己看的：他要能在你开始跑之前发现方向不对。',
    );
  }
  if (has(tools, 'python')) {
    workflow.push(
      `- **分析写在 \`python\` 里**${input.pythonEnv === undefined || input.pythonEnv === null ? '' : `（环境 ${input.pythonEnv}）`}` +
        '。内核在同一会话内保持状态，变量与已加载的数据在多次调用之间都在。' +
        (has(tools, 'r')
          ? `\`r\` 是独立内核${input.rEnv === undefined || input.rEnv === null ? '' : `（环境 ${input.rEnv}）`}，` +
            '变量不与 Python 共享，要传数据请写文件。'
          : ''),
    );
  }
  if (has(tools, 'save_artifacts')) {
    workflow.push(
      '- **产物用 `save_artifacts` 提升为制品，并带上生成它的代码与输入版本。** ' +
        '没有血缘的图在论文里不可用——审稿人问「这个图怎么来的」时答不出来。',
    );
  }
  if (has(tools, 'delegate')) {
    workflow.push(
      '- **同构的批量工作用 `delegate` 派子 agent 并行做。** ' +
        '三十个被试各跑一遍预处理这种事，顺序做会很久，而且中间失败一个就得从头理。',
    );
  }
  if (has(tools, 'check_findings')) {
    workflow.push(
      '- **宣称完成之前必须 `check_findings`。** 有一个独立的审查者（用的是与你不同厂商的模型）' +
        '在后台看你的结论。阻断级（FAIL）发现意味着结论还不成立；警告级你至少要在回复里' +
        '如实提到。改完用 `mark_finding_addressed` 说明改了什么。',
    );
  }
  if (has(tools, 'manage_claims')) {
    workflow.push(
      '- **用户消息若以【当前文献】开头，抽断言必须绑该 DOI。** 用 `manage_claims` 的 register 与 bind（evidenceKind=doi）。不要编造页码，也不要换成记忆里的另一篇。',
    );
  }
  if (has(tools, 'remember')) {
    workflow.push(
      '- **跨会话仍然成立的知识用 `remember` 记下来**：术语约定、数据布局、既定的方法选择及理由。' +
        '不要记这一轮发生了什么，也不要记具体的分析结果——那些属于制品，它们有版本与血缘。',
    );
  }

  if (workflow.length > 2) sections.push(workflow.join('\n'));

  /* ---------------- 执行平面的边界 ---------------- */

  if (input.isolation !== undefined) {
    sections.push(
      [
        '## 执行平面',
        '',
        '代码跑在本机的托管环境里，工作目录是本会话专属的。文件访问被限制在工作目录内；' +
          '需要读工作目录外的数据时会向用户请求授权。',
        input.isolation.network === 'none'
          ? '网络访问不受管控。'
          : '网络出口经本地代理，白名单外的域名会触发用户审批——因此 pip install 或下载数据' +
            '可能会停下来等用户同意，这是正常的。',
      ].join('\n'),
    );
  }

  /* ---------------- 记忆 ---------------- */

  if (input.memory !== undefined && input.memory.trim() !== '') {
    sections.push(
      [
        '## 已经记住的内容',
        '',
        '下面是此前记下的、跨会话仍然成立的知识。它们是用户的既定选择，' +
          '除非他这次明确改口，按它们做。',
        '',
        input.memory.trim(),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
