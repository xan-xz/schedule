import js from "@eslint/js";

const names =
  `AbortController AbortSignal Blob BroadcastChannel Buffer CacheStorage caches clearInterval clearTimeout console crypto CustomEvent Date document DOMParser Deno Error Event fetch File FileReader FormData history IDBKeyRange indexedDB Intl localStorage location matchMedia MutationObserver navigator Node Notification performance process queueMicrotask Request Response self sessionStorage setInterval setTimeout structuredClone TextDecoder TextEncoder URL URLSearchParams window atob btoa __dirname`.split(
    " ",
  );

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "test-results/**",
      "playwright-report/**",
      "beta/manage/app.mjs",
      "beta/demo.mjs",
      "beta/core.mjs",
      "beta/conflicts.mjs",
      "backend/core.mjs",
      "backend/admin.mjs",
      "backend/uniflow-api.mjs",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: Object.fromEntries(names.map((name) => [name, "readonly"])),
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
];
