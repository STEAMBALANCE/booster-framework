import { test, expect } from 'bun:test';
import { acceptFrameMessage, composeWrapperHtml, handleWrapperBcMessage } from '../src/relay/window-wrapper';
import { RELAY_CHANNEL } from '../src/relay/protocol';

// Minimal fake document for testing handleWrapperBcMessage in isolation —
// no JSDOM/happy-dom needed. Two elements (#booster-win-title, #booster-win-frame)
// matching the wrapper's hardcoded ids; getElementById returns null for
// anything else. `_title` / `_frame` / `_posted` exposed for assertions.
function fakeDoc() {
  const titleEl = { textContent: '' };
  const posted: Array<{ data: unknown; origin: string }> = [];
  const frameEl = { src: '', contentWindow: { postMessage: (data: unknown, origin: string) => { posted.push({ data, origin }); } } };
  const map = new Map<string, unknown>([
    ['booster-win-title', titleEl],
    ['booster-win-frame', frameEl],
  ]);
  return {
    title: '',
    getElementById: (id: string) => map.get(id) ?? null,
    _title: titleEl,
    _frame: frameEl,
    _posted: posted,
  };
}

test('acceptFrameMessage: source must equal frameWindow and origin in allowlist', () => {
  const frame = {};
  expect(acceptFrameMessage(frame, 'https://steambalance.cc', frame, ['https://steambalance.cc'])).toBe(true);
  expect(acceptFrameMessage({}, 'https://steambalance.cc', frame, ['https://steambalance.cc'])).toBe(false); // wrong source
  expect(acceptFrameMessage(frame, 'https://evil.com', frame, ['https://steambalance.cc'])).toBe(false);   // origin not allowed
  expect(acceptFrameMessage(null, 'https://steambalance.cc', frame, ['https://steambalance.cc'])).toBe(false);
  expect(acceptFrameMessage(frame, 'https://b.cc', frame, ['https://a.cc', 'https://b.cc'])).toBe(true);   // multi-origin
});

test('escapes title text content', () => {
  const html = composeWrapperHtml({
    windowId:'x', title:'<script>alert(1)</script>',
    content:{kind:'url', url:'https://a.b'}
  });
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapes url attribute', () => {
  const html = composeWrapperHtml({
    windowId:'x', title:'t',
    content:{kind:'url', url:'https://example.com/?a="b"'}
  });
  expect(html).toContain('&quot;');
  expect(html).not.toMatch(/src="[^"]*"b"/);
});

test('url-mode iframe.src', () => {
  const html = composeWrapperHtml({
    windowId:'x', title:'t', content:{kind:'url', url:'https://jivo.chat/abc'}
  });
  expect(html).toMatch(/<iframe[^>]*src="https:\/\/jivo\.chat\/abc"/);
  expect(html).not.toContain('srcdoc=');
});

test('html-mode iframe.srcdoc', () => {
  const html = composeWrapperHtml({
    windowId:'x', title:'t', content:{kind:'html', html:'<p>hello</p>'}
  });
  expect(html).toMatch(/<iframe[^>]*srcdoc="[^"]*&lt;p&gt;hello&lt;\/p&gt;[^"]*"/);
  expect(html).not.toMatch(/<iframe[^>]*src="/);
});

test('id interpolated via JSON.stringify (script-safe)', () => {
  const html = composeWrapperHtml({
    windowId:'x"; alert(1); x"', title:'t',
    content:{kind:'url', url:'https://a.b'}
  });
  expect(html).not.toMatch(/POPUP_ID = "x";\s*alert/);
  expect(html).toContain('"x\\"; alert(1); x\\""');
});

test('draggable title-bar via -webkit-app-region', () => {
  const html = composeWrapperHtml({windowId:'x', title:'t', content:{kind:'url', url:'https://a.b'}});
  expect(html).toContain('-webkit-app-region:drag');
  expect(html).toContain('-webkit-app-region:no-drag');
});

test('close button id booster-win-close + aria-label "Закрыть"', () => {
  const html = composeWrapperHtml({windowId:'x', title:'t', content:{kind:'url', url:'https://a.b'}});
  expect(html).toMatch(/<button[^>]*id="booster-win-close"/);
  expect(html).toMatch(/<button[^>]*aria-label="Закрыть"/);
});

test('windowId leak proof — only inside JSON.stringify\'d POPUP_ID', () => {
  const html = composeWrapperHtml({
    windowId:'<x>', title:'t', content:{kind:'url', url:'https://a.b'}
  });
  // <x> should never appear "raw" — only inside the JSON literal `"<x>"`.
  // Assert any <x> occurrence is immediately preceded by a `"` (quote).
  expect(html.match(/[^"]<x>/g)).toBeNull();
  expect(html).toContain('"<x>"');
});

test('srcdoc preserves caller HTML literal entities', () => {
  const html = composeWrapperHtml({
    windowId:'x', title:'t',
    content:{kind:'html', html:'<p>A & B</p>'}
  });
  expect(html).toContain('srcdoc=');
  expect(html).toMatch(/srcdoc="[^"]*&amp;[^"]*"/);
  expect(html).not.toContain('&amp;amp;');
});

test('unload + pagehide BC cleanup listeners', () => {
  const html = composeWrapperHtml({windowId:'x', title:'t', content:{kind:'url', url:'https://a.b'}});
  expect(html).toContain("addEventListener('unload'");
  expect(html).toContain("addEventListener('pagehide'");
  expect(html).toContain('sbBC.close()');
});

test('iframe allow clipboard-read clipboard-write', () => {
  const html = composeWrapperHtml({windowId:'x', title:'t', content:{kind:'url', url:'https://a.b'}});
  expect(html).toMatch(/allow="[^"]*clipboard-read[^"]*clipboard-write/);
});

test('iframe background defaults to #fff', () => {
  const html = composeWrapperHtml({windowId:'x', title:'t', content:{kind:'url', url:'https://a.b'}});
  expect(html).toMatch(/iframe\.frame\{[^}]*background:#fff/);
});

test('iframe background honours iframeBackground override', () => {
  const html = composeWrapperHtml({
    windowId:'x', title:'t', content:{kind:'url', url:'https://a.b'},
    iframeBackground:'#1b1d23',
  });
  expect(html).toMatch(/iframe\.frame\{[^}]*background:#1b1d23/);
  expect(html).not.toMatch(/iframe\.frame\{[^}]*background:#fff/);
});

// M-4 regression: wrapper script must use RELAY_CHANNEL constant so a
// future rename of the channel propagates automatically without a silent
// stale hardcoded literal.
test('composeWrapperHtml uses RELAY_CHANNEL constant for BC name', () => {
  const html = composeWrapperHtml({windowId:'x', title:'t', content:{kind:'url', url:'https://a.b'}});
  expect(html).toContain(`BroadcastChannel(${JSON.stringify(RELAY_CHANNEL)})`);
});

test('wrapper BC handler source survives .toString() inlining', () => {
  const html = composeWrapperHtml({
    windowId: 'b1', title: 't',
    content: { kind: 'url', url: 'https://x.example/' },
  });
  // Pre-refactor inline handler had these literal patterns; the
  // .toString()'d function MUST still contain equivalent code.
  expect(html).toContain('window-set-title');
  expect(html).toContain('booster-win-title');
  expect(html).toMatch(/doc\.title\s*=/);
  expect(html).toMatch(/sbBC\.addEventListener\(['"]message['"]/);
});

test('handleWrapperBcMessage: window-set-title updates DOM + document.title', () => {
  const doc = fakeDoc();
  handleWrapperBcMessage(
    { kind: 'window-set-title', windowId: 'x', title: 'Новый заголовок' },
    doc as unknown as Document,
    'x', '',
  );
  expect(doc._title.textContent).toBe('Новый заголовок');
  expect(doc.title).toBe('Новый заголовок');
});

test('handleWrapperBcMessage: ignores message for different windowId', () => {
  const doc = fakeDoc();
  doc._title.textContent = 'untouched';
  doc.title = 'untouched';
  handleWrapperBcMessage(
    { kind: 'window-set-title', windowId: 'other', title: 'X' },
    doc as unknown as Document,
    'x', '',
  );
  expect(doc._title.textContent).toBe('untouched');
  expect(doc.title).toBe('untouched');
});

test('handleWrapperBcMessage: ignores non-object messages', () => {
  const doc = fakeDoc();
  for (const m of [null, undefined, 'string', 42, true]) {
    handleWrapperBcMessage(m as unknown, doc as unknown as Document, 'x', '');
  }
  expect(doc.title).toBe('');
});

test('handleWrapperBcMessage forwards window-postMessage to iframe with frameOrigin', () => {
  const doc = fakeDoc();
  handleWrapperBcMessage(
    { kind: 'window-postMessage', windowId: 'w1', data: { hello: 1 } },
    doc as unknown as Document, 'w1', 'https://steambalance.cc',
  );
  expect(doc._posted).toEqual([{ data: { hello: 1 }, origin: 'https://steambalance.cc' }]);
});

test('handleWrapperBcMessage ignores window-postMessage when frameOrigin empty (html-mode)', () => {
  const doc = fakeDoc();
  handleWrapperBcMessage(
    { kind: 'window-postMessage', windowId: 'w1', data: { x: 1 } },
    doc as unknown as Document, 'w1', '',
  );
  expect(doc._posted).toEqual([]);
});

test('handleWrapperBcMessage ignores window-postMessage for other windowId', () => {
  const doc = fakeDoc();
  handleWrapperBcMessage(
    { kind: 'window-postMessage', windowId: 'OTHER', data: { x: 1 } },
    doc as unknown as Document, 'w1', 'https://steambalance.cc',
  );
  expect(doc._posted).toEqual([]);
});

test('composeWrapperHtml inlines handleWrapperBcMessage source via .toString()', () => {
  const html = composeWrapperHtml({
    windowId: 'smoke', title: 't',
    content: { kind: 'url', url: 'https://x.example/' },
  });
  // Sanity: function source is present (its name + its branch).
  expect(html).toContain('window-set-title');
  // Pin the inlining mechanism itself: the named function and the
  // assignment site. If someone refactors to an anonymous arrow, the
  // emitted popup script loses the named-function stack-trace benefit
  // — these assertions catch that silent drift.
  expect(html).toContain('handleWrapperBcMessage');
  expect(html).toContain('const handleBc =');
  // Smoke: BC handler is wired (handler called from addEventListener).
  expect(html).toMatch(/sbBC\.addEventListener\(['"]message['"]/);
});

test('composeWrapperHtml embeds FRAME_ORIGIN derived from url', () => {
  const html = composeWrapperHtml({ windowId: 'x', title: 't', content: { kind: 'url', url: 'https://steambalance.cc/booster/orders?a=1' } });
  expect(html).toContain('const FRAME_ORIGIN = "https://steambalance.cc"');
});

test('composeWrapperHtml FRAME_ORIGIN empty for html-mode', () => {
  const html = composeWrapperHtml({ windowId: 'x', title: 't', content: { kind: 'html', html: '<p>x</p>' } });
  expect(html).toContain('const FRAME_ORIGIN = ""');
});

test('composeWrapperHtml EMBED_ORIGINS = unique [frame, ...embedOrigins]', () => {
  const html = composeWrapperHtml({
    windowId: 'x', title: 't',
    content: { kind: 'url', url: 'https://steambalance.cc/booster/orders' },
    embedOrigins: ['https://pay.steambalance.cc', 'https://steambalance.cc'],
  });
  expect(html).toContain('const EMBED_ORIGINS = ["https://steambalance.cc","https://pay.steambalance.cc"]');
});

test('composeWrapperHtml wires iframe load -> sb:embed and message listener', () => {
  const html = composeWrapperHtml({ windowId: 'x', title: 't', content: { kind: 'url', url: 'https://a.b' } });
  expect(html).toContain("addEventListener('load'");
  expect(html).toContain("type:'sb:embed'");
  expect(html).toContain("addEventListener('message'");
  expect(html).toContain("'sb:ready'");
});

test('composeWrapperHtml passes FRAME_ORIGIN to handleBc call (4 args)', () => {
  const html = composeWrapperHtml({ windowId: 'x', title: 't', content: { kind: 'url', url: 'https://a.b' } });
  expect(html).toContain('handleBc(e.data, document, POPUP_ID, FRAME_ORIGIN)');
});

test('composeWrapperHtml removes message listener in cleanup', () => {
  const html = composeWrapperHtml({ windowId: 'x', title: 't', content: { kind: 'url', url: 'https://a.b' } });
  expect(html).toContain("removeEventListener('message'");
});

test('acceptFrameMessage source survives .toString() inlining', () => {
  const html = composeWrapperHtml({ windowId: 'x', title: 't', content: { kind: 'url', url: 'https://a.b' } });
  // the inlined function body returns the source-equality + indexOf guard
  expect(html).toContain('indexOf(');
});

test('wrapper postMessage never uses wildcard targetOrigin', () => {
  const html = composeWrapperHtml({ windowId: 'x', title: 't', content: { kind: 'url', url: 'https://a.b' } });
  expect(html).toContain('w.postMessage(buildEmbed(), FRAME_ORIGIN);'); // load-push
  expect(html).toContain('e.source.postMessage(buildEmbed(), e.origin);'); // sb:ready reply
  expect(html).not.toContain("buildEmbed(), '*'");
});
