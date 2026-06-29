import type {
  UiApi,
  HeaderButtonOptions, HeaderButtonHandle,
  AttachedPopupOptions, AttachedPopupHandle,
  OpenWindowOptions, OpenWindowHandle,
  OpenExternalWindowOptions, OpenExternalWindowHandle,
} from '../api/api-types';

const USER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function prefixId(pluginId: string, userId: string): string {
  if (!USER_ID_RE.test(userId)) {
    throw new Error(`ui: invalid id '${userId}' (must match /^[a-zA-Z0-9_-]{1,64}$/)`);
  }
  return `${pluginId}__${userId}`;
}

/**
 * Wraps the global UiApi with auto-prefixing of user-provided `id` fields.
 * Caller passes id='sb_topup'; effective DOM/CDP id becomes
 * '<pluginId>__sb_topup' (double underscore separator per H4 fix).
 */
export function createPluginUi(realUi: UiApi, pluginId: string): UiApi {
  return Object.freeze({
    addHeaderButton(opts: HeaderButtonOptions): HeaderButtonHandle {
      return realUi.addHeaderButton({ ...opts, id: prefixId(pluginId, opts.id) });
    },
    async attachPopup(opts: AttachedPopupOptions): Promise<AttachedPopupHandle> {
      return await realUi.attachPopup({ ...opts, id: prefixId(pluginId, opts.id) });
    },
    async openWindow(opts: OpenWindowOptions): Promise<OpenWindowHandle> {
      return await realUi.openWindow({ ...opts, id: prefixId(pluginId, opts.id) });
    },
    async openExternalWindow(
      opts: OpenExternalWindowOptions,
    ): Promise<OpenExternalWindowHandle> {
      return await realUi.openExternalWindow({ ...opts, id: prefixId(pluginId, opts.id) });
    },
  });
}
