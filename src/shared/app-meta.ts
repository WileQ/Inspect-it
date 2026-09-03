// Application identity used by the renderer (About, settings, privacy copy).
// Version/name are injected at build time from package.json so there is a
// single source of truth. Set APP_REPOSITORY_URL to the real repository URL
// before publishing a release.
const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
const name = typeof __APP_NAME__ !== 'undefined' ? __APP_NAME__ : 'Inspect It';

export const APP_NAME = name;
export const APP_VERSION = version;
export const APP_DESCRIPTION = 'Drop anything. Understand it. A privacy-first, read-only digital-object analyzer.';
export const APP_LICENSE = 'MIT';
// Injected at build time from package.json `repository.url` (see vite.config.js).
export const APP_REPOSITORY_URL = typeof __APP_REPOSITORY_URL__ !== 'undefined' ? __APP_REPOSITORY_URL__ : '';
