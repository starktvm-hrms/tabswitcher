# Deploying to seminar.starkpeople.in

The app is a static build (`npm run build` → `dist/`). It is served by nginx on the Hostinger VPS (KVM 2, `76.13.241.150`), next to the other starkpeople.in sites. No secrets are stored anywhere.

```
push to main ──► Actions "Build and publish": npm ci → test → build → push dist/ to the deploy-build branch
                                                                          │
VPS: seminar-sync.timer (every minute) ── git fetch deploy-build (public, read-only) ──► /var/www/seminar.starkpeople.in ──► nginx ──► https://seminar.starkpeople.in
```

- **Poll server:** `server/poll-server.mjs` runs as the `seminar-poll` systemd service on `127.0.0.1` (port in `/opt/seminar.starkpeople.in/poll-port`, normally 8791). nginx routes `/api/` to it with buffering off for the live stream. Poll data is stored as JSON in `/opt/seminar.starkpeople.in/data`. Each build ships the server code in `.server/` on the deploy-build branch. The sync job installs it outside the web root and restarts the service when it changes.
- **DNS:** an `A` record `seminar` → `76.13.241.150` in the starkpeople.in zone (Hostinger DNS).
- **Deploys:** every push to `main` goes live within about a minute. The "Build and publish" run waits until the site serves the new build. The build's commit is at `/version.txt`.
- **Rollback:** revert the commit on `main` and push. Or, in Actions, re-run "Build and publish" for an older commit.

## One-time server setup

Run the **Set up server** workflow (Actions → Set up server → Run workflow). It:
1. creates a throwaway SSH key on the GitHub runner and prints its public half (`SETUP_PUBLIC_KEY: …`);
2. waits until that key is added to the VPS root user (Hostinger API `vps_ssh-keys_add-virtual-machine`, or hPanel → VPS → SSH keys);
3. runs [`setup-server.sh`](setup-server.sh) on the VPS;
4. removes the key from the server again. The private key never leaves the runner.

`setup-server.sh` installs nginx, git, rsync, certbot and Node.js if missing, then:
- adds **one** nginx site file and an `/api/` snippet, and checks the whole config with `nginx -t` before reloading; if the check fails, it restores its own files;
- gets an HTTPS certificate;
- installs the `seminar-sync` timer and the `seminar-poll` service, both running as an unprivileged system user.

It is safe to run again, and you can also run it by hand as root in hPanel → VPS → Browser terminal.

## Troubleshooting (on the VPS)

```bash
systemctl status seminar-sync.timer      # is the sync running?
systemctl status seminar-poll            # is the poll server running?
journalctl -u seminar-poll -n 50         # poll server log
curl -s https://seminar.starkpeople.in/api/health
journalctl -u seminar-sync -n 50         # what did the last syncs do?
sudo -u seminar-sync seminar-sync        # sync right now
nginx -T | grep -n seminar               # is the nginx site loaded?
```
