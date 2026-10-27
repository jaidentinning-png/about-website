# Cartel Empire: Dominion staff portal

A private portal for game staff and developers. It includes a kanban work board, task assignments and due dates, a shared draggable canvas, staff to-do lists with Markdown import, staff accounts and roles, team documents, Robux payroll tracking, task-completion reward automations, and optional Discord notifications.

The repository supports two deployment modes:

- **Vercel + Neon Postgres** for the shared team website. Vercel Functions serve the API and Neon stores shared, persistent data.
- **Node.js + SQLite** for local development or self-hosting on a server with persistent storage.

There is no public registration or public homepage. Staff accounts must be created by an authorized administrator.

## Requirements

- Node.js 22.13 or newer (Node 24 LTS recommended).
- HTTPS in production.

## Local development and self-hosting

1. Copy `.env.example` to `.env`.
2. Set `BOOTSTRAP_OWNER_USERNAME` and a unique `BOOTSTRAP_OWNER_PASSWORD` with at least 12 characters.
3. Run `npm start`.
4. Open `http://localhost:3000` and sign in using the bootstrap Owner account.

The local server creates `data/portal.sqlite`. Keep `data/` private and backed up. For self-hosting, use a persistent disk; the included Dockerfile and Compose configuration can be used on a server with persistent storage. The Compose file binds the app to `127.0.0.1`; put it behind an HTTPS reverse proxy before sharing the URL.

## Deploy the shared site with Vercel + Neon

The Vercel API uses Neon Postgres and initializes the required tables and initial Owner account on first request. Explicit Vercel function routes cover nested API paths such as task edits and bulk to-do imports. No separate API host is required.

1. Import this repository into Vercel and deploy it using the default Node.js project settings.
2. In Vercel, add the **Neon** integration from the Vercel Marketplace and connect a Neon project/database to this Vercel project. Make sure a Postgres connection string is available as `DATABASE_URL` (the API also accepts `POSTGRES_URL`).
3. In the Vercel project's Environment Variables, set:
   - `BOOTSTRAP_OWNER_USERNAME` — 3-24 letters, numbers, dots, underscores, or hyphens.
   - `BOOTSTRAP_OWNER_PASSWORD` — a unique password with at least 12 characters.
   - `TRUSTED_ORIGIN` — the exact public origin, for example `https://jaitinn.site`.
   - Optionally, `DISCORD_WEBHOOK_URL` for task-completion notifications.
4. Apply these variables to Production and any Preview environments where you will sign in. Keep database and bootstrap credentials private; never add them to frontend code or commit them.
5. Redeploy after connecting the database and adding environment variables.
6. Open the production site and sign in using the bootstrap Owner credentials. After verifying the account works, remove `BOOTSTRAP_OWNER_PASSWORD` from Vercel. The Owner account remains in Neon; the bootstrap credential is only used when the database has no users.

If sign-in returns an API configuration error, check the Vercel Function logs and confirm that `DATABASE_URL` (or `POSTGRES_URL`) is available to the deployment. The API does not proxy to another host. The portal's database is not stored on Vercel's temporary filesystem.

Vercel + Neon uses a separate database from any local `data/portal.sqlite` file. Local SQLite records are not automatically copied to Neon.

### Recover a forgotten Vercel Owner password

The bootstrap password is only used when creating the first Owner; changing that environment variable does not reset an existing account. To reset the Owner password without deleting portal data:

1. In a terminal at the repository root, run `node scripts/reset-owner-password.js`. Enter and confirm a new password when prompted; input is hidden.
2. Copy the generated SQL into the connected Neon project's SQL Editor and run it.
3. Sign in using the existing Owner username and the new password.

The SQL updates Owner password hashes, invalidates their sessions, and clears login lockout counters. It does not delete tasks, staff, payroll, documents, or to-do items. Treat the generated SQL as sensitive until it has been run.

## Roles and workflow

- **Owner** is the site superadmin and can manage all roles, accounts, tasks, payroll, and automations.
- **HR** is the highest staff rank and can create/reset staff accounts, manage tasks and canvas cards, and manage Robux payroll and automations.
- Documents are visible to all active staff; the Owner and HR can post, edit, and delete them. The Owner can grant document-management permission to other roles.
- HR/Owner can post, edit, and delete shared to-do items. They can add items one at a time or paste a Markdown list; headings automatically become sections and bullets become separate items. All staff can change each item's status to Not done, In progress, or Done.
- Other roles can be granted permissions by the Owner. Staff can create tasks for themselves and update tasks assigned to them or created by them.
- HR/Owner issue accounts; each staff member chooses a private password on first login. Temporary passwords are generated randomly and displayed once.
- Payroll is an internal tracker only. It records pending, approved, rejected, and marked-paid Robux amounts; it does not transfer Robux.
- Task-completion automations add a pending payroll entry for the assigned staff member. A human with payroll permission must approve it and separately make any actual transfer.

## Security and operations

- Sessions use HTTP-only, same-site cookies; state-changing requests require a session CSRF token and same-site origin validation.
- Passwords are stored as scrypt hashes. Login attempts are rate-limited.
- Keep database and bootstrap credentials private. In Vercel, scope them to only the environments that need them.
- Neon is the persistent shared database for Vercel deployments. Use the database provider's backup and recovery options.
- For SQLite self-hosting, keep the persistent disk private, encrypted where available, and restrict shell/host access. Make backups in a separate private location and periodically test restoring them.
- All staff use the same hosted instance and URL; browser storage is not used for shared records.

## Development

- `npm test` runs the SQLite integration tests and checks the Vercel API's unconfigured and preflight responses.
- `npm run dev` restarts the local SQLite server when source files change.
