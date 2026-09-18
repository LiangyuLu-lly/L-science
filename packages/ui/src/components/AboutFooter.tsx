/**
 * 设置页脚：版本、数据目录、三条隐私承诺。
 *
 * 文案必须与 Help「关于」对话框逐字相同。回退没有信号：少一句「不发送遥测」
 * 界面看起来完全正常。因此 tests/privacy.test.ts 扫源码锁这三句。
 *
 * 版本与数据目录走 app.status，不 import @l-science/core。不出网。
 */

import { useEffect, useState } from 'react';

import { getAppStatus, hasBackend } from '../lib/backend.js';

export function AboutFooter(): React.JSX.Element {
  const [version, setVersion] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend()) return;
    let disposed = false;

    void getAppStatus()
      .then((status) => {
        if (disposed) return;
        setDataDir(status.dataDir);
        setVersion(status.version === '' ? null : status.version);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        if (err instanceof Error) return;
        if (typeof err === 'object' && err !== null) return;
      });

    return () => {
      disposed = true;
    };
  }, []);

  return (
    <footer className="about-footer" aria-labelledby="about-footer-heading">
      <h2 id="about-footer-heading" className="panel__title">
        关于
      </h2>
      <dl className="kv">
        <dt>版本</dt>
        <dd>{version ?? '…'}</dd>
        <dt>数据目录</dt>
        <dd>{dataDir ?? '…'}</dd>
      </dl>
      <p className="panel__hint">不发送遥测。</p>
      <p className="panel__hint">数据与密钥留在本机。</p>
      <p className="panel__hint">技能检索不出网（仅本机索引）。</p>
    </footer>
  );
}
