import type { ActivateOutcome, ActivateErrorCode } from '../api/api-types';
import type { RegisterCDKeyResponse } from './register-cdkey-codec';
import { PurchaseResultDetail as PRD } from '../api/api-types';
import { LL } from '../i18n';

const EPRD_TO_CODE: Record<number, ActivateErrorCode> = {
  [PRD.AlreadyPurchased]:           'already_owned',
  [PRD.RestrictedCountry]:          'region_locked',
  [PRD.BadActivationCode]:          'invalid_key',
  [PRD.DuplicateActivationCode]:    'already_activated',
  [PRD.DoesNotOwnRequiredApp]:      'requires_base_game',
  [PRD.AccountLocked]:              'account_locked',
  [PRD.CannotRedeemCodeFromClient]: 'cannot_redeem_from_client',
  [PRD.RateLimited]:                'rate_limited',
};

const MESSAGES: Record<ActivateErrorCode, () => string> = {
  already_activated:         LL.framework.keys.error.already_activated,
  already_owned:             LL.framework.keys.error.already_owned,
  invalid_key:               LL.framework.keys.error.invalid_key,
  region_locked:             LL.framework.keys.error.region_locked,
  requires_base_game:        LL.framework.keys.error.requires_base_game,
  rate_limited:              LL.framework.keys.error.rate_limited,
  cannot_redeem_from_client: LL.framework.keys.error.cannot_redeem_from_client,
  account_locked:            LL.framework.keys.error.account_locked,
  unavailable:               LL.framework.keys.error.unavailable,
};

export function mapResult(r: RegisterCDKeyResponse): ActivateOutcome {
  if (r.eresult === 1 && r.purchaseResultDetails === 0) {
    return {
      ok: true,
      // appId is decoded but not surfaced (spec §2: observed 0, not part of the public API).
      products: r.lineItems.map((li) => ({ packageId: li.packageId, name: li.description })),
      transactionId: r.transactionId,
    };
  }
  const prd = r.purchaseResultDetails;
  const code: ActivateErrorCode = (prd !== 0 && EPRD_TO_CODE[prd]) ? EPRD_TO_CODE[prd] : 'unavailable';
  return { ok: false, code, resultDetail: prd, message: MESSAGES[code]() };
}
