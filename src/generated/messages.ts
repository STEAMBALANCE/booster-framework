// AUTO-GENERATED from strings/ru.json — DO NOT EDIT.
// Contents: framework.* and general.* subsets only.

import type { BaseTranslation } from 'typesafe-i18n';

const ru = {
  framework: {
    keys: {
      error: {
        account_locked: 'Аккаунт заблокирован. Обратитесь в поддержку Steam.',
        already_activated: 'Этот ключ уже активирован.',
        already_owned: 'Эта игра уже есть на вашем аккаунте.',
        cannot_redeem_from_client: 'Этот ключ нельзя активировать здесь.',
        invalid_key: 'Неверный код активации. Проверьте ключ и попробуйте ещё раз.',
        rate_limited: 'Слишком много попыток. Подождите и попробуйте позже.',
        region_locked: 'Этот ключ недоступен в вашем регионе.',
        requires_base_game: 'Для активации нужна основная игра.',
        unavailable: 'Не удалось активировать ключ. Попробуйте позже.',
      },
    },
    window: {
      close_aria_label: 'Закрыть',
    },
  },
  general: {
    product_display_name: 'SteamBooster',
  },
} as const satisfies BaseTranslation;

export default ru;
export type FrameworkTranslation = typeof ru;
