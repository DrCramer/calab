import type { Locale } from './locales';

/**
 * Home page section «MCP» (CBF-48, ADR-0114): one endpoint for LLM clients, the bot's token and rights,
 * six tools, short descriptions to save the model's tokens. Facts: docs/adr/0114-mcp-endpoint-for-bots.md.
 */
export type Mcp = {
  eyebrow: string;
  title: string;
  lead: string;
  points: { title: string; text: string }[];
  toolsTitle: string;
  tools: { name: string; text: string }[];
  note: string;
  docs: string;
};

const mcps: Record<Locale, Mcp> = {
  ru: {
    eyebrow: 'MCP',
    title: 'MCP: подключите любой LLM к Calab',
    lead: 'Claude, агент в IDE или своя модель работают в Calab как бот: ищут, читают, ставят задачи и пишут в комнаты. Клиенту нужны только адрес и токен бота.',
    points: [
      { title: 'Один эндпоинт', text: 'POST /api/mcp — Model Context Protocol поверх HTTP. Никаких адаптеров и сессий.' },
      { title: 'Вход по токену бота', text: 'Токен бота передаётся в заголовке Authorization. Токены людей не принимаются.' },
      { title: 'Права бота и не больше', text: 'Инструмент вызывает обычное API с тем же токеном: те же права и лимиты, приватные доски и комнаты остаются закрытыми.' },
      { title: 'Экономия токенов', text: 'Описания инструментов в одну строку, ответы компактные, полный объект — только по запросу.' },
    ],
    toolsTitle: 'Шесть инструментов',
    tools: [
      { name: 'find', text: 'найти задачи, сообщения, комнаты и доски' },
      { name: 'read', text: 'прочитать задачу или сообщения комнаты' },
      { name: 'create_task', text: 'создать задачу' },
      { name: 'comment_task', text: 'прокомментировать задачу' },
      { name: 'set_task_status', text: 'сменить статус задачи' },
      { name: 'send_message', text: 'написать в комнату' },
    ],
    note: 'Токен бота показывается один раз, при создании.',
    docs: 'Документация MCP',
  },
  en: {
    eyebrow: 'MCP',
    title: 'MCP: connect any LLM to Calab',
    lead: 'Claude, an IDE agent or your own model works in Calab as a bot: it searches, reads, creates tasks and posts to rooms. The client needs only an address and a bot token.',
    points: [
      { title: 'One endpoint', text: 'POST /api/mcp — the Model Context Protocol over HTTP. No adapters, no sessions.' },
      { title: 'Sign in with a bot token', text: 'The bot token goes in the Authorization header. People’s tokens are refused.' },
      { title: 'The bot’s rights, no more', text: 'A tool calls the regular API with the same token: the same permissions and limits, private boards and rooms stay closed.' },
      { title: 'Saves tokens', text: 'One-line tool descriptions and compact answers; the full object only on request.' },
    ],
    toolsTitle: 'Six tools',
    tools: [
      { name: 'find', text: 'find tasks, messages, rooms and boards' },
      { name: 'read', text: 'read a task or a room’s messages' },
      { name: 'create_task', text: 'create a task' },
      { name: 'comment_task', text: 'comment on a task' },
      { name: 'set_task_status', text: 'change a task’s status' },
      { name: 'send_message', text: 'post to a room' },
    ],
    note: 'A bot token is shown once, when it is created.',
    docs: 'MCP documentation',
  },
  es: {
    eyebrow: 'MCP',
    title: 'MCP: conecta cualquier LLM a Calab',
    lead: 'Claude, un agente del IDE o tu propio modelo trabajan en Calab como un bot: buscan, leen, crean tareas y escriben en las salas. El cliente solo necesita una dirección y el token del bot.',
    points: [
      { title: 'Un solo endpoint', text: 'POST /api/mcp: el Model Context Protocol sobre HTTP. Sin adaptadores ni sesiones.' },
      { title: 'Acceso con token de bot', text: 'El token del bot va en la cabecera Authorization. Los tokens de personas se rechazan.' },
      { title: 'Los derechos del bot, ni uno más', text: 'La herramienta llama a la API normal con el mismo token: los mismos permisos y límites; los tableros y salas privados siguen cerrados.' },
      { title: 'Ahorra tokens', text: 'Descripciones de una línea y respuestas compactas; el objeto completo, solo si se pide.' },
    ],
    toolsTitle: 'Seis herramientas',
    tools: [
      { name: 'find', text: 'buscar tareas, mensajes, salas y tableros' },
      { name: 'read', text: 'leer una tarea o los mensajes de una sala' },
      { name: 'create_task', text: 'crear una tarea' },
      { name: 'comment_task', text: 'comentar una tarea' },
      { name: 'set_task_status', text: 'cambiar el estado de una tarea' },
      { name: 'send_message', text: 'escribir en una sala' },
    ],
    note: 'El token del bot se muestra una sola vez, al crearlo.',
    docs: 'Documentación de MCP',
  },
  zh: {
    eyebrow: 'MCP',
    title: 'MCP：把任意 LLM 接入 Calab',
    lead: 'Claude、IDE 中的智能体或你自己的模型，都可以作为机器人在 Calab 中工作：搜索、阅读、创建任务、在房间发言。客户端只需要一个地址和机器人令牌。',
    points: [
      { title: '一个端点', text: 'POST /api/mcp：基于 HTTP 的 Model Context Protocol。无需适配器，无需会话。' },
      { title: '用机器人令牌登录', text: '机器人令牌放在 Authorization 头中。真人的令牌会被拒绝。' },
      { title: '只有机器人的权限', text: '工具使用同一令牌调用常规 API：权限和限额相同，私有看板和房间仍然不可见。' },
      { title: '节省令牌', text: '工具说明只有一行，返回内容精简；完整对象仅在请求时提供。' },
    ],
    toolsTitle: '六个工具',
    tools: [
      { name: 'find', text: '查找任务、消息、房间和看板' },
      { name: 'read', text: '读取任务或房间消息' },
      { name: 'create_task', text: '创建任务' },
      { name: 'comment_task', text: '评论任务' },
      { name: 'set_task_status', text: '更改任务状态' },
      { name: 'send_message', text: '在房间发言' },
    ],
    note: '机器人令牌只在创建时显示一次。',
    docs: 'MCP 文档',
  },
};

export const getMcp = (locale: Locale): Mcp => mcps[locale];
