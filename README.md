# totem-autologin

Keeps [totem](https://github.com/thebriangao/totem) logged into Whoop, so you never have to run `totem auth` by hand.

Whoop's login runs out after about 30 days. Logging in again needs your password and a code that Whoop sends by
email. This tool checks totem every 30 minutes. When the login has expired, it logs in, reads the code from your
Gmail, and gives totem the new tokens.

## How it works

1. Every 25 to 35 minutes, it calls one totem tool (`whoop_daily_brief`).
2. If that fails with a login error twice, 2 minutes apart, it logs into Whoop with your email and password.
3. Whoop emails a code. A small Google Apps Script in your Gmail account finds that email and returns the code.
4. The tool saves the new tokens where totem reads them and restarts totem if needed.
5. It emails you the result.

Other errors (Whoop down, network problems) never start a login. It tries at most once every 6 hours, so a wrong
password can't cause repeated logins.

## Requirements

- totem, already set up and working
- Node.js 22.18 or newer on the machine that runs this tool (your server, a home machine, or your Mac)
- the Gmail account that receives Whoop's emails
- for Fly, Railway or Cloud Run: that platform's CLI, installed and logged in on the same machine

## Setup

### 1. Install

```sh
git clone https://github.com/HoussamOtarid/totem-autologin.git
cd totem-autologin
npm ci
```

### 2. Create the Gmail relay

1. Open [script.google.com](https://script.google.com) with the Gmail account Whoop emails, and click **New project**.
2. Replace the sample code with the content of [`apps-script/Code.gs`](apps-script/Code.gs) and save.
3. Pick `debugLatest` in the function list and click **Run**. Allow access when Google asks. If you see "Google
   hasn't verified this app", click **Advanced**, then **Go to … (unsafe)**. This is normal for your own scripts.
4. Click **Deploy → New deployment**, pick the type **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the web app URL (it ends in `/exec`).

The script only answers requests that carry your key (next step), and only returns the code from a recent Whoop email.

### 3. Configure

```sh
node bin/totem-autologin.ts setup
```

It asks for your Whoop email, password and the relay URL, saves them in `autologin.env`, and prints a key.
In the Apps Script, open **Project Settings → Script properties** and add a property `KEY` with that value.

Then open `autologin.env` and fill in the settings for your setup:

| Your setup | `CHECK` | `TARGET` | Also set |
|---|---|---|---|
| Docker or your own server | `mcp` | `envfile` | `TOTEM_URL`, `TOTEM_TOKEN`, `ENV_FILE`, `RESTART_COMMAND` |
| Local install (Claude Desktop / Code starts totem) | `refresh` | `envfile` | `ENV_FILE` |
| Fly | `mcp` | `fly` | `TOTEM_URL`, `TOTEM_TOKEN`, `FLY_APP` |
| Railway | `mcp` | `railway` | `TOTEM_URL`, `TOTEM_TOKEN`, `RAILWAY_PROJECT` and `RAILWAY_SERVICE` if the folder isn't linked |
| Cloud Run | `mcp` | `cloudrun` | `TOTEM_URL`, `TOTEM_TOKEN`, `CLOUDRUN_SERVICE`, `CLOUDRUN_REGION`, `CLOUDRUN_PROJECT` |
| Hugging Face Space | `mcp` | `huggingface` | `TOTEM_URL`, `TOTEM_TOKEN`, `HF_SPACE`, `HF_TOKEN` (write access) |
| Anything else | `mcp` | `command` | `TOTEM_URL`, `TOTEM_TOKEN`, `TOKENS_COMMAND` |

- `TOTEM_URL` is your server's MCP URL (`https://…/mcp`). `TOTEM_TOKEN` is its `MCP_AUTH_TOKEN`.
- **Docker:** `ENV_FILE` is the file mounted as `/app/.env` in the totem container, and `RESTART_COMMAND` is usually
  `docker restart totem`. The tool needs write access to that file.
- **Local install:** `ENV_FILE` is the `.env` in your totem folder. The tool only refreshes the token while totem
  isn't running, because a refresh replaces the token that a running totem holds. After a new login, restart your
  MCP client.
- **command:** your command gets the tokens as `WHOOP_IOS_BEARER_TOKEN` and `WHOOP_COGNITO_REFRESH_TOKEN`.

Keep the file private: `chmod 600 autologin.env`.

### 4. Test

```sh
node bin/totem-autologin.ts check    # should print "totem: ok" and "relay: ok"
node bin/totem-autologin.ts login    # real login: you get a Whoop code email, then a "Whoop login OK" email
```

### 5. Run it on a schedule

**Linux (systemd):** edit `User` and the paths in [`examples/totem-autologin.service`](examples/totem-autologin.service),
copy it and [`examples/totem-autologin.timer`](examples/totem-autologin.timer) to `/etc/systemd/system/`, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now totem-autologin.timer
journalctl -u totem-autologin    # logs
```

**macOS or anything with cron:** use the line in [`examples/crontab.txt`](examples/crontab.txt).

The machine has to be on for the check to run.

## Commands

| Command | What it does |
|---|---|
| `run` | Check, and log in again if the login expired. The default, and what the schedule runs |
| `check` | Check only, and test the relay |
| `login` | Log in now, even if the login still works. Sends a code email |
| `setup` | Ask for email, password and relay URL, and create a new relay key |

Add `--config <file>` to use a config file other than `./autologin.env`.

## Troubleshooting

| Message | What to do |
|---|---|
| `relay: forbidden` | `KEY` in the Apps Script doesn't match `CODE_KEY` in `autologin.env` |
| `no Whoop code email within 150 s` | Run `debugLatest` in the Apps Script. If Whoop changed the sender or the wording, update `QUERY` or the pattern in `Code.gs` |
| `Incorrect username or password` | Your Whoop password changed. Run `setup` again, then update `KEY` (setup creates a new one) |
| `the last attempt was less than 6 h ago` | Fix the cause, delete `autologin-state.json`, run `login` |
| `the server refused TOTEM_TOKEN` | `TOTEM_TOKEN` must be the server's `MCP_AUTH_TOKEN` |

After you edit `Code.gs`, deploy a new version: **Deploy → Manage deployments → edit → Version: New version**.
This keeps the same URL.

## Notes

- Gmail only for now. For another mail provider, build a relay that answers the same requests:
  `{key, action: "code", since}` returns `{code}` (or `{code: null}`), `{key, action: "notify", subject, msg}`
  sends you an email, and a wrong key returns `{error}`.
- Tested with Docker on Linux. The Fly, Railway, Cloud Run and Hugging Face targets run the same commands as `totem auth`.
- Like totem, this uses Whoop's private login API. It can break if Whoop changes it.
- Not affiliated with Whoop or with totem.

## License

MIT.
