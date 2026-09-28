/**
 * Read from package.json at build time by the bundler-free Nest build, which
 * copies it next to dist/. A literal keeps `/health` from needing a filesystem
 * read on every call; bump it with the package version.
 */
export const APP_VERSION = '0.1.1';
