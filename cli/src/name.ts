export const APP_NAME = "secrets";
export const PROJECT_FILE = ".secrets.json";
export const ROLE = "owner";
export const DEFAULT_ENV = "dev";

// Set at release build time: bun build --define 'SECRETS_VERSION="v1.2.3"'.
declare const SECRETS_VERSION: string | undefined;
export const VERSION: string = typeof SECRETS_VERSION === "string" ? SECRETS_VERSION : "dev";
