import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';
import { SearchError } from './errors.mjs';

export function publicIp(address) {
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}
export function publicUrl(input) {
  let url;
  try { if (typeof input !== 'string' || input.length > 2048) throw Error(); url = new URL(input); } catch { throw new SearchError('url'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') && !host.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
      (ipaddr.isValid(host) && !publicIp(host))) throw new SearchError('url');
  url.hash = '';
  return url;
}

// Pin the checked address at connection time; a second DNS lookup must not
// turn a public link into an internal request. Revalidate every redirect.
export async function resolvePublic(url, resolver = lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }]
    : await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(x => !publicIp(x.address))) throw new SearchError('url');
  return addresses;
}

function requestPage(url, addresses, signal) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal, agent: false,
      lookup: (_host, opts, cb) => opts.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family),
      headers: { 'User-Agent': 'Aurabot-SmartSearch/1.0', Accept: 'text/html,text/plain;q=0.9', 'Accept-Encoding': 'identity' },
    }, resolve);
    request.once('error', reject); request.end();
  });
}

export async function readPublicPage(input, signal, { resolver = lookup, transport = requestPage } = {}) {
  let url = publicUrl(input);
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    const addresses = await resolvePublic(url, resolver);
    signal.throwIfAborted();
    const response = await transport(url, addresses, signal);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (!response.headers.location || hop === 4) throw new SearchError('page');
      url = publicUrl(new URL(response.headers.location, url).href);
      continue;
    }
    const type = String(response.headers['content-type'] || '');
    if (response.statusCode < 200 || response.statusCode >= 300 || !/^(?:text\/|application\/xhtml\+xml)/i.test(type) ||
        response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.destroy(); throw new SearchError('page');
    }
    if (Number(response.headers['content-length']) > 2 * 1024 * 1024) { response.destroy(); throw new SearchError('size'); }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new SearchError('size');
        chunks.push(chunk);
      }
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] || 'utf-8';
      let content;
      try { content = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { throw new SearchError('page'); }
      return { url: url.href, content, html: /html/i.test(type) };
    } finally { response.destroy(); }
  }
}
