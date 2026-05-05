/**
 * Public API surface for the mobile API client. Screens import from
 * `../api` (or relative equivalent) and never reach into `client.ts` /
 * `types.ts` directly — the barrel keeps the import graph stable as the
 * client grows.
 */

export {
  createApiClient,
  DEFAULT_TIMEOUT_MS,
  type ApiClient,
  type ApiClientConfig,
  type RequestOptions,
} from './client';

export {
  API_ERROR_KINDS,
  type ApiErrorKind,
  type ApiResult,
  type ConsultRequest,
  type ConsultResponse,
  type DiagnoseRequest,
  type DiagnoseResponse,
  type IdentifyRequest,
  type IdentifyResponse,
  type ImageInput,
  type ReviewRequest,
  type ReviewResponse,
} from './types';
