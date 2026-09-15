'use strict';

/*
 * Daily reports: all operational data is stored locally on the server.
 * Requires Node.js 22+. No third-party libraries.
 */
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: sleep} = require('node:timers/promises');

const TZ = 'Europe/Moscow';
const ROLES = Object.freeze({
  CEO: 'Генеральный директор', COMMERCIAL: 'Коммерческий директор', ROP: 'Руководитель отдела продаж',
  SALES: 'Менеджер по продажам', INTERN: 'Стажер продажник', FINANCE: 'Финансист',
  ASSISTANT: 'Ассистент', IT: 'IT / Тест'
});
const ROLE_CODES = Object.freeze({ceo: ROLES.CEO, com: ROLES.COMMERCIAL, rop: ROLES.ROP, sales: ROLES.SALES,
  intern: ROLES.INTERN, fin: ROLES.FINANCE, asst: ROLES.ASSISTANT, it: ROLES.IT});
const SALES_ROLES = new Set([ROLES.SALES, ROLES.INTERN]);
const FULL_ADMINS = new Set([ROLES.CEO, ROLES.COMMERCIAL]);
const METRICS = ['Заказы', 'Продажи', 'ОПН', 'ДРР(п)', 'ДРР(з)'];
const MENU = [['➕ Что сделано', '🌙 Вечерний отчёт'], ['👁 Мой отчёт', '✅ Сдать отчёт'],
  ['💡 Инсайт', '🎯 Фокус на завтра'], ['📊 Показатели', '✏️ Исправить отчёт'],
  ['📋 Отчёты', '👥 Сотрудники'], ['Отмена']];

function config(env = process.env) {
  const token = String(env.BOT_TOKEN || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('BOT_TOKEN_MISSING_OR_INVALID');
  const owners = new Set(String(env.OWNER_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x)));
  if (!owners.size) throw new Error('OWNER_TELEGRAM_IDS_REQUIRED');
  const dataDir = path.resolve(String(env.BOT_DATA_DIR || './data'));
  const reminderDays = new Set(String(env.REMINDER_DAYS || '1,2,3,4,5,6,7').split(',').map(Number).filter(n => n >= 1 && n <= 7));
  return {token, owners, dataDir, dbFile: path.join(dataDir, 'daily_reports.json'), reminderDays};
}
function moscow(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  const p = Object.fromEntries(fmt.formatToParts(now).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, stamp: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`};
}
function weekday(date) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return day || 7; }
function previousDate(date) { return new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10); }
function shortDate(date) { return date.split('-').reverse().join('.'); }
function key(date, id) { return `${date}|${id}`; }
function cleanText(value, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) return null;
  return text;
}
function nameParts(text) {
  const value = String(text || '').normalize('NFC').trim().replace(/\s+/g, ' '), parts = value.split(' ');
  const word = /^[\p{L}][\p{L}\p{M}]*(?:[-'’][\p{L}][\p{L}\p{M}]*)*$/u;
  return parts.length === 2 && value.length <= 100 && parts.every(x => word.test(x)) ? parts : null;
}
function listLines(text, maxChars = 5000) {
  const lines = String(text || '').split('\n').map(x => x.replace(/^\s*(?:\d+[.)]\s*|[-•]\s+)/, '').trim()).filter(Boolean);
  if (!lines.length || lines.length > 80 || lines.join('\n').length > maxChars) return null;
  return lines;
}
function parseMetrics(text) {
  if (/^(?:-|нет данных)$/i.test(String(text).trim())) return [null, null, null, null, null];
  const values = String(text).replace(/%/g, '').trim().split(/[\s;]+/);
  if (values.length !== 5 || values.some(x => !/^[+-]?\d+(?:[.,]\d+)?$/.test(x))) return null;
  const parsed = values.map(x => Number(x.replace(',', '.')));
  return parsed.some(x => !Number.isFinite(x) || Math.abs(x) > 10000000) ? null : parsed;
}
function emptyDb() { return {version: 2, users: {}, reports: {}, offset: 0, reminders: {}}; }

class Store {
  constructor(file) { this.file = file; fs.mkdirSync(path.dirname(file), {recursive: true}); this.data = this.load(); }
  load() {
    if (!fs.existsSync(this.file)) return emptyDb();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || data.version !== 2 || typeof data.users !== 'object' || typeof data.reports !== 'object') throw new Error('bad');
      return data;
    } catch (_) {
      throw new Error('DATABASE_FILE_INVALID_RESTORE_BACKUP');
    }
  }
  save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data), {encoding: 'utf8', mode: 0o600});
    fs.renameSync(temporary, this.file);
  }
  user(id) { return this.data.users[String(id)] || null; }
  putUser(user) { this.data.users[user.id] = user; this.save(); }
  report(id, date) { return this.data.reports[key(date, id)] || null; }
  putReport(report) { this.data.reports[key(report.date, report.userId)] = report; this.save(); }
  allUsers() { return Object.values(this.data.users); }
  reports(date) { return Object.values(this.data.reports).filter(r => r.date === date); }
}

class Telegram {
  constructor(token, fetchFn = fetch) { this.token = token; this.fetch = fetchFn; }
  async call(method, body = {}, signal) {
    let res;
    try { res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000)
    }); } catch (_) { throw Object.assign(new Error('TELEGRAM_NETWORK'), {retry: true}); }
    let json; try { json = await res.json(); } catch (_) { throw Object.assign(new Error('TELEGRAM_INVALID_RESPONSE'), {retry: true}); }
    if (!res.ok || !json.ok) {
      const code = Number(json.error_code || res.status), error = new Error(`TELEGRAM_${code}`);
      error.retry = ![400, 401, 403, 404, 409].includes(code); error.wait = Number(json.parameters?.retry_after || 0); throw error;
    }
    return json.result;
  }
  send(chatId, text, markup) {
    return this.call('sendMessage', {chat_id: String(chatId), text, reply_markup: markup || {keyboard: MENU, resize_keyboard: true, is_persistent: true}});
  }
  answerCallback(id) { return this.call('answerCallbackQuery', {callback_query_id: id}); }
}

function isOwner(user) { return FULL_ADMINS.has(user?.role); }
function isRop(user) { return user?.role === ROLES.ROP; }
function canAssign(actor, targetRole) { return isOwner(actor) || (isRop(actor) && [ROLES.SALES, ROLES.INTERN].includes(targetRole)); }
function canSee(actor, target) {
  return actor?.id === target?.id || isOwner(actor) || (isRop(actor) && SALES_ROLES.has(target?.role));
}
function roleButtons(actor, targetId) {
  return Object.entries(ROLE_CODES).filter(([, role]) => canAssign(actor, role))
    .map(([code, role]) => [{text: role, callback_data: `role:${targetId}:${code}`}]);
}
function displayRole(role) { return role || 'Не назначена'; }
function fullName(user) { return `${user.lastName} ${user.firstName}`.trim(); }
function percent(value) { return typeof value === 'number' ? `${String(value).replace('.', ',')}%` : '—'; }
function reportText(report) {
  let out = `#ежедневный_отчет ${shortDate(report.date)}\n${report.name}\n${report.role}\n\nИнсайт:\n${report.insight === null ? 'Не заполнен' : report.insight || '—'}\n\nЧто сделано:\n`;
  out += report.tasks.length ? report.tasks.map((x, i) => `${i + 1}. ${x}`).join('\n') : '—';
  if (SALES_ROLES.has(report.role)) {
    const current = report.metrics.personal || [], yesterday = report.yesterday.personal || [];
    out += `\n\nПоказатели: Сегодня | Вчера\n${METRICS.map((m, i) => `${m} — ${percent(current[i])} | ${percent(yesterday[i])}`).join('\n')}`;
  }
  return `${out}\n\nФокус на завтра\n${report.focus === null ? 'Не заполнен' : report.focus.length ? report.focus.map((x, i) => `${i + 1}. ${x}`).join('\n') : '—'}`;
}
function chunks(text) {
  const result = [];
  while (text.length > 3800) { let i = text.lastIndexOf('\n', 3800); if (i < 1800) i = 3800; result.push(text.slice(0, i)); text = text.slice(i).replace(/^\n/, ''); }
  return result.concat(text || []);
}
function freshReport(user, date, store) {
  const previous = store.report(user.id, previousDate(date));
  return {date, userId: user.id, name: fullName(user), role: user.role, tasks: [], done: false,
    insight: null, focus: null, metrics: {}, yesterday: previous?.status === 'Сдан' ? previous.metrics : {},
    state: null, wizard: false, status: 'Черновик', createdAt: moscow().stamp, updatedAt: moscow().stamp, submittedAt: ''};
}
function missing(report) {
  if (!report.done) return 'tasks';
  if (report.insight === null) return 'insight';
  if (report.focus === null) return 'focus';
  return SALES_ROLES.has(report.role) && !Object.prototype.hasOwnProperty.call(report.metrics, 'personal') ? 'metrics' : null;
}
function prompt(report) {
  if (report.state === 'tasks' || report.state === 'replaceTasks') return `Что сделано за ${shortDate(report.date)}? Каждый пункт с новой строки. Если задач не было — «-».`;
  if (report.state === 'insight') return 'Какой инсайт за день? Если нет — «-».';
  if (report.state === 'focus') return 'Фокус на завтра: задачи одним сообщением, каждая с новой строки. Если планов нет — «-».';
  if (report.state === 'metrics') return 'Введите свои показатели по личному сегменту: Заказы Продажи ОПН ДРР(п) ДРР(з).\nПример: 90 81 77 111 89\nНет данных: «нет данных».';
  return '';
}
function menuCommand(text) {
  const map = {'➕ Что сделано': '/done', '🌙 Вечерний отчёт': '/evening', '👁 Мой отчёт': '/report', '✅ Сдать отчёт': '/submit',
    '💡 Инсайт': '/insight', '🎯 Фокус на завтра': '/focus', '📊 Показатели': '/metrics', '✏️ Исправить отчёт': '/edit',
    '📋 Отчёты': '/reports', '👥 Сотрудники': '/staff', 'Отмена': '/cancel'};
  const value = String(text || '').trim(); const command = map[value] || (value.startsWith('/') ? value.split(/\s/)[0].split('@')[0].toLowerCase() : '');
  return {command, args: value.startsWith('/') ? value.replace(/^\S+\s*/, '').trim() : ''};
}

class DailyReportsBot {
  constructor({store, telegram, config, now = () => new Date()}) { Object.assign(this, {store, telegram, config, now}); }
  async send(id, text, markup) { for (const part of chunks(text)) await this.telegram.send(id, part, markup); }
  ensureUser(from) {
    const id = String(from.id); let user = this.store.user(id);
    if (!user) { user = {id, firstName: '', lastName: '', role: null, active: false, state: 'name', createdAt: moscow(this.now()).stamp, updatedAt: moscow(this.now()).stamp}; this.store.putUser(user); }
    return user;
  }
  bootstrap(user) {
    if (this.config.owners.has(user.id) && !user.role) { user.role = ROLES.CEO; user.active = true; user.updatedAt = moscow(this.now()).stamp; this.store.putUser(user); }
  }
  active(user) { return user.active && !!user.role && !!user.firstName && !!user.lastName; }
  async register(user, text) {
    const parts = nameParts(text);
    if (!parts) return this.send(user.id, 'Введите имя и фамилию одним сообщением, без отчества. Например: Иван Иванов.', {remove_keyboard: true});
    user.firstName = parts[0]; user.lastName = parts[1]; user.state = null; user.updatedAt = moscow(this.now()).stamp; this.bootstrap(user); this.store.putUser(user);
    if (this.active(user)) return this.send(user.id, `Готово: ${fullName(user)}\nДолжность: ${user.role}\nМожно заполнять отчёт.`);
    return this.send(user.id, `Данные сохранены: ${fullName(user)}\nОжидайте назначения должности. Руководитель сделает это через бота.`, {remove_keyboard: true});
  }
  reportFor(user, date) { return this.store.report(user.id, date) || freshReport(user, date, this.store); }
  async handleText(message) {
    if (!message?.from || message.from.is_bot || message.chat?.type !== 'private') return;
    const user = this.ensureUser(message.from); this.bootstrap(user);
    const text = String(message.text || '').trim();
    if (!text) return this.send(user.id, 'Принимаю только текстовые сообщения.');
    const {command, args} = menuCommand(text);
    if (!this.active(user)) return this.register(user, text);
    const date = moscow(new Date(message.date * 1000)).date;
    if (command === '/start' || command === '/help') return this.send(user.id, this.help(user));
    if (command === '/staff') return this.staff(user);
    if (command === '/assign') return this.assignPrompt(user, args);
    if (command === '/reports') return this.reports(user, args || date);
    if (command === '/report' && args) return this.singleReport(user, args, date);
    const report = this.reportFor(user, date);
    const answer = this.applyReportInput(user, report, text, command, args);
    report.updatedAt = moscow(this.now()).stamp; this.store.putReport(report);
    return this.send(user.id, answer);
  }
  help(user) {
    let text = 'Пишите выполненные задачи обычным сообщением — каждая строка станет пунктом.\nВечером нажмите «🌙 Вечерний отчёт».\n\nКоманды:\n/report — мой отчёт\n/reports YYYY-MM-DD — доступные отчёты за дату\n/cancel — выйти из текущего вопроса\n/tasks — заменить выполненное\n/delete 2 — удалить задачу №2';
    if (isOwner(user) || isRop(user)) text += '\n\n/staff — сотрудники\n/assign ID — назначить должность';
    return text;
  }
  applyReportInput(user, report, text, command, args) {
    if (command === '/cancel') { report.state = null; report.wizard = false; return 'Ввод отменён. Сохранённые данные остались.'; }
    if (command === '/report') return `Статус: ${report.status}\n\n${reportText(report)}`;
    if (report.status === 'Сдан' && command === '/edit') { report.status = 'Черновик'; report.submittedAt = ''; report.state = null; return 'Отчёт открыт для исправлений.'; }
    if (report.status === 'Сдан') return 'Отчёт уже сдан. Нажмите «✏️ Исправить отчёт», если нужно изменить его.';
    if (command === '/evening') { report.wizard = true; report.state = missing(report); return report.state ? prompt(report) : `Проверьте и нажмите «✅ Сдать отчёт».\n\n${reportText(report)}`; }
    if (command === '/submit') {
      const field = missing(report); if (field) { report.wizard = true; report.state = field; return `Сначала заполните это поле.\n\n${prompt(report)}`; }
      report.status = 'Сдан'; report.submittedAt = moscow(this.now()).stamp; report.state = null; report.wizard = false; return `✅ Отчёт сдан.\n\n${reportText(report)}`;
    }
    if (command === '/delete') { const n = Number(args); if (!Number.isInteger(n) || n < 1 || n > report.tasks.length) return 'Укажите номер существующей задачи: /delete 2'; report.tasks.splice(n - 1, 1); return `Задача удалена.\n${this.tasksText(report)}`; }
    if (['/done', '/tasks', '/insight', '/focus', '/metrics'].includes(command)) {
      if (command === '/metrics' && !SALES_ROLES.has(user.role)) return 'Для вашей должности показатели не требуются.';
      report.wizard = false; report.state = {'/done': 'tasks', '/tasks': 'replaceTasks', '/insight': 'insight', '/focus': 'focus', '/metrics': 'metrics'}[command];
      if (!args) return prompt(report); text = args;
    } else if (command) return 'Неизвестная команда. Нажмите /help.';
    const state = report.state;
    if (!state || state === 'tasks') {
      if (text === '-') report.done = true;
      else { const lines = listLines(text); if (!lines || report.tasks.length + lines.length > 80 || report.tasks.concat(lines).join('\n').length > 5000) return 'Сократите список задач.'; report.tasks.push(...lines); report.done = true; }
    } else if (state === 'replaceTasks') { const lines = text === '-' ? [] : listLines(text); if (!lines && text !== '-') return 'Напишите хотя бы одну задачу.'; report.tasks = lines; report.done = true; }
    else if (state === 'insight') { const v = text === '-' ? '' : cleanText(text, 2000); if (v === null) return 'Сократите инсайт до 2000 знаков.'; report.insight = v; }
    else if (state === 'focus') { const lines = text === '-' ? [] : listLines(text, 3000); if (!lines && text !== '-') return 'Напишите хотя бы одну задачу.'; report.focus = lines; }
    else if (state === 'metrics') { const metric = parseMetrics(text); if (!metric) return 'Нужно 5 чисел: Заказы Продажи ОПН ДРР(п) ДРР(з). Например: 90 81 77 111 89.'; report.metrics.personal = metric; }
    report.state = null;
    if (report.wizard) { report.state = missing(report); return report.state ? `Сохранено.\n\n${prompt(report)}` : `Проверьте и нажмите «✅ Сдать отчёт».\n\n${reportText(report)}`; }
    return state === 'tasks' || state === 'replaceTasks' || !state ? `✅ Сохранено.\n${this.tasksText(report)}` : '✅ Сохранено.';
  }
  tasksText(report) { return report.tasks.length ? report.tasks.map((x, i) => `${i + 1}. ${x}`).join('\n') : 'Задач пока нет.'; }
  async staff(actor) {
    if (!isOwner(actor) && !isRop(actor)) return this.send(actor.id, 'У вас нет доступа к сотрудникам.');
    const users = this.store.allUsers().filter(user => canSee(actor, user) || (!user.role && isRop(actor))).sort((a, b) => fullName(a).localeCompare(fullName(b), 'ru'));
    if (!users.length) return this.send(actor.id, 'Сотрудников пока нет.');
    const text = users.map(u => `${u.id} — ${fullName(u) || 'Имя не заполнено'} — ${displayRole(u.role)}${u.active ? '' : ' (ожидает назначения)'}`).join('\n');
    return this.send(actor.id, `Сотрудники:\n${text}\n\nНазначить: /assign ID`);
  }
  async assignPrompt(actor, args) {
    if (!isOwner(actor) && !isRop(actor)) return this.send(actor.id, 'У вас нет права назначать должности.');
    const target = this.store.user(args.trim());
    if (!target || !target.firstName) return this.send(actor.id, 'Сотрудник не найден. Нажмите «👥 Сотрудники» и скопируйте ID.');
    const buttons = roleButtons(actor, target.id);
    if (!buttons.length) return this.send(actor.id, 'Для вашей должности нет доступных назначений.');
    return this.send(actor.id, `Выберите должность для ${fullName(target)}:`, {inline_keyboard: buttons});
  }
  async reports(actor, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return this.send(actor.id, 'Дата в формате YYYY-MM-DD, например /reports 2026-09-15');
    const reports = this.store.reports(date).filter(r => canSee(actor, this.store.user(r.userId)));
    if (!reports.length) return this.send(actor.id, `За ${shortDate(date)} доступных отчётов нет.`);
    const intro = `Отчёты за ${shortDate(date)}: ${reports.length}. Для одного отчёта: /report ID ${date}\n\n`;
    const list = reports.map(r => `${r.userId} — ${r.name} — ${r.role} — ${r.status}`).join('\n');
    return this.send(actor.id, intro + list);
  }
  async singleReport(actor, args, defaultDate) {
    const [id, date = defaultDate] = args.split(/\s+/), target = this.store.user(id);
    if (!target || !canSee(actor, target)) return this.send(actor.id, 'Отчёт недоступен.');
    const report = this.store.report(id, date); return this.send(actor.id, report ? reportText(report) : 'За эту дату отчёта нет.');
  }
  async callback(query) {
    const actor = this.store.user(query.from?.id); const m = /^role:(\d+):(\w+)$/.exec(String(query.data || ''));
    await this.telegram.answerCallback(query.id).catch(() => {});
    if (!actor || !m || !ROLE_CODES[m[2]]) return;
    const target = this.store.user(m[1]), role = ROLE_CODES[m[2]];
    if (!target || !canAssign(actor, role)) return this.send(actor.id, 'Назначение недоступно.');
    target.role = role; target.active = true; target.updatedAt = moscow(this.now()).stamp;
    this.store.putUser(target);
    await this.send(actor.id, `Назначено: ${fullName(target)} — ${role}.`);
    await this.send(target.id, SALES_ROLES.has(role)
      ? `Вам назначили должность: ${role}. Теперь можно заполнять отчёт и свои показатели по личному сегменту.`
      : `Вам назначили должность: ${role}. Теперь можно заполнять отчёт.`);
  }
  async reminder() {
    const now = moscow(this.now()); if (now.time < '18:30' || !this.config.reminderDays.has(weekday(now.date))) return;
    for (const user of this.store.allUsers()) {
      if (!this.active(user) || this.store.data.reminders[key(now.date, user.id)]) continue;
      const report = this.store.report(user.id, now.date); if (report?.status === 'Сдан') continue;
      this.store.data.reminders[key(now.date, user.id)] = true; this.store.save();
      await this.send(user.id, `🌙 Пора заполнить вечерний отчёт за ${shortDate(now.date)}. Нажмите «🌙 Вечерний отчёт».`).catch(() => {});
    }
  }
  async update(update) {
    if (update.callback_query) return this.callback(update.callback_query);
    if (update.message) return this.handleText(update.message);
  }
}

async function run(app, signal, log = console.log) {
  const hook = await app.telegram.call('getWebhookInfo'); if (hook.url) throw new Error('WEBHOOK_ALREADY_SET');
  let offset = Number(app.store.data.offset || 0), failures = 0, nextReminder = 0;
  log('READY: server storage connected; long polling started.');
  while (!signal.aborted) {
    try {
      if (Date.now() >= nextReminder) { await app.reminder(); nextReminder = Date.now() + 30000; }
      const updates = await app.telegram.call('getUpdates', {offset, limit: 20, timeout: 25, allowed_updates: ['message', 'callback_query']}, signal);
      for (const update of updates) { await app.update(update); offset = update.update_id + 1; app.store.data.offset = offset; app.store.save(); }
      failures = 0;
    } catch (error) {
      if (signal.aborted) break; if (error.message === 'TELEGRAM_409') throw error;
      failures++; const wait = Math.max(error.wait || 0, Math.min(30, 2 ** Math.min(5, failures))); log(`${error.message}; retry in ${wait}s`);
      try { await sleep(wait * 1000, undefined, {signal}); } catch (_) { break; }
    }
  }
}
if (require.main === module) {
  const options = config(), store = new Store(options.dbFile), telegram = new Telegram(options.token), app = new DailyReportsBot({store, telegram, config: options});
  const controller = new AbortController(); process.on('SIGINT', () => controller.abort()); process.on('SIGTERM', () => controller.abort());
  run(app, controller.signal).catch(error => { console.error(`STOP: ${error.message}`); process.exitCode = 1; });
}
module.exports = {ROLES, Store, Telegram, DailyReportsBot, config, moscow, freshReport, canAssign, canSee, parseMetrics, nameParts};
