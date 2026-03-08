# lib/auth/ — Authentication (NextAuth v5)

## Edge-Safe Config Split

**This is the most important pattern.** NextAuth runs in two contexts:

- **Route handler** (full Node.js) — can import DB, do async operations
- **Middleware** (Edge Runtime) — no filesystem, no native modules, no DB

Two config files enforce this boundary:

| File | Safe for Edge? | Contains | Imported by |
|------|---------------|----------|-------------|
| `edge-config.js` | Yes | JWT strategy, callbacks, pages config | `middleware.js` |
| `config.js` | No | Credentials provider, DB imports | Route handler only |

**Never import `config.js` from middleware.** Always import `edge-config.js` there. Importing the wrong one will break edge middleware with "module not found" errors for DB/native dependencies.

## Stale Cookie Cleanup (middleware.js)

When `AUTH_SECRET` rotates or the container restarts, old session JWTs can't be decrypted. Auth.js clears these in route handlers via `sessionStore.clean()`, but **not in middleware** — causing infinite redirect loops. The middleware manually deletes session-token cookies (including chunked variants like `authjs.session-token.0`, `authjs.session-token.1`) while leaving `csrf-token` and `callback-url` intact.

## setupAdmin() — Atomic First-User Creation

`setupAdmin()` server action → `createFirstUser()` in `lib/db/users.js`. The DB call wraps count-check + insert in a single SQLite transaction (SERIALIZABLE isolation), preventing race conditions where two requests both see zero users. Returns `null` if a user already exists.

**No implicit login**: After setup, the user is redirected to `/login?created=1` and must authenticate normally. This ensures proper JWT session establishment.

## getPageAuthState()

Combines `auth()` + `getUserCount()` in a single `Promise.all()` call. Returns `{ session, needsSetup }`. The login page uses `needsSetup` to show either `<SetupForm>` or `<LoginForm>`.

Uses lazy `await import('../db/users.js')` to avoid pulling DB at module level — prevents failures if called before `initDatabase()`.

## Components

- `login-form.jsx` — Client component, calls `signIn('credentials')`, shows success message if `?created=1`
- `setup-form.jsx` — Client component, calls `setupAdmin()` server action, validates password length (min 8)
- `ascii-logo.jsx` — Static branding
- `ui/` — Primitives (button, input, label, card) used by the forms
