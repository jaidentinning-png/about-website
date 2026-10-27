# Cartel Empire: Dominion staff portal

A private portal for game staff and developers. It includes a kanban work board, task assignments and due dates, a shared draggable canvas, shared staff to-do list, staff accounts and roles, shared team documents, Robux payroll tracking, task-completion reward automations, and optional Discord webhook notifications.

The portal is a Node.js server and stores its data in a SQLite database file. It does not need a managed database or a third-party authentication service. The database must live on persistent storage attached to the server so every team member sees the same data.

## Requirements

- Node.js 22.13 or newer (Node 24 LTS recommended).
- A server or container host that keeps a persistent disk mounted while the app runs.
- HTTPS in production.

Static hosting, including a typical Vercel static deployment, is not suitable for this setup: its serverless filesystem is not a shared, durable database. Keep the SQLite file on the same persistent disk as the running app. Do not put the database in a public/static folder or commit it to Git.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `BOOTSTRAP_OWNER_USERNAME` and a unique `BOOTSTRAP_OWNER_PASSWORD` with at least 12 characters.
3. Run `npm start`.
4. Open `http://localhost:3000` and sign in using the bootstrap Owner account.

The first successful sign-in with an issued staff account requires a password change. There is no public registration or public homepage.

The first run creates `data/portal.sqlite`. Keep `data/` private and backed up. After the Owner account has been created, the bootstrap credentials are not used again. If the Owner account is lost, stop the app, back up the database, and follow your hosting provider's secure recovery process rather than exposing the database or adding a public reset route.

## Deploy for team access

Use the included Dockerfile or Compose configuration on a host that supports a persistent volume. For the first Compose launch, put your bootstrap credentials in the private `.env` file and run `docker compose up --build -d`. The Compose file keeps SQLite in a named persistent volume and binds the app to `127.0.0.1`; put it behind an HTTPS reverse proxy before sharing the URL. The app listens on `PORT` (3000 by default) and stores its database under `DATA_DIR` (default `data/`). Bootstrap credentials may be removed from the environment after the Owner account has been created.

For local development, use `npm start` after setting the Owner username and a unique password in `.env`. Do not bind the database directory to a public web path. Keep at least one off-host backup and periodically test restoring it.

To run without Docker, set environment variables directly in your process manager and run `npm start`. The provided `.env` loading is for local development; production secrets should be configured in the hosting platform.

### Optional Discord notifications

Set `DISCORD_WEBHOOK_URL` in the server environment to a Discord webhook URL. The portal sends a short notice when a task is completed. This is optional; task updates still save if Discord is unavailable, and the portal reports the notification failure. Never add a webhook secret to frontend code or commit it.

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

- Sessions use HTTP-only, same-site cookies; state-changing requests require a session CSRF token.
- Passwords are stored as scrypt hashes. Login attempts are rate-limited.
- Use a unique bootstrap password and keep all environment secrets private.
- Keep the persistent disk private, encrypted where available, and restrict shell/host access. Do not share the database file with staff.
- Make database backups on the server and store backups in a separate private location. Stop the app before copying the SQLite database file so its write-ahead log is checkpointed.
- All staff use the same hosted instance and URL; browser storage is not used for shared records.

## Development

- `npm test` runs the backend integration tests against a temporary database.
- `npm run dev` restarts the server when source files change.
