# Телефон: полировка UI/UX (владелец, 13.10.2026)

Ориентиры — Telegram iOS (в первую очередь) и немного Discord. Референсы владельца:
`/Volumes/My Shared Files/Isola Desktop/screenshots/IMG_3375…3387.PNG`. Десктоп не трогаем:
всё под `mobile:` / `useMobile()` / `isMobileNow()` (≤ 768 px, `lib/phone.ts`, `lib/mobile.ts`).
Базовые правила телефона — `docs/08-design.md` «Мобильный веб», ADR-0073.

Жалобы владельца и что делаем:

| Жалоба | Решение |
|---|---|
| Табы переключений статуса в досках неудобны | На телефоне `Segmented` с > 3 вариантами или в прокручиваемом ряду → одна кнопка-пилюля `[текущее ⌄]`, открывающая список по центру (карточка меню, ADR-0073 §8) — `components/Choice.tsx` (T4) |
| Стрелка «назад» мелкая | `PhoneBack`: шеврон 30 px, `strokeWidth` 2.5, акцентный; плашка 36, цель 44 (T2) |
| Нет иконки у заголовка (Личные, Профиль и др.) | У каждого корня вкладки и вложенного экрана — иконка перед заголовком: диск 32 px (`bg-[var(--color-fill)]`, иконка 18 px, `text-muted`), либо аватар/эмодзи, где есть (T2) |
| Мелкая высота строк (люди в «Личных») | Строки DM и заметок — 68 px как у комнат (аватар 44, имя 15/600, превью 13); участники — 56 px (аватар 40); доски — 56 px; пункты профиля — 52 px (T3) |
| touch start отрабатывает не везде | Мгновенный `:active` отклик на касание (WebKit требует `touchstart`-слушатель на `document`), `-webkit-touch-callout: none` / `user-select: none` на строках с long-press, `touch-action: manipulation` (T1) |
| Не хватает свайпов | Сообщение — свайп влево → «Ответить» (как Telegram); строка комнаты — свайп влево → «Прочитано» · «Тихо/Звук» (как у DM, docs/09 #51); день календаря — свайп влево/вправо → соседний день (T5) |
| Long press где уместно | Строки участников, задач (список и карточка), досок, заметок, событий календаря — долгое нажатие открывает то же меню, что «…» (Radix `ContextMenu`, у Radix свой 700 мс long-press на touch) (T5) |
| Тактильный отклик | `lib/haptics.ts`: Android — `navigator.vibrate`; iOS 17.4+ — клик по скрытому `<input type="checkbox" switch>`; всё feature-detected, no-op где нет. Настройка «Виброотклик» (Основное, только телефон, по умолчанию вкл.). Срабатывает на: смена вкладки, выбор в `Segmented`/`Choice`, `Switch`, открытие меню по long-press, порог свайпа, микрофон/наушники (T1) |

## Задачи

- **T1 — Касания и тактильность** (Opus): `lib/haptics.ts` (+ тест), `lib/mobile.ts`, `app/styles.css`
  (press-отклик, callout), `components/ui.tsx` (только вызовы haptics в `Segmented`/`Switch`),
  `MobileShell.tsx` (только `TabButton`), `MobileVoiceStrip.tsx`, `lib/phoneMenus.ts` (haptic при
  открытии по long-press), `features/dm/rowSwipe.ts`, настройка в `AppSettingsDialog` + `stores/prefs.ts` + i18n.
- **T2 — Шапки** (Sonnet): `components/PhoneHeader.tsx` (`PhoneBack` крупнее, `icon` у `PhoneHeader`
  и `RootTitle`), все вызовы: `MobileShell.tsx` (`RootTitle`, `MembersPage`), `RoomHeader.tsx`
  (иконка комнаты), `SettingsScreen.tsx`, `SearchResultsPanel.tsx`, `EventPanel`, `DayView`
  («Подобрать время»), `ArchivedChat`, `PhoneProfile`.
- **T3 — Строки списков** (Sonnet): `features/dm/DmSidebar.tsx` (DM и заметки), `shell/MembersPanel.tsx`
  (ветка `drawer`), `boards/BoardsList.tsx`, `shell/PhoneProfile.tsx`.
- **T4 — Choice на телефоне** (Sonnet): `components/Choice.tsx` (новый), `boards/BoardsView.tsx`,
  `boards/CompletionSwitch.tsx`, `boards/Timeline.tsx`, `boards/TaskPanel.tsx`, другие `Segmented`,
  которые не влезают в 390 px.
- **T5 — Свайпы и long press** (Opus, после слияния T1 и T3): `lib/rowSwipe.ts` (обобщить из
  `features/dm/rowSwipe.ts`), `chat/MessageBubble.tsx`, `shell/PhoneRoomList.tsx`, `calendar/DayView.tsx`,
  `boards/ListView.tsx`, `boards/TaskCard.tsx`, `boards/BoardsList.tsx`, `shell/MembersPanel.tsx`, заметки.
- **T6 — QA-проход** (Sonnet, в конце): полный `mobile.visual.spec.ts` один раз, смотреть каждый PNG,
  список проблем; инварианты на трёх телефонах.

## Как проверяем (каждый агент)

```
cd apps/desktop && pnpm build:web
CALABA_MOBILE_SHOTS=<свой каталог> npx playwright test --config playwright.mobile.config.ts --project webkit-iphone-14 -g "<экраны>"
npx playwright test --config playwright.mobile.config.ts -g "<экраны>"            # инварианты на трёх телефонах
npx playwright test --config playwright.mobile.config.ts --project webkit-iphone-14 -g "<экраны>" --update-snapshots=all   # только намеренные изменения
```

Агент смотрит каждый PNG затронутого экрана один раз и перечисляет проблемы в отчёте. Mock-сервер
берёт случайный порт — WebKit-прогоны разных агентов могут идти параллельно. Плюс
`pnpm -s typecheck`, `pnpm -s lint`, `pnpm -F @calaba/desktop test` (целевые файлы). Новые строки
i18n — во всех четырёх локалях (`i18n/ru|en|es|zh-CN`, тест `i18n.keys.test.ts`).
