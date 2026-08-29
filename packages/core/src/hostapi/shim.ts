/**
 * 控制面 REPL 的 Python 侧 shim（任务 12.7，需求 10.8）。
 *
 * 生成一个 `lsci_host.py` 写进内核的运行目录，内核启动时 `import` 它并把 `host`
 * 放进全局命名空间。
 *
 * 只用标准库（`urllib`、`json`、`os`），不引任何第三方依赖——控制面必须在任何
 * 托管环境里都能用，包括用户自建的、只装了最小依赖的 venv。
 *
 * 未实现的表面刻意**不提供**，由 `__getattr__` 抛出带说明的错误。给它们做空壳
 * （返回空列表或 None）会让模型以为「查了但没有」，然后基于一个不存在的事实
 * 继续推理——那比明确的报错难查得多。
 */

/** 已实现的表面。与 methods.ts 的注册保持一致。 */
export interface ShimSurface {
  /** 属性名，例如 `artifacts`。 */
  name: string;
  /** 该表面下的方法名到 RPC 方法名。 */
  methods: Readonly<Record<string, string>>;
  /** 给 `help(host.x)` 的说明。 */
  doc: string;
}

/** 未实现的表面及其说明。访问它们会抛错而不是静默返回空。 */
export interface ShimPending {
  name: string;
  reason: string;
}

export interface BuildShimInput {
  surfaces: readonly ShimSurface[];
  pending: readonly ShimPending[];
}

/** 把字符串安全地写成 Python 字面量。 */
function py(value: string): string {
  return JSON.stringify(value);
}

export function buildHostShim(input: BuildShimInput): string {
  const surfaceDefs = input.surfaces
    .map((surface) => {
      const methods = Object.entries(surface.methods)
        .map(([local, remote]) => `        ${py(local)}: ${py(remote)},`)
        .join('\n');
      return [
        `    ${py(surface.name)}: _Surface(`,
        `        ${py(surface.name)},`,
        `        ${py(surface.doc)},`,
        '        {',
        methods,
        '        },',
        '    ),',
      ].join('\n');
    })
    .join('\n');

  const pendingDefs = input.pending.map((p) => `    ${py(p.name)}: ${py(p.reason)},`).join('\n');

  return `"""L-science 控制面。由平台生成，不要手工编辑。

用法：

    host.artifacts.list()
    host.skills.search("睡眠分期")
    host.agents.delegate([{"task": "..."}])

方法与参数都是关键字参数。返回值是普通 dict/list，可以直接进 pandas。
"""

import json
import os
import urllib.error
import urllib.request

__all__ = ["host", "HostError", "HostUnavailable"]

_URL = os.environ.get("L_SCIENCE_HOST_URL")
_TOKEN = os.environ.get("L_SCIENCE_HOST_TOKEN")
_TIMEOUT = float(os.environ.get("L_SCIENCE_HOST_TIMEOUT", "120"))


class HostError(RuntimeError):
    """控制面调用被拒绝或执行失败。"""


class HostUnavailable(RuntimeError):
    """当前内核没有控制面权限。"""


def _call(method, params):
    if not _URL or not _TOKEN:
        # 普通 python 工具的内核不注入这两个环境变量，这条路径就是它撞上来的结果。
        # 说清楚是权限问题而不是网络问题，否则会被当成服务没起来去排查
        raise HostUnavailable(
            "当前内核没有控制面权限。host 只在控制面 REPL 里可用；"
            "普通 python cell 无法调用平台管理能力。"
        )

    # 会话 id 与模型 id 每次调用现读一次，不在导入时缓存：控制面单例内核跨会话复用，
    # 缓存下来的那个 id 到下一个会话就是错的，而错误的后果（子 agent 挂到别的
    # 会话下、findings 记到别的会话里）不会有任何报错。
    #
    # 模型 id 由平台在每次执行前写进环境，控制面代码改不掉它对本次调用的影响
    # ——真要改就得改自己进程的环境变量，而那时改的是「谁在执行」这个事实本身，
    # 已经不是「自报一个好看的名字」了
    context = {
        "conversationId": os.environ.get("L_SCIENCE_HOST_CONVERSATION"),
        "modelId": os.environ.get("L_SCIENCE_HOST_MODEL"),
    }
    body = json.dumps(
        {"method": method, "params": params or {}, "context": context}
    ).encode("utf-8")
    req = urllib.request.Request(
        _URL,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json; charset=utf-8",
            "x-lsci-host-token": _TOKEN,
        },
    )

    try:
        # 不走系统代理：控制面在回环地址上，经代理会多一跳且在代理没起来时直接失败
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise HostError("控制面返回 %s：%s" % (exc.code, detail[:500])) from None
    except urllib.error.URLError as exc:
        raise HostError("控制面不可达：%s" % (exc.reason,)) from None

    if payload.get("ok"):
        return payload.get("result")

    err = payload.get("error") or {}
    message = err.get("message", "未知错误")
    remediation = err.get("remediation")
    if remediation:
        message = "%s\\n%s" % (message, remediation)
    raise HostError(message)


class _Bound(object):
    """一个具体的控制面方法。"""

    __slots__ = ("_remote", "_label")

    def __init__(self, remote, label):
        self._remote = remote
        self._label = label

    def __call__(self, **kwargs):
        return _call(self._remote, kwargs)

    def __repr__(self):
        return "<host.%s -> %s>" % (self._label, self._remote)


class _Surface(object):
    __slots__ = ("_name", "__doc__", "_methods")

    def __init__(self, name, doc, methods):
        self._name = name
        self.__doc__ = doc
        self._methods = methods

    def __getattr__(self, item):
        remote = self._methods.get(item)
        if remote is None:
            available = ", ".join(sorted(self._methods))
            raise AttributeError(
                "host.%s 没有 %s。可用：%s" % (self._name, item, available)
            )
        return _Bound(remote, "%s.%s" % (self._name, item))

    def __dir__(self):
        return sorted(self._methods)

    def __repr__(self):
        return "<host.%s: %s>" % (self._name, ", ".join(sorted(self._methods)))


_SURFACES = {
${surfaceDefs}
}

_PENDING = {
${pendingDefs}
}


class _Host(object):
    """平台控制面。"""

    def __getattr__(self, item):
        surface = _SURFACES.get(item)
        if surface is not None:
            return surface

        pending = _PENDING.get(item)
        if pending is not None:
            # 不做空壳：返回空列表会让调用方以为「查了但没有」，
            # 然后基于一个不存在的事实继续推理。
            #
            # 措辞是「不可用」而不是「尚未实现」：pending 里的原因分三种——还没做、
            # 这个部署没启用、这次运行没接上。说成「尚未实现」会让用户去等一个
            # 已经做完的东西。
            raise AttributeError("host.%s 不可用：%s" % (item, pending))

        raise AttributeError(
            "host 没有 %s。可用：%s" % (item, ", ".join(sorted(_SURFACES)))
        )

    def __dir__(self):
        return sorted(_SURFACES)

    def surfaces(self):
        """列出可用的表面及其方法。"""
        return {name: sorted(s._methods) for name, s in _SURFACES.items()}

    def pending(self):
        """列出尚未实现的表面及原因。"""
        return dict(_PENDING)

    def __repr__(self):
        return "<L-science host: %s>" % (", ".join(sorted(_SURFACES)),)


host = _Host()
`;
}

/** 内核就绪后执行的初始化代码：把 host 放进全局命名空间。 */
export function hostInitCode(): string {
  return [
    'import sys as _sys, os as _os',
    // 运行目录已在 PYTHONPATH 里，但显式加一次更稳：内核的 cwd 是工作目录而不是运行目录
    '_d = _os.environ.get("L_SCIENCE_HOST_SHIM_DIR")',
    'if _d and _d not in _sys.path: _sys.path.insert(0, _d)',
    'from lsci_host import host, HostError, HostUnavailable',
    'del _sys, _os, _d',
  ].join('\n');
}
