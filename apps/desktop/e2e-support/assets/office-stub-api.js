// A STUB of the Document Server's api.js for the visual harness (ADR-0143). It draws a fake
// document / spreadsheet / presentation in the layout of ONLYOFFICE Docs 8–10 with the compact
// header (logo, save / print / undo / redo, the file name, «open file location»), the tab row, the
// ribbon, the ruler, the working area and the status bar («Все изменения сохранены»), in the
// light (blue-grey header) and dark themes, so the Calab shell around the editor can be checked
// without a Document Server. It is NOT ONLYOFFICE: real-editor screenshots come from the Docker plan.
(function (win) {
  'use strict';
  var THEMES = {
    'default-dark': { head: '#2a2a2a', tab: '#2a2a2a', tabOn: '#404040', tool: '#404040', work: '#555555', side: '#404040', cell: '#2b2b2b', hdr: '#3a3a3a', fg: '#e0e0e0', headFg: '#e0e0e0', muted: '#bdbdbd', line: '#4d4d4d', grid: '#474747', accent: '#6fa3ff', status: '#404040' },
    'default-light': { head: '#446995', tab: '#446995', tabOn: '#f7f7f7', tool: '#f7f7f7', work: '#eeeeee', side: '#f7f7f7', cell: '#ffffff', hdr: '#f1f1f1', fg: '#333333', headFg: '#ffffff', muted: '#5f5f5f', line: '#dcdcdc', grid: '#dadada', accent: '#446995', status: '#f7f7f7' },
  };
  function el(tag, css, text) {
    var e = win.document.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }
  // A big ribbon button: a glyph over a small label.
  function big(t, glyph, label) {
    var b = el('div', 'display:flex;flex-direction:column;align-items:center;gap:2px;min-width:58px;padding:2px 4px;color:' + t.fg);
    b.appendChild(el('span', 'font:22px/26px Arial,sans-serif;color:' + t.muted, glyph));
    b.appendChild(el('span', 'font:11px Arial,sans-serif;white-space:nowrap', label));
    return b;
  }
  function sep(t) {
    return el('span', 'width:1px;height:56px;background:' + t.line + ';margin:0 8px;flex:none');
  }
  function DocEditor(id, config) {
    var root = win.document.getElementById(id);
    var c = (config.editorConfig && config.editorConfig.customization) || {};
    var t = THEMES[c.uiTheme] || THEMES['default-dark'];
    var light = c.uiTheme === 'default-light';
    var kind = config.documentType === 'cell' ? 'cell' : config.documentType === 'slide' ? 'slide' : 'word';
    var edit = config.editorConfig && config.editorConfig.mode === 'edit';
    var ev = config.events || {};
    var fault = (config.editorConfig && config.editorConfig.calabStub && config.editorConfig.calabStub.fault) || '';
    root.innerHTML = '';
    var wrap = el('div', 'display:flex;flex-direction:column;height:100%;font:12px/1.4 Arial,sans-serif;background:' + t.work + ';color:' + t.fg);

    // Header: the logo, save / print / undo / redo, the name, «open file location».
    var head = el('div', 'display:flex;align-items:center;gap:14px;height:32px;padding:0 12px;background:' + t.head + ';color:' + t.headFg);
    head.appendChild(el('span', 'font:bold 11px Arial;letter-spacing:.2px', '≋ ONLYOFFICE'));
    ['▣', '⎙', '↶', '↷'].forEach(function (g) { head.appendChild(el('span', 'font-size:15px;opacity:.9', g)); });
    head.appendChild(el('span', 'flex:1;text-align:center;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', config.document.title));
    if (!edit) head.appendChild(el('span', 'font-size:11px;opacity:.85', 'Просмотр'));
    var back = el('span', 'font-size:11px;cursor:pointer;opacity:.95;white-space:nowrap;padding:2px 6px;border-radius:3px', '↩ ' + ((c.goback && c.goback.text) || 'Открыть расположение файла'));
    back.setAttribute('data-testid', 'stub-goback');
    back.addEventListener('click', function () { if (ev.onRequestClose) ev.onRequestClose(); });
    if (c.goback) head.appendChild(back);
    wrap.appendChild(head);

    // Tab row.
    var tabsEl = el('div', 'display:flex;gap:2px;align-items:flex-end;height:30px;padding:0 10px;background:' + t.tab + ';color:' + t.headFg + ';font-weight:bold');
    var names = kind === 'cell' ? ['Файл', 'Главная', 'Вставка', 'Формула', 'Данные', 'Вид', 'Плагины'] : kind === 'slide' ? ['Файл', 'Главная', 'Вставка', 'Переходы', 'Анимация', 'Вид', 'Плагины'] : ['Файл', 'Главная', 'Вставка', 'Макет', 'Ссылки', 'Совместная работа', 'Плагины'];
    if (!edit) names = ['Файл', 'Вид', 'Плагины'];
    names.forEach(function (s, i) {
      var on = i === 1 || (!edit && i === 1);
      tabsEl.appendChild(el('span', 'padding:7px 11px;border-radius:3px 3px 0 0;' + (on ? 'background:' + t.tabOn + ';color:' + t.fg : ''), s));
    });
    wrap.appendChild(tabsEl);

    // Ribbon.
    var rib = el('div', 'display:flex;align-items:center;height:76px;padding:0 10px;background:' + t.tool + ';border-bottom:1px solid ' + t.line + ';overflow:hidden');
    if (edit) {
      var items = kind === 'cell'
        ? [['⎘', 'Вставить'], ['B', 'Шрифт'], ['≡', 'Выравнивание'], ['%', 'Число'], null, ['Σ', 'Сумма'], ['⊞', 'Таблица'], ['▤', 'Условное']]
        : kind === 'slide'
          ? [['＋', 'Слайд'], ['▭', 'Макет'], ['B', 'Шрифт'], ['≡', 'Абзац'], null, ['▣', 'Картинка'], ['▥', 'Таблица'], ['◔', 'Диаграмма']]
          : [['⎘', 'Вставить'], ['B', 'Шрифт'], ['≡', 'Абзац'], ['Aa', 'Стили'], null, ['▣', 'Картинка'], ['▥', 'Таблица'], ['◔', 'Диаграмма']];
      items.forEach(function (it) { rib.appendChild(it ? big(t, it[0], it[1]) : sep(t)); });
    } else {
      [['⌕', 'Поиск'], ['▤', 'Вид'], ['⎙', 'Печать'], ['⇩', 'Скачать']].forEach(function (it) { rib.appendChild(big(t, it[0], it[1])); });
    }
    wrap.appendChild(rib);

    // Working area.
    var body = el('div', 'flex:1;min-height:0;overflow:hidden;position:relative;display:flex;background:' + t.work);
    var side = el('div', 'width:34px;flex:none;background:' + t.side + ';border-right:1px solid ' + t.line + ';display:flex;flex-direction:column;align-items:center;gap:14px;padding-top:12px;color:' + t.muted + ';font-size:15px');
    ['⌕', '✎', '☰', '◔'].forEach(function (g) { side.appendChild(el('span', '', g)); });
    if (kind === 'word') body.appendChild(side);
    var main = el('div', 'flex:1;min-width:0;display:flex;flex-direction:column');
    if (kind === 'cell') {
      var fx = el('div', 'display:flex;align-items:center;height:26px;background:' + t.tool + ';border-bottom:1px solid ' + t.line);
      fx.appendChild(el('span', 'width:70px;padding:0 8px;border-right:1px solid ' + t.line, 'B3'));
      fx.appendChild(el('span', 'padding:0 10px;color:' + t.muted, 'fx'));
      fx.appendChild(el('span', '', '=СУММ(B2:B9)'));
      main.appendChild(fx);
      var gw = el('div', 'flex:1;min-height:0;overflow:hidden;background:' + t.cell);
      var grid = el('table', 'border-collapse:collapse;table-layout:fixed;color:' + t.fg);
      var cols = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
      var data = [['Сотрудник', 'Начало', 'Конец', 'Дней'], ['Анна', '01.07.2026', '14.07.2026', '14'], ['Борис', '15.07.2026', '28.07.2026', '14'], ['Вера', '03.08.2026', '16.08.2026', '14']];
      for (var r = 0; r < 34; r++) {
        var tr = el('tr', '');
        for (var ci = 0; ci < cols.length; ci++) {
          var hd = r === 0 || ci === 0;
          var txt = r === 0 ? cols[ci] : ci === 0 ? String(r) : (data[r - 1] && data[r - 1][ci - 1]) || '';
          tr.appendChild(el('td', 'height:21px;width:' + (ci === 0 ? 34 : 88) + 'px;padding:0 5px;border:1px solid ' + t.grid + ';white-space:nowrap;overflow:hidden;' + (hd ? 'background:' + t.hdr + ';color:' + t.muted + ';text-align:center;' : '') + (r === 3 && ci === 2 ? 'outline:2px solid ' + t.accent + ';outline-offset:-2px;' : ''), txt));
        }
        grid.appendChild(tr);
      }
      gw.appendChild(grid);
      main.appendChild(gw);
      var sheets = el('div', 'display:flex;align-items:center;gap:2px;height:26px;padding:0 8px;background:' + t.tool + ';border-top:1px solid ' + t.line + ';color:' + t.muted);
      sheets.appendChild(el('span', 'padding:3px 12px;background:' + t.cell + ';color:' + t.fg + ';border-radius:3px 3px 0 0;font-weight:bold', 'Лист1'));
      sheets.appendChild(el('span', 'padding:3px 12px', 'Лист2'));
      sheets.appendChild(el('span', 'padding:3px 8px', '＋'));
      main.appendChild(sheets);
    } else if (kind === 'slide') {
      var deck = el('div', 'display:flex;flex:1;min-height:0');
      var thumbs = el('div', 'width:132px;flex:none;padding:12px 10px;display:flex;flex-direction:column;gap:10px;background:' + t.side + ';border-right:1px solid ' + t.line + ';overflow:hidden');
      for (var n = 1; n <= 6; n++) {
        var th = el('div', 'display:flex;gap:6px;align-items:flex-start;color:' + t.muted);
        th.appendChild(el('span', 'width:12px;font-size:10px;text-align:right', String(n)));
        th.appendChild(el('div', 'flex:1;aspect-ratio:16/9;background:#fff;border-radius:2px;outline:' + (n === 1 ? '2px solid ' + t.accent : '1px solid ' + t.line)));
        thumbs.appendChild(th);
      }
      var stage = el('div', 'flex:1;display:grid;place-items:center;background:' + t.work);
      var sl = el('div', 'width:min(560px,86%);aspect-ratio:16/9;background:#fff;color:#222;padding:30px 40px;box-shadow:0 1px 6px rgba(0,0,0,.35);display:flex;flex-direction:column;justify-content:center');
      sl.appendChild(el('div', 'font:bold 28px Arial;color:#2a6ad6', 'Calab: питч'));
      sl.appendChild(el('div', 'font:16px Arial;margin-top:10px;color:#555', 'Голос и задачи в одном окне'));
      stage.appendChild(sl);
      deck.appendChild(thumbs);
      deck.appendChild(stage);
      main.appendChild(deck);
    } else {
      // The ruler and the page: a title, text and a donut chart, like the reference sample.
      main.appendChild(el('div', 'height:18px;margin:6px 56px 0 40px;background:repeating-linear-gradient(90deg,' + t.muted + ' 0 1px,transparent 1px 24px);opacity:.45'));
      var area = el('div', 'flex:1;min-height:0;overflow:hidden;display:flex;justify-content:center');
      var page = el('div', 'width:min(560px,92%);margin-top:10px;min-height:900px;background:#fff;color:#222;padding:48px 56px;box-shadow:0 1px 6px rgba(0,0,0,.3);font-family:Arial,sans-serif');
      page.appendChild(el('div', 'font-size:20px;line-height:30px;border-left:2px solid #6a9a50;padding-left:12px;margin-bottom:22px', 'Договор: всё нужное для работы вашей команды'));
      var row = el('div', 'display:flex;gap:18px;align-items:flex-start');
      row.appendChild(el('div', 'flex:1;font-size:14px;line-height:22px;color:#444', 'Лицензиар предоставляет Лицензиату право использования программы для ЭВМ на условиях простой (неисключительной) лицензии. Стороны согласовали порядок расчётов и сроки.'));
      var chart = el('div', 'width:120px;height:120px;border-radius:50%;flex:none;background:conic-gradient(#5b9bd5 0 35%,#ed7d31 0 60%,#a5a5a5 0 78%,#ffc000 0 90%,#70ad47 0 100%);display:grid;place-items:center');
      chart.appendChild(el('div', 'width:56px;height:56px;border-radius:50%;background:#fff'));
      row.appendChild(chart);
      page.appendChild(row);
      ['порядок расчётов', 'сроки оплаты', 'ответственность сторон'].forEach(function (s) { page.appendChild(el('div', 'font-size:14px;line-height:24px;color:#3b7a2a;text-decoration:underline;margin-left:20px', '✥ ' + s)); });
      area.appendChild(page);
      main.appendChild(area);
    }
    body.appendChild(main);
    wrap.appendChild(body);

    // Status bar: the page, the save state (ONLYOFFICE words), the language.
    var foot = el('div', 'height:24px;flex:none;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 12px;background:' + t.status + ';border-top:1px solid ' + t.line + ';color:' + t.muted + ';font-size:11px');
    foot.appendChild(el('span', '', kind === 'cell' ? 'Лист 1 из 2' : kind === 'slide' ? 'Слайд 1 из 6' : 'Страница 1 из 2'));
    var state = el('span', '', 'Все изменения сохранены');
    state.setAttribute('data-testid', 'stub-state');
    foot.appendChild(state);
    var right = el('span', 'justify-self:end', 'Русский · Заглушка редактора');
    foot.appendChild(right);
    wrap.appendChild(foot);
    root.appendChild(wrap);

    var setState = function (dirty) { state.textContent = dirty ? 'Сохранение…' : 'Все изменения сохранены'; };
    setTimeout(function () {
      if (ev.onAppReady) ev.onAppReady();
      if (ev.onDocumentReady) ev.onDocumentReady();
      if (ev.onDocumentStateChange) ev.onDocumentStateChange({ data: false });
      if (fault === 'token' && ev.onError) ev.onError({ data: { errorCode: -20, errorDescription: 'token' } });
    }, 30);
    // A click in edit mode is an edit: unsaved until the autosave (never with the 'stuck' fault).
    var timer = 0;
    function save() {
      setState(false);
      if (ev.onDocumentStateChange) ev.onDocumentStateChange({ data: false });
    }
    if (edit) {
      body.addEventListener('click', function () {
        setState(true);
        if (ev.onDocumentStateChange) ev.onDocumentStateChange({ data: true });
        if (fault !== 'stuck') {
          win.clearTimeout(timer);
          timer = win.setTimeout(save, 2500);
        }
      });
    }
    this.requestSave = function () { if (fault !== 'stuck') save(); };
  }
  DocEditor.prototype.destroyEditor = function () {};
  win.DocsAPI = { DocEditor: DocEditor };
})(window);
