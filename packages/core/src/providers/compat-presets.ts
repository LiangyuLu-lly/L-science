/**
 * 已知的 OpenAI 兼容网关。多家可以同时登记，各用各的密钥与基地址。
 */

export type CompatPreset = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly docsUrl: string;
};

export const COMPAT_PRESETS: readonly CompatPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'gemini',
    name: 'Google Gemini（OpenAI 兼容）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'together',
    name: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    docsUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'moonshot',
    name: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'qwen',
    name: '通义千问（DashScope 兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    docsUrl: 'https://platform.minimaxi.com',
  },
  {
    id: 'yi',
    name: '零一万物 Yi',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    docsUrl: 'https://platform.lingyiwanwu.com',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 Step',
    baseUrl: 'https://api.stepfun.com/v1',
    docsUrl: 'https://platform.stepfun.com',
  },
  {
    id: 'volcengine',
    name: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docsUrl: 'https://console.volcengine.com/ark',
  },
];

export function findCompatPreset(id: string): CompatPreset | null {
  return COMPAT_PRESETS.find((p) => p.id === id) ?? null;
}

/** 自定义端点的供应商 id：compat- 加主机名。同一主机再次登记会覆盖。 */
export function compatProviderIdForUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\./gu, '-');
    if (host === '') return 'compat-custom';
    return `compat-${host}`.slice(0, 80);
  } catch {
    return 'compat-custom';
  }
}
