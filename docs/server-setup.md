# Server setup (a Mac running OrbStack)

How to get Homebase running on a Mac used as a home server. Steps marked **(server)** are done at the server's own keyboard or over `ssh homebase-server` (the SSH alias the scripts in `infra/scripts` use). Steps marked **(dev)** are done on your dev machine. Steps marked **(admin console)** are done at login.tailscale.com.

Nothing here opens a port to the internet. These steps make the app reachable over your tailnet, at `https://homebase.<your-tailnet>.ts.net`. The optional `cloudflared` service (an outbound-only Cloudflare Tunnel, token in `CLOUDFLARE_TUNNEL_TOKEN`) can add a public hostname in front of the app's own sign-in and the demo; see docs/decisions.md (2026-10-27, 2026-10-28).

---

## 1. Turn on Remote Login (server)

1. Open System Settings → General → Sharing.
2. Turn on **Remote Login**.
3. Click the (i) next to it. Set "Allow access for" to **Only these users** and pick your user.
4. Note your username on the server (shown in the top-left Apple menu → your name, or run `whoami` in Terminal).
5. Note the server's address: System Settings → General → Sharing shows its `Local hostname` (for example `My-Mac.local`), and System Settings → Network shows its LAN IP. Below, `<server-lan-ip>` stands for it.

## 2. Install an SSH key (dev)

Use a key just for the server. If you don't have one yet: `ssh-keygen -t ed25519 -f ~/.ssh/<key>`.

1. Run this, using your server username and address:
   ```sh
   ssh-copy-id -i ~/.ssh/<key>.pub USER@<server-lan-ip>
   ```
2. Type the server's password **once** when it asks. It is not stored anywhere.
3. Check that it worked without a password:
   ```sh
   ssh -i ~/.ssh/<key> -o PasswordAuthentication=no USER@<server-lan-ip> 'echo ok; sw_vers -productVersion'
   ```

## 3. Add the `homebase-server` SSH alias (dev)

1. Add this block to `~/.ssh/config` (create the file if it doesn't exist). Replace `USER`.
   ```
   Host homebase-server
     HostName <server-lan-ip>
     User USER
     IdentityFile ~/.ssh/<key>
     IdentitiesOnly yes
     ServerAliveInterval 30
   ```
2. Test it: `ssh homebase-server 'echo ok'`.
3. Optional: once Tailscale runs on the server itself, change `HostName` to its MagicDNS name, so deploys work away from home too.
4. Tip: give the server a fixed IP (a DHCP reservation in your router), so `HostName` never goes stale.

## 4. Take a read-only inventory (dev)

This changes nothing on the server.

1. Run:
   ```sh
   ssh homebase-server 'bash -s' < infra/scripts/server-inventory.sh | tee ~/Desktop/server-inventory.txt
   ```
2. Look at the **Tailscale** section. The `Tailnet:` line and the `whois` user show which Tailscale account the server is on. If it's **not** the account you mean to use, stop here and decide first (spec §4.5 step 3, §16 item 9). Moving the server to another tailnet changes its tailnet IP and name, which can break access to anything else it serves.
3. Check **Disk** (aim for 30 GB free or more) and **Power**.

## 5. Tailscale admin console (admin console)

Do these in order. The tag has to exist before you can create a key with it.

### 5a. Policy file: lock `tag:homebase` down to HTTPS from the household

Open **Access controls** (the policy file editor). The goal: the `homebase` node (tagged `tag:homebase`) accepts **only tcp:443 (Tailscale Serve) from `group:household`**, and nothing else from anyone. Everything else on the tailnet keeps working exactly as before.

Why this matters: the app must only ever be reached through Serve, which is what injects the `Tailscale-User-Login` identity header. Grants are allow-only and add up, so a separate Homebase grant on its own changes nothing while the default allow-all (`"dst": ["*"]`) still lets every device reach every port on the node. The allow-all has to stop covering `tag:homebase`.

Replace `YOUR_LOGIN` with your Tailscale login (the `User: Name:` line from `tailscale whois` in the inventory, for example `you@example.com`). If a section (`groups`, `tagOwners`, `grants`, `tests`) already exists, put the entries inside it instead of creating a second one.

```diff
 {
+  // Homebase: household members who may use the app.
+  "groups": {
+    "group:household": ["YOUR_LOGIN"],   // add the other members' logins as they join
+  },
+
+  // Homebase: only you can create devices tagged tag:homebase.
+  "tagOwners": {
+    "tag:homebase": ["YOUR_LOGIN"],
+  },
+
   "grants": [
-    // the default allow-all
-    { "src": ["*"], "dst": ["*"], "ip": ["*"] },
+    // Was allow-all. Same reach for every device a tailnet member owns (laptops, phones, the
+    // server itself and whatever else it runs), but no longer every TAGGED device, so it
+    // stops covering tag:homebase. If you have other tagged devices (Machines page, "Tags"),
+    // list their tags here too, e.g. "dst": ["autogroup:member", "tag:server"].
+    { "src": ["*"], "dst": ["autogroup:member"], "ip": ["*"] },
+
+    // Homebase: household members may reach the node on HTTPS (Tailscale Serve) only.
+    // Not port 3000 (the app), not 9002 (tailscaled health), not anything else.
+    { "src": ["group:household"], "dst": ["tag:homebase"], "ip": ["tcp:443"] },
   ],
+
+  // Saving fails if these stop holding.
+  "tests": [
+    {
+      "src": "YOUR_LOGIN",
+      "accept": ["tag:homebase:443"],
+      "deny": ["tag:homebase:80", "tag:homebase:3000", "tag:homebase:9002"],
+    },
+  ],
 }
```

1. Make the changes. The editor checks the syntax and runs the `tests` before saving.
2. If your file uses the older `"acls"` list instead of `"grants"`, the allow-all looks like `{ "action": "accept", "src": ["*"], "dst": ["*:*"] }`. Change its `dst` to `["autogroup:member:*"]` (plus `"tag:other:*"` for any other tags you use), and add the Homebase rule as an ACL: `{ "action": "accept", "src": ["group:household"], "dst": ["tag:homebase:443"] }`. Don't keep a second, untouched allow-all anywhere in the file, or it re-opens every port.
3. Click **Save**.
4. After the first deploy (step 10), check from the dev machine: `https://homebase.<tailnet>.ts.net` loads, and `nc -vz -w 3 <homebase 100.x IP> 3000` and `... 9002` both fail (the IP is in `tailscale status`). This is the network-level half of the defence; the app also refuses to trust identity headers unless it is bound to the 127.0.0.2 alias that only Serve dials (docs/decisions.md, "Security review fixes").

### 5b. DNS: MagicDNS and HTTPS certificates

1. Open **DNS**.
2. Make sure **MagicDNS** is on.
3. Under **HTTPS Certificates**, click **Enable HTTPS** if it isn't already on. Certificate names are public (certificate-transparency logs), which is why the node is called `homebase` and not something revealing.

### 5c. Auth key for the server container

1. Open **Settings → Keys → Generate auth key**.
2. Set **Reusable: on**, **Ephemeral: off**, **Pre-approved: on** (only shown if device approval is on), **Tags: `tag:homebase`**. Expiration: anything. It's only used for the first login; the container keeps its own state after that.
3. Copy the key. You'll paste it into the server's `.env` in step 8. Don't paste it into chat or commit it.

## 6. Power settings (server)

These need your password, so you run them yourself. `infra/scripts/server-bootstrap.sh` prints exactly which ones are still missing.

1. Keep the server awake and let it restart on its own after a power cut:
   ```sh
   sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1
   ```
   On a MacBook, `autorestart` may be reported as unsupported. That's fine: the battery covers short outages, and Apple-silicon MacBooks start when power returns after the battery drains.
2. Only if the lid will be **closed** with no external display:
   ```sh
   sudo pmset -a disablesleep 1
   ```
3. Check: `pmset -g` shows `sleep 0` and `disksleep 0`.
4. If the server is a laptop, leave it plugged in. macOS battery optimization keeps the charge around 80%.

## 7. OrbStack and auto-start (server)

1. Install OrbStack from https://orbstack.dev (if the inventory showed it missing) and open it once.
2. OrbStack → Settings → General → turn on **Start at login**.
3. If Docker Desktop is also installed, quit it and turn off its start-at-login. Only one Docker should run.
4. Decide how the server comes back after a reboot. Automatic login (System Settings → Users & Groups → **Automatically log in as**) brings everything back unattended, but macOS only allows it with **FileVault off**. With FileVault on, the disk is encrypted at rest, and after a restart someone has to log in at the server before Homebase (and the whisper LaunchAgent) starts.

## 8. Bootstrap the checkout and secrets (dev → server)

1. Run:
   ```sh
   ssh homebase-server 'bash -s' < infra/scripts/server-bootstrap.sh
   ```
2. If your repository is private and the server can't read it, the script creates a deploy key and prints its **public** half. Add it in the repository's **Settings → Deploy keys → Add deploy key**, title `homebase-server`, **leave "Allow write access" unticked**. Then run step 1 again. A public repository is cloned over HTTPS without a key.
3. The first successful run prints the **Homebase master key** once, in a box. Save it right away in your password manager as "Homebase master key". Then clear the terminal (Cmd-K). Without this key, a restored backup can't read any saved bank or API credential.
4. Put the secrets that only you have into `.env`, on the server:
   ```sh
   ssh -t homebase-server 'nano ~/homebase/.env'
   ```
   Fill in `TS_AUTHKEY=` (from step 5c) and `YNAB_TOKEN=`. Save with Ctrl-O, Enter, Ctrl-X. Leave the generated passwords and key alone.
5. Run step 1 again. It's safe to re-run. It should now list only the steps you haven't done yet.

## 9. Speech-to-text (server)

1. Run:
   ```sh
   ssh homebase-server 'bash ~/homebase/infra/scripts/install-whisper.sh'
   ```
2. It installs Homebrew `whisper.cpp` (formerly `whisper-cpp`), downloads `ggml-small.en.bin` (about 490 MB), installs the LaunchAgent, then checks `/health` and times a sample transcription.
3. If the sample takes much more than 2 seconds, re-run with `--model base.en`.
4. iPhone recordings are `audio/mp4`. Either the web app converts them to WAV before uploading, or you re-run with `--with-ffmpeg` (adds Homebrew `ffmpeg` and starts the server with `--convert`).
5. whisper listens on `127.0.0.1:8178` only, never on the LAN.

## 10. First deploy (dev)

1. Push your commits to GitHub.
2. Run:
   ```sh
   infra/scripts/deploy.sh
   ```
3. It pulls, builds, starts Postgres, runs migrations, starts everything, then checks the web container's `/api/health`. At the end it prints the app URL, `https://homebase.<your-tailnet>.ts.net/`.
4. In the admin console → **Machines**, check that `homebase` shows the tag `tag:homebase`. If device approval is on and you didn't pre-approve the key, approve it there.
5. The first HTTPS request can take a few seconds while Tailscale gets the certificate.
6. Check that speech-to-text is reachable from the containers:
   ```sh
   ssh homebase-server 'bash ~/homebase/infra/scripts/install-whisper.sh'
   ```
   The last section, "Reachability from containers", should say OK. If it fails, see Troubleshooting below.

## 11. Install the app on iPhone

1. Install the **Tailscale** app on the iPhone and sign in to the same tailnet. Turn the VPN on.
2. Open **Safari** (it has to be Safari) and go to `https://homebase.<your-tailnet>.ts.net`.
3. Tap **Share → Add to Home Screen → Add**.
4. Open Homebase **from the home-screen icon**. Do these from there, not from Safari:
   - Allow the **microphone** the first time you use the mic button.
   - Allow **notifications** when the app asks. iOS only delivers push to the installed app.
5. Other household members need Tailscale on their phones and access to the node first (spec §2, §16 item 5). Add their logins to `group:household` in the policy file.

## 12. Backups and the restore drill (server)

Backups run by themselves every night at 03:30 (New York time) into `~/homebase/backups`, and are kept for 30 days. Each dump comes with a row-count manifest.

1. Take a backup now:
   ```sh
   ssh homebase-server '~/homebase/infra/scripts/backup.sh'
   ```
2. Run the restore drill. It restores the newest dump into a scratch database, checks every table's row count, then deletes the scratch copy. The live database isn't touched.
   ```sh
   ssh homebase-server '~/homebase/infra/scripts/restore.sh --drill'
   ```
   It should end with `Drill passed`.
3. Check the master key. Compare short fingerprints, so the key itself is never printed (dev):
   ```sh
   # fingerprint of the server's key
   ssh homebase-server "grep '^HOMEBASE_MASTER_KEY=' ~/homebase/.env | cut -d= -f2- | tr -d '\n' | shasum -a 256 | cut -c1-12"
   # copy the key from your password manager, then:
   pbpaste | tr -d '\n' | shasum -a 256 | cut -c1-12
   ```
   The two 12-character values must be the same.
4. Do the drill again after big changes, and every few months.
5. Off-host copy (spec §16 item 2): any copy that leaves the server must be encrypted (restic or age). Never put plain dumps in iCloud Drive or Dropbox.

### If the server dies (full recovery)

1. Set up the new Mac with steps 1–9. Step 8 prints a **new** master key. Don't save that one. Instead, edit `~/homebase/.env` and replace the `HOMEBASE_MASTER_KEY=` value with the **old** key from your password manager. Don't deploy yet.
2. Copy the latest `homebase-*.dump`, `.counts` and `.roles.sql` files onto the new server (from your off-host copy).
3. Run:
   ```sh
   ~/homebase/infra/scripts/restore.sh --replace /path/to/homebase-YYYYMMDD-HHMMSS.dump
   ```
   Type `replace` to confirm. It takes a safety dump, restores, checks the row counts, runs migrations and starts the stack.
4. Open the app → Settings → Connections. Connections that show as unreadable mean the master key in `.env` isn't the one this backup was made with.

## Day-to-day commands (server)

All Compose commands go through the wrapper, which uses the repo-root `.env`:

```sh
~/homebase/infra/scripts/compose.sh ps                 # what's running
~/homebase/infra/scripts/compose.sh logs -f web        # follow web logs
~/homebase/infra/scripts/compose.sh restart worker
~/homebase/infra/scripts/compose.sh exec tailscale tailscale serve status
~/homebase/infra/scripts/backup.sh --list              # dumps and last backup status
launchctl kickstart -k gui/$(id -u)/com.homebase.whisper   # restart whisper
tail -f ~/Library/Logs/homebase/whisper.err.log
```

## Troubleshooting

- **The `homebase` node never shows up in Tailscale.** Run `compose.sh logs tailscale`. The usual causes are an empty or expired `TS_AUTHKEY`, or a key created without `tag:homebase`. Fix `.env`, then `compose.sh up -d --force-recreate tailscale web`.
- **The URL doesn't load, but the node is up.** Check that HTTPS certificates are enabled (step 5b) and that `compose.sh exec tailscale tailscale serve status` shows `https://homebase...` → `http://127.0.0.2:3000` (the app listens on the 127.0.0.2 loopback alias, not 127.0.0.1).
- **The web container can't reach whisper.** `WHISPER_URL` defaults to `http://host.internal:8178`. That name is added by Compose (`extra_hosts: host-gateway`) on the tailscale container, whose network the web container shares. OrbStack forwards it to the Mac's loopback **[VERIFY]**. If it fails, set `WHISPER_URL=http://host.docker.internal:8178` in `.env` (OrbStack provides that name itself) and run `compose.sh up -d web`. Don't make whisper listen on `0.0.0.0`.
- **Postgres says "password authentication failed" after you rebuilt `.env`.** `POSTGRES_PASSWORD` only applies when the `homebase_pgdata` volume is first created. Put the original password back, or restore from a backup into a fresh volume.
- **Deploy says the checkout has local modifications.** Someone edited files on the server. Run `ssh homebase-server 'cd ~/homebase && git status'`, then either commit those changes from the dev machine or discard them.
