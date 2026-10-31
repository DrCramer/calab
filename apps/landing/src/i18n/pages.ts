// Copy of /developers/, of the /features/ sections that the home contract (home.ts)
// does not cover. ru is the source; all four locales are required by the type.
import type { Locale } from './locales';

export type PageCopy = {
  developers: {
    metaTitle: string;
    metaDescription: string;
    eyebrow: string;
    title: string;
    lead: string;
    nav: { bots: string; mcp: string; sdk: string; webhooks: string; oauth: string };
    sdkTitle: string;
    sdkLead: string;
    webhooksTitle: string;
    webhooksLead: string;
    webhooksPoints: string[];
    oauthTitle: string;
    oauthLead: string;
    oauthPoints: string[];
    docs: string;
  };
  features: {
    canvas: { eyebrow: string; title: string; text: string; points: string[] };
    ai: { eyebrow: string; title: string; text: string; points: string[] };
    recording: { eyebrow: string; title: string; text: string; points: string[] };
  };
};

const ru: PageCopy = {
  developers: {
    metaTitle: 'Calab для разработчиков — боты, MCP, SDK, вебхуки и OAuth',
    metaDescription: 'Боты с тем же API, что у приложения; MCP для Claude и агентов в IDE; SDK на TypeScript; вебхуки с подписью HMAC; вход через Calab по OAuth 2.0.',
    eyebrow: 'Разработчикам',
    title: 'Calab как платформа',
    lead: 'Боты, LLM-агенты и ваши приложения работают через тот же API, что и Calab: чат, задачи, календарь, голос.',
    nav: { bots: 'Боты', mcp: 'MCP', sdk: 'SDK', webhooks: 'Вебхуки', oauth: 'OAuth' },
    sdkTitle: 'SDK на TypeScript',
    sdkLead: 'Команды, кнопки, события и голос — несколько строк кода.',
    webhooksTitle: 'Вебхуки',
    webhooksLead: 'События без постоянного соединения: POST-запрос с подписью HMAC и повторами при сбоях.',
    webhooksPoints: ['Вебхук бота: сообщения, реакции, задачи, встречи, кнопки', 'Подпись HMAC-SHA256 в заголовке X-Calab-Signature', 'Повторы при сбоях и очередь событий', 'Вебхук доски: каждое изменение задач (Business и выше)'],
    oauthTitle: 'Войти через Calab',
    oauthLead: 'OAuth 2.0 и OpenID Connect: ваши внутренние сервисы пускают сотрудников по аккаунту Calab.',
    oauthPoints: ['Authorization Code + PKCE (S256)', 'Экран согласия с правами', 'userinfo, refresh и отзыв токенов', 'Клиенты создаются в настройках пространства'],
    docs: 'Документация',
  },
  features: {
    canvas: { eyebrow: 'Холст', title: 'Онлайн-доска прямо в голосе', text: 'Бесконечный холст для ретро, схем и мозговых штурмов. Открывается в голосовой комнате и правится всеми сразу.', points: ['Стикеры, фигуры, стрелки и текст', 'Голосование точками и таймер', 'Курсоры коллег в реальном времени', 'Карточка холста в чате и на странице вики'] },
    ai: { eyebrow: 'AI', title: 'AI там, где он экономит время', text: 'Умная задача из текста и файлов, сводки и расшифровки встреч, любые модели через MCP.', points: ['Умная задача: доска, приоритет и проверка дублей', 'Сводка и расшифровка каждой записи', 'Claude и агенты в IDE — как боты через MCP', 'С тарифа Business; обработка — GPTunneL'] },
    recording: { eyebrow: 'Записи встреч', title: 'Запись, сводка и расшифровка', text: 'Запись ведёт сервер. После встречи в чат комнаты приходит карточка со сводкой, аудио и полным текстом.', points: ['Включает любой участник, кроме гостей', 'Поиск по словам в расшифровке', 'Аудио хранится 30 дней', 'Запись можно запретить в настройках комнаты'] },
  },
};

const en: PageCopy = {
  developers: {
    metaTitle: 'Calab for developers — bots, MCP, SDK, webhooks and OAuth',
    metaDescription: 'Bots with the same API as the app; MCP for Claude and IDE agents; a TypeScript SDK; HMAC-signed webhooks; Sign in with Calab over OAuth 2.0.',
    eyebrow: 'Developers',
    title: 'Calab as a platform',
    lead: 'Bots, LLM agents and your own apps use the same API as Calab itself: chat, tasks, calendar, voice.',
    nav: { bots: 'Bots', mcp: 'MCP', sdk: 'SDK', webhooks: 'Webhooks', oauth: 'OAuth' },
    sdkTitle: 'TypeScript SDK',
    sdkLead: 'Commands, buttons, events and voice in a few lines of code.',
    webhooksTitle: 'Webhooks',
    webhooksLead: 'Events without a persistent connection: an HMAC-signed POST with retries on failure.',
    webhooksPoints: ['Bot webhook: messages, reactions, tasks, meetings, buttons', 'HMAC-SHA256 signature in X-Calab-Signature', 'Retries on failure and an event queue', 'Board webhook: every task change (Business and up)'],
    oauthTitle: 'Sign in with Calab',
    oauthLead: 'OAuth 2.0 and OpenID Connect: your internal services let employees in with their Calab account.',
    oauthPoints: ['Authorization Code + PKCE (S256)', 'A consent screen with scopes', 'userinfo, refresh and token revocation', 'Clients are created in workspace settings'],
    docs: 'Documentation',
  },
  features: {
    canvas: { eyebrow: 'Canvas', title: 'A whiteboard right in voice', text: 'An infinite canvas for retros, diagrams and brainstorms. Opens in a voice room and everyone edits at once.', points: ['Sticky notes, shapes, arrows and text', 'Dot voting and a timer', 'Colleagues’ cursors in real time', 'Canvas card in the chat and on a wiki page'] },
    ai: { eyebrow: 'AI', title: 'AI where it saves time', text: 'Smart tasks from text and files, meeting summaries and transcripts, any model via MCP.', points: ['Smart task: board, priority and duplicate check', 'Summary and transcript of every recording', 'Claude and IDE agents as bots via MCP', 'From the Business plan; processing by GPTunneL'] },
    recording: { eyebrow: 'Meeting recordings', title: 'Recording, summary and transcript', text: 'The server records. After the meeting a card with the summary, audio and full text arrives in the room chat.', points: ['Any member except guests can start it', 'Word search in the transcript', 'Audio is kept for 30 days', 'Recording can be disabled per room'] },
  },
};

const es: PageCopy = {
  developers: {
    metaTitle: 'Calab para desarrolladores: bots, MCP, SDK, webhooks y OAuth',
    metaDescription: 'Bots con la misma API que la aplicación; MCP para Claude y agentes en el IDE; SDK de TypeScript; webhooks firmados con HMAC; inicio de sesión con Calab mediante OAuth 2.0.',
    eyebrow: 'Desarrolladores',
    title: 'Calab como plataforma',
    lead: 'Los bots, los agentes de IA y tus propias aplicaciones usan la misma API que Calab: chat, tareas, calendario y voz.',
    nav: { bots: 'Bots', mcp: 'MCP', sdk: 'SDK', webhooks: 'Webhooks', oauth: 'OAuth' },
    sdkTitle: 'SDK de TypeScript',
    sdkLead: 'Comandos, botones, eventos y voz con unas pocas líneas de código.',
    webhooksTitle: 'Webhooks',
    webhooksLead: 'Eventos sin conexión permanente: una petición POST firmada con HMAC y reintentos si algo falla.',
    webhooksPoints: ['Webhook del bot: mensajes, reacciones, tareas, reuniones, botones', 'Firma HMAC-SHA256 en la cabecera X-Calab-Signature', 'Reintentos ante fallos y cola de eventos', 'Webhook del tablero: cada cambio en las tareas (plan Business y superiores)'],
    oauthTitle: 'Iniciar sesión con Calab',
    oauthLead: 'OAuth 2.0 y OpenID Connect: tus servicios internos dejan entrar a los empleados con su cuenta de Calab.',
    oauthPoints: ['Authorization Code + PKCE (S256)', 'Pantalla de consentimiento con permisos', 'userinfo, refresh y revocación de tokens', 'Los clientes se crean en los ajustes del espacio'],
    docs: 'Documentación',
  },
  features: {
    canvas: { eyebrow: 'Lienzo', title: 'Una pizarra online dentro de la llamada', text: 'Un lienzo infinito para retrospectivas, esquemas y lluvias de ideas. Se abre en la sala de voz y todos lo editan a la vez.', points: ['Notas adhesivas, formas, flechas y texto', 'Votación con puntos y temporizador', 'Cursores de tus compañeros en tiempo real', 'Tarjeta del lienzo en el chat y en la página de la wiki'] },
    ai: { eyebrow: 'IA', title: 'IA donde ahorra tiempo', text: 'Tareas inteligentes a partir de texto y archivos, resúmenes y transcripciones de reuniones, y cualquier modelo mediante MCP.', points: ['Tarea inteligente: tablero, prioridad y búsqueda de duplicados', 'Resumen y transcripción de cada grabación', 'Claude y agentes del IDE como bots mediante MCP', 'Desde el plan Business; procesamiento a cargo de GPTunneL'] },
    recording: { eyebrow: 'Grabaciones de reuniones', title: 'Grabación, resumen y transcripción', text: 'La grabación la hace el servidor. Al terminar la reunión, el chat de la sala recibe una tarjeta con el resumen, el audio y el texto completo.', points: ['Cualquier miembro, salvo los invitados, puede iniciarla', 'Búsqueda de palabras en la transcripción', 'El audio se conserva 30 días', 'La grabación se puede desactivar en los ajustes de la sala'] },
  },
};

const zh: PageCopy = {
  developers: {
    metaTitle: 'Calab 开发者平台：机器人、MCP、SDK、Webhook 与 OAuth',
    metaDescription: '机器人使用与应用相同的 API；MCP 支持 Claude 和 IDE 中的智能体；TypeScript SDK；带 HMAC 签名的 Webhook；基于 OAuth 2.0 的“使用 Calab 登录”。',
    eyebrow: '开发者',
    title: '把 Calab 当作平台',
    lead: '机器人、LLM 智能体和你自己的应用，都使用与 Calab 相同的 API：聊天、任务、日历、语音。',
    nav: { bots: '机器人', mcp: 'MCP', sdk: 'SDK', webhooks: 'Webhook', oauth: 'OAuth' },
    sdkTitle: 'TypeScript SDK',
    sdkLead: '命令、按钮、事件和语音，几行代码即可搞定。',
    webhooksTitle: 'Webhook',
    webhooksLead: '无需保持长连接就能接收事件：带 HMAC 签名的 POST 请求，失败时自动重试。',
    webhooksPoints: ['机器人 Webhook：消息、表情回应、任务、会议、按钮', '签名使用 HMAC-SHA256，位于 X-Calab-Signature 请求头', '失败自动重试，并带事件队列', '看板 Webhook：任务的每一次变更（Business 及以上方案）'],
    oauthTitle: '使用 Calab 登录',
    oauthLead: 'OAuth 2.0 与 OpenID Connect：公司内部服务可以让员工直接用 Calab 账号登录。',
    oauthPoints: ['Authorization Code + PKCE (S256)', '显示权限范围的授权确认页', 'userinfo、refresh 与令牌撤销', '在工作区设置中创建客户端'],
    docs: '文档',
  },
  features: {
    canvas: { eyebrow: '白板', title: '语音通话中的在线白板', text: '无限画布，适合复盘、画图和头脑风暴。在语音房间中打开，所有人同时编辑。', points: ['便签、图形、箭头和文字', '圆点投票和计时器', '实时显示同事的光标', '白板卡片可发到聊天和维基页面'] },
    ai: { eyebrow: 'AI', title: '只在能省时间的地方用 AI', text: '根据文字和文件生成智能任务，生成会议摘要和文字记录，并可通过 MCP 接入任意模型。', points: ['智能任务：自动选择看板、优先级并检查重复', '每段录音都有摘要和文字记录', 'Claude 和 IDE 智能体通过 MCP 作为机器人接入', 'Business 方案起提供；由 GPTunneL 处理'] },
    recording: { eyebrow: '会议录制', title: '录制、摘要与文字记录', text: '由服务器负责录制。会议结束后，房间聊天会收到一张卡片，包含摘要、音频和完整文字。', points: ['除访客外，任何成员都可以开始录制', '可在文字记录中按关键词搜索', '音频保存 30 天', '可在房间设置中禁止录制'] },
  },
};

const copies: Record<Locale, PageCopy> = { ru, en, es, zh };
export const getPageCopy = (l: Locale): PageCopy => copies[l];
