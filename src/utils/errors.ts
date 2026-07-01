/**
 * Centralized error type strings.
 *
 * v0.2.2+: extracted from scattered string literals across handler.ts /
 * admin/api.ts / server.ts so error types can be searched, renamed, and
 * audited from one place. Each error response uses one of these values
 * as `error.type` in the JSON body — clients (Claude Code, OpenAI SDK)
 * switch on this to decide retry behavior.
 *
 * Convention:
 *   - _unreachable / _unavailable suffixes indicate transient failures
 *     that may succeed on retry.
 *   - _failed / _invalid suffixes indicate permanent failures for the
 *     current request — the client should NOT retry without changing
 *     the request.
 *   - _exhausted suffix indicates all retries / credentials have been
 *     tried; the client should stop retrying immediately.
 */
export const ErrorType = {
  // Upstream / network
  UPSTREAM_UNREACHABLE: "upstream_unreachable",
  UPSTREAM_TIMEOUT: "upstream_timeout",
  TRANSLATION_FAILED: "translation_failed",
  WAF_BLOCKED: "waf_blocked",
  ALL_CREDENTIALS_EXHAUSTED: "all_credentials_exhausted",

  // Auth
  AUTHENTICATION_ERROR: "authentication_error",
  AUTHENTICATION_REQUIRED: "authentication_required",
  START_PLAN_JWT_INVALID: "start_plan_jwt_invalid",
  CREDENTIAL_UNAVAILABLE: "credential_unavailable",
  RATE_LIMITED: "rate_limited",

  // Captcha
  CAPTCHA_SOLVER_FAILED: "captcha_solver_failed",
  CAPTCHA_CONFIG_UNAVAILABLE: "captcha_config_unavailable",

  // Request validation
  INVALID_JSON: "invalid_json",
  MISSING_PARAM: "missing_param",
  INVALID_PARAM: "invalid_param",
  NOT_FOUND: "not_found",
  NOT_FOUND_ERROR: "not_found_error",
  INVALID_REQUEST: "invalid_request",

  // Store / persistence
  STORE_UNAVAILABLE: "store_unavailable",

  // Admin API
  INVALID_RULE: "invalid_rule",
  INVALID_MAPPING: "invalid_mapping",
  INVALID_MODEL: "invalid_model",
  INVALID_URL: "invalid_url",
  INVALID_CALLBACK: "invalid_callback",
  FLOW_NOT_FOUND: "flow_not_found",
  FLOW_EXPIRED: "flow_expired",
  STATE_MISMATCH: "state_mismatch",
  UNSUPPORTED_PROVIDER: "unsupported_provider",
  MISSING_CALLBACK: "missing_callback",
  NOT_LOGGED_IN: "not_logged_in",
  SAVE_FAILED: "save_failed",
  UPDATE_FAILED: "update_failed",
  IMPORT_FAILED: "import_failed",
  EXPORT_FAILED: "export_failed",
  SWITCH_FAILED: "switch_failed",
  TOGGLE_FAILED: "toggle_failed",
  EDIT_FAILED: "edit_failed",
  TEST_FAILED: "test_failed",
  DETECT_FAILED: "detect_failed",
  OAUTH_INIT_FAILED: "oauth_init_failed",
  OAUTH_CALLBACK_FAILED: "oauth_callback_failed",
  PROXY_POOL_ERROR: "proxy_pool_error",
  RENDER_EXPORT_FAILED: "render_export_failed",
  QUOTA_FAILED: "quota_failed",
} as const;

export type ErrorTypeValue = typeof ErrorType[keyof typeof ErrorType];
