import type { Locale } from './locales';

/**
 * Home page section «Телефония» (CBF-86): the SIP number as a small team PBX. Facts: ADR-0046 (outbound,
 * Business plan only), 0117 (inbound, extensions, IVR, bot as a target), 0121/0125 (registration without
 * port forwarding), 0124 (group fallback), 0128 (active calls), 0129 (dial an extension from the menu),
 * 0131 (recording to the Disk), 0132 (transfer). A bot answers only through the Bot API (SIP_INBOUND_RING
 * + accept), not out of the box: worded as a developer capability.
 */
export type Telephony = {
  eyebrow: string;
  title: string;
  lead: string;
  points: { title: string; text: string }[];
  botTitle: string;
  botText: string;
  plan: string;
  docs: string;
  botDocs: string;
};

const telephonies: Record<Locale, Telephony> = {
  ru: {
    eyebrow: 'Телефония',
    title: 'Телефонная станция в команде',
    lead: 'Подключите SIP-провайдера, и входящие на ваш номер принимают сотрудники прямо в Calab: на компьютере и в веб-версии, в том числе на телефоне. Исходящие набираются из голосовой комнаты.',
    points: [
      { title: 'Свой SIP-номер', text: 'Сервер регистрируется у провайдера с логином и паролем, как настольный телефон. Пробрасывать порты не нужно.' },
      { title: 'Внутренние номера', text: 'Номер из 2–6 цифр у сотрудника или бота. Его можно набрать из голосового меню, не дожидаясь конца записи.' },
      { title: 'Голосовое меню (IVR)', text: 'Загрузите приветствие и назначьте кнопкам маршруты: сотрудник, бот, группа или другое меню. Нажать можно, пока запись ещё играет.' },
      { title: 'Группы и переадресация', text: 'Звонок получают все сразу или по очереди. Если никто не ответил за N секунд — другая группа, сотрудник, бот, меню или отбой.' },
      { title: 'Перевод и активные звонки', text: 'Переведите звонок коллеге: он останется у вас, пока тот не ответит. Администратор видит идущие звонки и этап каждого.' },
      { title: 'Запись на Диск', text: 'Разговоры сохраняются на Диск команды в папку phone_recordings. Предупреждение о записи звонящий слышит в голосовом меню.' },
    ],
    botTitle: 'Даже бот может взять трубку',
    botText: 'Бот может сам принять звонок через Bot API — например, ответить голосом и завести задачу. Для этого бот должен обрабатывать звонки в своём коде: готового бота без программирования нет.',
    plan: 'Телефония — в тарифах Business и Enterprise. Звонки оплачиваются у вашего SIP-провайдера.',
    docs: 'Как настроить телефонию',
    botDocs: 'Bot API',
  },
  en: {
    eyebrow: 'Telephony',
    title: 'A phone system for your team',
    lead: 'Connect a SIP provider and your team answers calls to your number right in Calab: on desktop and on the web app, phones included. Outgoing calls are dialed from a voice room.',
    points: [
      { title: 'Your own SIP number', text: 'The server registers with the provider using a login and password, like a desk phone. No port forwarding needed.' },
      { title: 'Internal numbers', text: 'A 2–6 digit number for a person or a bot. It can be dialed from the voice menu without waiting for the recording to end.' },
      { title: 'Voice menu (IVR)', text: 'Upload a greeting and give each key a route: a person, a bot, a group or another menu. Callers can press a key while the recording still plays.' },
      { title: 'Groups and fallback', text: 'A call rings everyone at once or one by one. If nobody picks up within N seconds: another group, a person, a bot, a menu or hang up.' },
      { title: 'Transfer and active calls', text: 'Transfer a call to a colleague: it stays with you until they answer. Admins see the calls in progress and the step of each.' },
      { title: 'Recording to the Disk', text: 'Conversations are saved to the team Disk in the phone_recordings folder. The caller hears the recording notice in the voice menu.' },
    ],
    botTitle: 'Even a bot can pick up the phone',
    botText: 'A bot can answer a call itself through the Bot API — for example, reply by voice and create a task. The bot has to handle calls in its own code: there is no ready-made no-code bot.',
    plan: 'Telephony is part of the Business and Enterprise plans. Calls are paid to your SIP provider.',
    docs: 'How to set up telephony',
    botDocs: 'Bot API',
  },
  es: {
    eyebrow: 'Telefonía',
    title: 'Una centralita para tu equipo',
    lead: 'Conecta un proveedor SIP y tu equipo atiende las llamadas a tu número directamente en Calab: en el escritorio y en la versión web, también en el móvil. Las llamadas salientes se marcan desde una sala de voz.',
    points: [
      { title: 'Tu propio número SIP', text: 'El servidor se registra en el proveedor con usuario y contraseña, como un teléfono de mesa. No hace falta abrir puertos.' },
      { title: 'Números internos', text: 'Un número de 2 a 6 cifras para una persona o un bot. Se puede marcar desde el menú de voz sin esperar al final de la grabación.' },
      { title: 'Menú de voz (IVR)', text: 'Sube un saludo y asigna a cada tecla una ruta: una persona, un bot, un grupo u otro menú. Se puede pulsar mientras suena la grabación.' },
      { title: 'Grupos y desvío', text: 'La llamada suena a todos a la vez o uno por uno. Si nadie contesta en N segundos: otro grupo, una persona, un bot, un menú o colgar.' },
      { title: 'Transferencia y llamadas activas', text: 'Transfiere una llamada a un compañero: sigue contigo hasta que conteste. Los administradores ven las llamadas en curso y el paso de cada una.' },
      { title: 'Grabación en el Disco', text: 'Las conversaciones se guardan en el Disco del equipo, en la carpeta phone_recordings. Quien llama oye el aviso de grabación en el menú de voz.' },
    ],
    botTitle: 'Hasta un bot puede coger el teléfono',
    botText: 'Un bot puede atender una llamada por sí mismo a través de la API de bots: por ejemplo, responder con voz y crear una tarea. El bot debe gestionar las llamadas en su propio código: no hay un bot listo sin programar.',
    plan: 'La telefonía está en los planes Business y Enterprise. Las llamadas se pagan a tu proveedor SIP.',
    docs: 'Cómo configurar la telefonía',
    botDocs: 'API de bots',
  },
  zh: {
    eyebrow: '电话',
    title: '团队的电话总机',
    lead: '接入 SIP 服务商后，团队成员可直接在 Calab 中接听拨入你号码的来电：桌面端和网页版均可，手机上也行。外呼则在语音房间中拨号。',
    points: [
      { title: '你自己的 SIP 号码', text: '服务器像桌面电话一样，用账号和密码向服务商注册。无需端口转发。' },
      { title: '内部分机号', text: '为成员或机器人分配 2–6 位分机号。可在语音菜单中直接拨打，无需等录音播完。' },
      { title: '语音菜单（IVR）', text: '上传问候语，并为每个按键指定去向：成员、机器人、群组或其他菜单。录音播放时即可按键。' },
      { title: '群组与转接兜底', text: '来电可同时振铃或依次振铃。若 N 秒内无人接听：转到其他群组、成员、机器人、菜单，或挂断。' },
      { title: '转接与进行中的通话', text: '把通话转给同事：对方接听前通话仍在你手上。管理员可查看正在进行的通话及其所处环节。' },
      { title: '录音存入云盘', text: '通话保存到团队云盘的 phone_recordings 文件夹。来电者会在语音菜单中听到录音提示。' },
    ],
    botTitle: '机器人也能接电话',
    botText: '机器人可通过 Bot API 自行接听来电——例如用语音回答并创建任务。机器人需要在自己的代码中处理来电：没有免编程的现成机器人。',
    plan: '电话功能包含在 Business 和 Enterprise 套餐中。通话费用由你的 SIP 服务商收取。',
    docs: '如何配置电话',
    botDocs: 'Bot API',
  },
};

export const getTelephony = (locale: Locale): Telephony => telephonies[locale];
