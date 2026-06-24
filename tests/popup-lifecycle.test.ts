// framework/tests/popup-lifecycle.test.ts
import { test, expect, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { commonPopupSetup, removeTrackedZombies, destroyPopup } from '../src/relay/popup-lifecycle';

function makeFakePopup(opts: { hasMPopup?: boolean; throwOnWrite?: boolean } = {}) {
  const realize = { ShowWindow: mock(() => {}), HideWindow: mock(() => {}), SetHideOnClose: mock(() => {}) };
  const popupWin = opts.hasMPopup === false ? null : {
    SteamClient: { Window: realize },
    document: {
      open: mock(() => {}),
      write: mock(() => { if (opts.throwOnWrite) throw new Error('write blocked'); }),
      close: mock(() => {}),
    },
  };
  return { popup: { m_popup: popupWin } as any, popupWin, realize };
}

test('commonPopupSetup html-content writes via document.open/write/close', () => {
  const { popup, popupWin } = makeFakePopup();
  globalThis.window = new Window() as any;
  const result = commonPopupSetup({
    popup, popupId: 'test',
    content: { kind: 'html', html: '<h1>hi</h1>' },
    hideOnClose: true,
  });
  expect(result).toBe(popupWin);
  expect(popupWin!.document.open).toHaveBeenCalled();
  expect(popupWin!.document.write).toHaveBeenCalledWith('<h1>hi</h1>');
  expect(popupWin!.document.close).toHaveBeenCalled();
});

test('commonPopupSetup url-content does NOT call document.write', () => {
  const { popup, popupWin } = makeFakePopup();
  globalThis.window = new Window() as any;
  const result = commonPopupSetup({
    popup, popupId: 'test',
    content: { kind: 'url' },
    hideOnClose: false,
  });
  expect(result).toBe(popupWin);
  expect(popupWin!.document.write).not.toHaveBeenCalled();
});

test('commonPopupSetup CEF realize warmup — ShowWindow + HideWindow called', () => {
  const { popup, realize } = makeFakePopup();
  globalThis.window = new Window() as any;
  commonPopupSetup({ popup, popupId: 'test', content: { kind: 'url' }, hideOnClose: false });
  expect(realize.ShowWindow).toHaveBeenCalled();
  expect(realize.HideWindow).toHaveBeenCalled();
});

test('commonPopupSetup hideOnClose=true → SetHideOnClose(true) called', () => {
  const { popup, realize } = makeFakePopup();
  globalThis.window = new Window() as any;
  commonPopupSetup({ popup, popupId: 'test', content: { kind: 'url' }, hideOnClose: true });
  expect(realize.SetHideOnClose).toHaveBeenCalledWith(true);
});

test('commonPopupSetup popup.m_popup unset → returns null', () => {
  const { popup } = makeFakePopup({ hasMPopup: false });
  globalThis.window = new Window() as any;
  expect(commonPopupSetup({ popup, popupId: 'test', content: { kind: 'url' }, hideOnClose: false })).toBeNull();
});

test('commonPopupSetup document.write throws → returns null', () => {
  const { popup } = makeFakePopup({ throwOnWrite: true });
  globalThis.window = new Window() as any;
  expect(commonPopupSetup({ popup, popupId: 'test', content: { kind: 'html', html: '<x>' }, hideOnClose: false })).toBeNull();
});
