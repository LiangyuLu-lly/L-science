/**
 * 后端连接状态 hook。
 *
 * 后端是独立进程且可以独立重启（AD-1 的收益之一），所以渲染层必须把「暂时连不上」
 * 当作正常状态来处理，而不是一次失败就永久显示错误。这里用带上界的指数退避重试，
 * 并在收到后端退出日志时立即重新探测。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  BackendError,
  getAppStatus,
  hasBackend,
  subscribeLogs,
  type AppStatus,
} from './backend.js';

export type ConnectionState = 'connecting' | 'ready' | 'unavailable' | 'no-bridge';

export interface BackendConnection {
  state: ConnectionState;
  status: AppStatus | null;
  error: string | null;
  /** 已尝试的次数，用于 UI 上显示「重试中」的进度感。 */
  attempts: number;
  retryNow: () => void;
}

const FIRST_DELAY_MS = 300;
const MAX_DELAY_MS = 5000;

export function useBackend(): BackendConnection {
  const [state, setState] = useState<ConnectionState>(hasBackend() ? 'connecting' : 'no-bridge');
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const timer = useRef<number | null>(null);
  const delay = useRef(FIRST_DELAY_MS);
  const disposed = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const probe = useCallback(async () => {
    if (disposed.current || !hasBackend()) return;

    setAttempts((n) => n + 1);
    try {
      const s = await getAppStatus();
      if (disposed.current) return;
      setStatus(s);
      setError(null);
      setState('ready');
      delay.current = FIRST_DELAY_MS;
    } catch (err) {
      if (disposed.current) return;
      setState('unavailable');
      setError(err instanceof BackendError ? `${err.code}: ${err.message}` : String(err));

      clearTimer();
      timer.current = window.setTimeout(() => {
        void probe();
      }, delay.current);
      delay.current = Math.min(delay.current * 2, MAX_DELAY_MS);
    }
  }, [clearTimer]);

  const retryNow = useCallback(() => {
    delay.current = FIRST_DELAY_MS;
    clearTimer();
    void probe();
  }, [clearTimer, probe]);

  useEffect(() => {
    disposed.current = false;
    void probe();

    // 后端退出会先出现在日志里，比等下一次轮询更早，据此立刻重连。
    const off = hasBackend()
      ? subscribeLogs((line) => {
          if (line.includes('后端退出')) {
            setState('connecting');
            retryNow();
          }
        })
      : () => {};

    return () => {
      disposed.current = true;
      clearTimer();
      off();
    };
  }, [probe, retryNow, clearTimer]);

  return { state, status, error, attempts, retryNow };
}
