/**
 * dsh-session-auto-rename — host half.
 *
 * One operation, two callers:
 *   - the sidebar session-menu row「自动重命名」(client half → POST route below)
 *   - the model-facing tool `session_auto_rename`
 *
 * The operation reads the session log, builds a recency-weighted user-message
 * digest (a message's weight decays with its age, so the newest turns dominate
 * the topic), asks the deployment's default model for a short title, and applies
 * it through the shipped session-controller rename RPC.
 *
 * Deliberately zero imports: third-party host plugins cannot resolve the
 * `@deepseek-ai/*` runtime packages, so every service is reached lazily through
 * `ctx.get()` and the tools are registered as raw definitions.
 */

export const name = 'dsh-session-auto-rename';

const ROUTE_PATH = '/api/dsh-session-auto-rename/suggest';

/** Recency weighting: a message loses ~63% of its weight every 3 days. */
const RECENCY_TAU_MS = 3 * 24 * 60 * 60 * 1000;
/** Whole prompt input stays small enough for any model. */
const MAX_TRANSCRIPT_CHARS = 6000;
const MAX_CANDIDATE_MESSAGES = 40;
const MAX_PICKED_MESSAGES = 18;
const MAX_MESSAGE_CHARS = 700;
/** Title width: 10 CJK characters; two ASCII characters count as one CJK width. */
const TITLE_MAX_CJK = 10;
const TITLE_ASCII_PER_CJK = 2;

const SYSTEM_PROMPT = [
  '你是一个会话命名器：根据用户在一段会话里发过的消息，给这段会话起一个标题。',
  '规则：',
  '1. 只输出标题本身：不要引号、书名号、句号、前缀（如「标题：」）、换行或任何解释。',
  `2. 硬上限：标题宽度最多 ${String(TITLE_MAX_CJK)} 个汉字；字母、数字、符号、空格各算 0.5 个汉字，所以纯英文标题不超过 ${String(TITLE_MAX_CJK * TITLE_ASCII_PER_CJK)} 个字符。`,
  `3. 输出前自己先数一遍宽度：超出会被系统直接裁掉，裁断处会破坏断句和词组，所以必须一次就控制在 ${String(TITLE_MAX_CJK)} 个汉字宽度以内（建议 8–10 个汉字，留出余量并把词组写完整，不要写半截词）。`,
  '4. 每行消息前面的时间是距现在的时长，权重按「越靠近现在越高」递减：早期与近期主题不同时，以近期的为准，早期只作背景。',
  '5. 不要用「会话」「讨论」「问题」「帮助」「关于」这类空泛词，也不要照抄第一句原文。',
].join('\n');

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

/** Resolve an optional Host service without throwing when it is absent. */
function service(ctx, key) {
  try {
    const value = ctx.get(key);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

/** Concatenate the text blocks of one message content array. */
function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Human-readable age ("3 小时前") for a millisecond distance. */
function ageLabel(ageMs) {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (!Number.isFinite(ageMs) || ageMs < minute) return '刚刚';
  if (ageMs < hour) return `${Math.round(ageMs / minute)} 分钟前`;
  if (ageMs < day) return `${Math.round(ageMs / hour)} 小时前`;
  if (ageMs < 30 * day) return `${Math.round(ageMs / day)} 天前`;
  if (ageMs < 365 * day) return `${Math.round(ageMs / (30 * day))} 个月前`;
  return `${Math.round(ageMs / (365 * day))} 年前`;
}

/** Trim to a character budget without splitting a surrogate pair. */
function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/* ------------------------------------------------------------------ *
 * title width: a CJK glyph is one unit, two ASCII characters are one unit
 * ------------------------------------------------------------------ */

const FULL_WIDTH = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** Width of one code point in CJK units. */
function charWidth(character) {
  return FULL_WIDTH.test(character) ? 1 : 1 / TITLE_ASCII_PER_CJK;
}

/** Keep the leading code points whose combined width fits the title budget. */
function truncateTitleWidth(value) {
  const characters = [...value];
  let width = 0;
  let end = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const next = width + charWidth(characters[index]);
    if (next > TITLE_MAX_CJK + 1e-9) break;
    width = next;
    end = index + 1;
  }
  return characters.slice(0, end).join('').trimEnd();
}

/* ------------------------------------------------------------------ *
 * transcript: log -> recency-weighted digest
 * ------------------------------------------------------------------ */

/**
 * Read the session log and split it into user messages (the naming signal) and
 * the latest assistant message (what the session actually produced).
 */
async function loadTranscript(ctx, sessionId) {
  const query = service(ctx, 'sessionQuery');
  if (query === null || typeof query.readSession !== 'function') {
    throw new Error('这个部署没有挂载会话查询服务（sessionQuery），无法读取会话内容');
  }
  const snapshot = await query.readSession(sessionId);
  const events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : [];
  const users = [];
  let assistant = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null;
    if (event.type === 'user/message') {
      const text = textOfContent(event.data && event.data.content);
      if (text.length > 0) users.push({ text, time });
    } else if (event.type === 'assistant/message') {
      const text = textOfContent(event.data && event.data.message && event.data.message.content);
      if (text.length > 0) assistant = { text, time };
    }
  }
  return { users, assistant };
}

/**
 * Pick messages by recency weight (exponential decay) inside one character
 * budget, then restore chronological order for the prompt.
 */
function weightMessages(users, now) {
  const recent = users.slice(-MAX_CANDIDATE_MESSAGES);
  const offset = users.length - recent.length;
  const scored = recent.map((message, index) => {
    // A message without a timestamp inherits an age from its position in the log.
    const fallbackAge = (users.length - (offset + index)) * 60 * 60 * 1000;
    const age = message.time === null ? fallbackAge : Math.max(0, now - message.time);
    return {
      text: message.text,
      age,
      order: offset + index,
      weight: Math.exp(-age / RECENCY_TAU_MS),
    };
  });
  scored.sort((a, b) => b.weight - a.weight);
  const picked = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  for (const message of scored) {
    if (picked.length >= MAX_PICKED_MESSAGES) break;
    const text = clip(message.text, MAX_MESSAGE_CHARS);
    if (text.length === 0) continue;
    if (text.length > budget) continue;
    budget -= text.length;
    picked.push({ ...message, text });
  }
  picked.sort((a, b) => a.order - b.order);
  return picked;
}

/** Build the single user message the title request carries. */
function buildDigest(users, assistant, now) {
  const picked = weightMessages(users, now);
  const lines = [
    `下面这段会话一共有 ${users.length} 条用户消息；下面列出其中权重最高的 ${picked.length} 条（越靠近现在权重越高）：`,
    '',
  ];
  for (const message of picked) {
    const weight = message.weight >= 0.1 ? message.weight.toFixed(2) : message.weight.toFixed(3);
    lines.push(`[${ageLabel(message.age)} · 权重 ${weight}] ${message.text}`);
  }
  if (assistant !== null) {
    const age = assistant.time === null ? null : Math.max(0, now - assistant.time);
    const when = age === null ? '最近一次回复' : `最近一次回复（${ageLabel(age)}）`;
    lines.push('', `${when}的片段（只作背景，不要照抄）：`);
    lines.push(clip(assistant.text, 400));
  }
  lines.push('', '请只输出标题本身。');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * LLM call
 * ------------------------------------------------------------------ */

/** Drain one stream into its visible text; a terminal failure becomes a throw. */
async function collectTitleText(llm, options) {
  let text = '';
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      continue;
    }
    if (chunk.type !== 'finish' || chunk.reason === undefined) continue;
    if (chunk.reason.kind === 'error') {
      const failure = chunk.reason.failure;
      const error = new Error((failure && (failure.message || failure.code)) || '模型调用失败');
      if (failure && typeof failure.code === 'string') error.code = failure.code;
      throw error;
    }
    if (chunk.reason.kind === 'max-tokens' && text.trim().length === 0) {
      throw new Error('模型输出达到长度上限但没有给出标题');
    }
  }
  return text;
}

/**
 * Resolve the route the title request uses: the deployment's current default
 * model, plus the LLM service itself.
 */
function resolveRoute(ctx) {
  const llm = service(ctx, 'llm');
  if (llm === null || typeof llm.stream !== 'function') {
    throw new Error('这个部署没有可用的 LLM 服务，无法自动命名');
  }
  const selection = service(ctx, 'agentDefaultModel');
  const current = selection !== null && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null;
  const provider = current && typeof current.provider === 'string' ? current.provider : '';
  const model = current && typeof current.model === 'string' ? current.model : '';
  if (provider === '' || model === '') {
    throw new Error('没有可用的默认模型（agentDefaultModel 未就绪）');
  }
  return { llm, provider, model };
}

/**
 * One non-streaming-to-the-caller title completion.
 *
 * No timeout by design: the caller decides how long to wait, and a client that
 * disconnects aborts the model call through `signal`. Reasoning is pinned to
 * this model's least supported effort (`'off'`) so the title is not delayed by
 * thinking tokens; a route that rejects `'off'` is retried once without it.
 */
async function callTitle(ctx, system, prompt, signal) {
  const { llm, provider, model } = resolveRoute(ctx);
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  const base = {
    provider,
    model,
    maxTokens: 4096,
    messages,
    system,
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await collectTitleText(llm, { ...base, reasoningEffort: 'off' });
  } catch (error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
    if (code !== 'UNSUPPORTED_REASONING_EFFORT' && !/reasoning effort/i.test(String(error && error.message))) throw error;
    return collectTitleText(llm, base);
  }
}

/** First-pass title request over the recency-weighted digest. */
function requestTitle(ctx, prompt, signal) {
  return callTitle(ctx, SYSTEM_PROMPT, prompt, signal);
}

/** Second-pass request: compress an over-width candidate without breaking phrases. */
const REPAIR_PROMPT = [
  `把候选标题改写进 ${String(TITLE_MAX_CJK)} 个汉字宽度（2 个 ASCII 字符 = 1 个汉字宽度）。`,
  '保持断句与词组完整：宁可用一个更短的词，也不要留下半截词或半个固定搭配。',
  '只输出新标题本身，不要引号、解释或换行。',
].join('\n');

function repairTitle(ctx, candidate, signal) {
  const prompt = `候选标题：「${candidate}」\n它超过了 ${String(TITLE_MAX_CJK)} 个汉字宽度，请改写后重新输出。`;
  return callTitle(ctx, REPAIR_PROMPT, prompt, signal);
}

/** Strip line decoration from one model answer without touching its length. */
function cleanTitleText(raw) {
  let value = String(raw ?? '').replace(/\r/g, '\n');
  value = value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)[0] ?? '';
  value = value.replace(/^(标题|会话标题|title)\s*[:：]\s*/i, '');
  value = value.replace(/^["'“”‘’「」『』《》【】]+/, '').replace(/["'“”‘’「」『』《》【】]+$/g, '');
  value = value.replace(/[。．.]+$/g, '').trim();
  return value.replace(/\s+/g, ' ');
}

/** Whether one cleaned title already fits the width budget. */
function fitsTitleWidth(value) {
  let width = 0;
  for (const character of String(value)) width += charWidth(character);
  return width <= TITLE_MAX_CJK + 1e-9;
}

/** Last-resort clamp; the model is asked to stay inside the budget first. */
function normalizeTitle(raw) {
  return truncateTitleWidth(cleanTitleText(raw));
}

/* ------------------------------------------------------------------ *
 * the operation
 * ------------------------------------------------------------------ */

/** Suggest and apply one automatic title; returns the accepted title. */
async function autoRenameSession(ctx, sessionId, signal) {
  const { users, assistant } = await loadTranscript(ctx, sessionId);
  if (users.length === 0) {
    throw new Error('这个会话还没有用户消息，无法自动命名');
  }

  const query = service(ctx, 'sessionQuery');
  let previousTitle = '';
  try {
    const previous = query !== null && typeof query.readTitle === 'function' ? await query.readTitle(sessionId) : null;
    if (previous && typeof previous.title === 'string') previousTitle = previous.title;
  } catch {
    /* a missing previous title is not a failure */
  }

  const digest = buildDigest(users, assistant, Date.now());
  const raw = await requestTitle(ctx, digest, signal);
  let candidate = cleanTitleText(raw);
  if (candidate.length === 0) throw new Error('模型没有返回可用的标题，请重试');

  // The prompt already pins the width; when a model still overruns, one repair
  // pass asks for a shorter phrasing instead of cutting a word in half.
  if (!fitsTitleWidth(candidate)) {
    const repaired = await repairTitle(ctx, candidate, signal);
    const repairedText = cleanTitleText(repaired);
    if (repairedText.length > 0) candidate = repairedText;
  }
  const title = normalizeTitle(candidate);
  if (title.length === 0) throw new Error('模型没有返回可用的标题，请重试');

  const controller = service(ctx, 'sessionController');
  if (controller === null || typeof controller.rename !== 'function') {
    throw new Error('会话重命名服务不可用');
  }
  const renamed = await controller.rename({ sessionId, title });
  const accepted = renamed && typeof renamed.title === 'string' && renamed.title.length > 0 ? renamed.title : title;
  return { title: accepted, previousTitle };
}

/* ------------------------------------------------------------------ *
 * Host entry point (the client half's caller)
 * ------------------------------------------------------------------ */

/** One JSON response. */
function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * The operation as one exact Fetch route on the shared `/api` channel.
 *
 * The Desktop shell serves the page from its own `dsh-app://app/` scheme and only
 * proxies `/api/*` to this HTTP server, so a plain `webServer` route is
 * unreachable from that page. `connection.registerFetchRoute` is the supported
 * extension point: it runs behind peer admission and works in both the Desktop
 * page and a normal browser tab.
 *
 * @returns the Fetch handler for one rename request.
 */
function createFetchHandler(ctx) {
  return async (request) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('客户端已中断这次自动命名'));
    try {
      request.signal.addEventListener('abort', abort);
    } catch {
      /* an older Request without a signal simply runs to completion */
    }
    try {
      const payload = await request.json().catch(() => null);
      const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      if (sessionId === '') return json({ ok: false, error: '缺少 sessionId' }, 400);
      const result = await autoRenameSession(ctx, sessionId, controller.signal);
      return json({ ok: true, ...result }, 200);
    } catch (error) {
      if (controller.signal.aborted) return json({ ok: false, error: '已取消这次自动命名' }, 200);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 200);
    } finally {
      try {
        request.signal.removeEventListener('abort', abort);
      } catch {
        /* nothing to detach */
      }
    }
  };
}

/* ------------------------------------------------------------------ *
 * model-facing tool
 * ------------------------------------------------------------------ */

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

function createTool(ctx) {
  return {
    name: 'session_auto_rename',
    description:
      '让 LLM 根据会话内容自动为一个 DSH 会话重命名：越靠近现在的消息权重越高。返回新标题与原标题。' +
      '与侧栏会话菜单里的「自动重命名」是同一个操作。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要重命名的会话 id。' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const sessionId = String((args && args.sessionId) || '').trim();
      if (sessionId === '') throw new Error('缺少 sessionId');
      const { title, previousTitle } = await autoRenameSession(ctx, sessionId);
      return previousTitle.length > 0 ? `已重命名为「${title}」（原标题「${previousTitle}」）` : `已重命名为「${title}」`;
    },
  };
}

/* ------------------------------------------------------------------ *
 * plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  // Wait for the two Host services this entry registers into: a profile that
  // mounts neither keeps the plugin inactive instead of half-starting it. At
  // cold start `ctx.get()` returns undefined before they are provided, so
  // registering eagerly would silently drop the route forever.
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => connCtx.connection.registerFetchRoute(connCtx, {
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createFetchHandler(ctx),
    }), 'dsh-session-auto-rename: suggest route');
  });

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(createTool(ctx)), 'dsh-session-auto-rename: tool');
  });
}
