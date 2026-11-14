// Windows' test-file glob discovery on a WSL UNC path is unreliable. Import
// the ordinary node:test modules directly; this runs exactly the same tests.
await import('./module.test.mjs');
await import('./providers.test.mjs');
await import('./public-web.test.mjs');
await import('./search.test.mjs');
await import('./timeouts.test.mjs');
await import('./errors.test.mjs');
