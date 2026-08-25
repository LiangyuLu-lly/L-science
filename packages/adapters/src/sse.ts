/**
 * SSE（Server-Sent Events）行解析。
 *
 * 单独拿出来是因为这里有两个容易写错、且错了以后症状很隐蔽的点：
 *
 * 1. **网络分片不按行边界切。** 一个 `data:` 行可能横跨两个 TCP 分片，
 *    因此必须跨 chunk 保留缓冲区。按 chunk 独立解析在本地和小响应上「能用」，
 *    一遇到长输出就开始丢 token，而且丢得没有规律。
 * 2. **行尾可能是 `\r\n`。** 不剥掉 `\r`，JSON.parse 仍然能过（尾随空白合法），
 *    但 `[DONE]` 哨兵会变成 `[DONE]\r` 而匹配不上，流就永远不结束。
 */

/** 从字节流里逐行取出 SSE 的 data 载荷，已剥除 `data:` 前缀与空白。 */
export async function* sseDataLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted === true) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        // 剥掉 \r：否则 [DONE] 会变成 [DONE]\r 而匹配不上，流永不结束
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);

        if (line === '' || line.startsWith(':')) continue; // 空行分隔与注释心跳
        if (!line.startsWith('data:')) continue; // event:/id: 等字段本适配器不用

        yield line.slice(5).trim();
      }
    }

    // 流结束时缓冲区可能还剩最后一行（服务端没发末尾换行）
    const tail = buffer.replace(/\r$/, '').trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    // 提前 return（中止或调用方 break）时必须释放，否则连接悬着不回收
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
