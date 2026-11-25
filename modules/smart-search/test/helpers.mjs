import definition from '../index.mjs';
import { DEFAULTS } from '../lib/options.mjs';
export function harness(patch = {}, web = { search: async () => ({ sources: [{ title: 'Example', url: 'https://example.com/', snippet: 'A source' }] }) }) {
  let settings = { ...DEFAULTS, ...patch }, allOwner = true;
  const routes = {}, events = {}, rules = [], builders = [], disposers = [], secrets = [], logs = [];
  const api = {
    settings: () => settings, lib: () => ({ registerSecretField: path => secrets.push(path) }),
    onDispose: fn => disposers.push(fn), on: (name, fn) => { events[name] = fn; },
    rule: fn => rules.push(fn), tool: fn => builders.push(fn),
    defineTool: value => value, route: (name, fn) => { routes[name] = fn; },
    isOwner: id => id === 'owner', core: { hub: { turnSendersAllOwner: () => allOwner }, http: { body: async req => req.body } },
    dsh: { get: name => name === 'web' ? web : undefined }, log: { warn: (...x) => logs.push(x) },
  };
  return { api, routes, rules, events, secrets, logs, builders,
    load: () => definition.setup(api),
    set: patch => { const prev = settings; settings = { ...settings, ...patch }; events.config?.({ ext: { 'smart-search': settings } }, { ext: { 'smart-search': prev } }); },
    owner: value => { allOwner = value; }, dispose: () => disposers.forEach(f => f()),
    tools: (kind = 'group', id = 'owner', level = 'social') => builders.flatMap(fn => fn({ chat: { kind, userId: id, groupId: '12345', chatId: kind + ':12345' }, level, sessionId: 'session' })),
  };
}
export function req(method = 'GET', body) {
  return { method, body, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:12345', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } };
}
export const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
