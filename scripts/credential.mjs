#!/usr/bin/env node
/**
 * 凭据管理命令行。
 *
 * 刻意**不接受把密钥作为命令行参数**：参数会出现在进程列表、shell 历史与父进程
 * 的日志里。密钥只经环境变量 `L_SCIENCE_SECRET` 传入，或从 stdin 读。
 *
 * 用法：
 *   $env:L_SCIENCE_SECRET="..."; node scripts/credential.mjs set provider:deepseek
 *   node scripts/credential.mjs list
 *   node scripts/credential.mjs show provider:deepseek     # 只显示脱敏指纹
 *   node scripts/credential.mjs delete provider:deepseek
 *   node scripts/credential.mjs where
 */

import { CredentialVault, dpapiAvailable } from '../packages/core/dist/index.js';

const [action, ref] = process.argv.slice(2);

function usage(code = 1) {
  process.stderr.write(
    '用法：\n' +
      '  set <ref>      从环境变量 L_SCIENCE_SECRET 读取并存入（不接受命令行传密钥）\n' +
      '  get <ref>      输出明文到 stdout（供程序管道使用，慎用）\n' +
      '  show <ref>     只显示脱敏指纹\n' +
      '  list           列出全部引用名（不含值）\n' +
      '  delete <ref>   删除\n' +
      '  where          显示凭据库路径\n',
  );
  process.exit(code);
}

if (action === undefined) usage();

const vault = new CredentialVault();

if (!dpapiAvailable() && action !== 'where') {
  process.stderr.write(
    'DPAPI 不可用（需要 Windows 且 koffi 可加载）。此环境下无法加密存储凭据，已中止。\n',
  );
  process.exit(2);
}

switch (action) {
  case 'where': {
    process.stdout.write(`${vault.path}\n`);
    process.stdout.write(`DPAPI 可用：${String(dpapiAvailable())}\n`);
    break;
  }

  case 'set': {
    if (ref === undefined) usage();
    const secret = process.env.L_SCIENCE_SECRET;
    if (secret === undefined || secret === '') {
      process.stderr.write(
        '未提供密钥。请设置环境变量 L_SCIENCE_SECRET 后重试（不要用命令行参数传密钥——它会进入进程列表与 shell 历史）。\n',
      );
      process.exit(2);
    }
    vault.set(ref, secret);
    const fp = vault.fingerprint(ref);
    process.stdout.write(`已存入 ${ref}（长度 ${String(fp?.length)}，末四位 ****${fp?.tail}）\n`);
    process.stdout.write(`位置：${vault.path}\n`);
    break;
  }

  case 'get': {
    if (ref === undefined) usage();
    const value = vault.get(ref);
    if (value === null) {
      process.stderr.write(`未找到 ${ref}\n`);
      process.exit(3);
    }
    process.stdout.write(value);
    break;
  }

  case 'show': {
    if (ref === undefined) usage();
    const fp = vault.fingerprint(ref);
    if (fp === null) {
      process.stderr.write(`未找到 ${ref}\n`);
      process.exit(3);
    }
    process.stdout.write(`${ref}：长度 ${String(fp.length)}，末四位 ****${fp.tail}\n`);
    break;
  }

  case 'list': {
    const refs = vault.list();
    if (refs.length === 0) {
      process.stdout.write('凭据库为空\n');
      break;
    }
    for (const r of refs) {
      const fp = vault.fingerprint(r);
      process.stdout.write(`${r}  （长度 ${String(fp?.length)}，末四位 ****${fp?.tail}）\n`);
    }
    break;
  }

  case 'delete': {
    if (ref === undefined) usage();
    process.stdout.write(vault.delete(ref) ? `已删除 ${ref}\n` : `未找到 ${ref}\n`);
    break;
  }

  default:
    usage();
}
