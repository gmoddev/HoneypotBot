# Honeypot Bot

If you do not want to host the bot yourself, the public bot is available here:

https://discord.com/oauth2/authorize?client_id=1507854358996324434&scope=bot&permissions=8

After inviting the public bot, skip to [Invited To Server](#invited-to-server).

## What It Does

Honeypot Bot creates a honeypot channel. When enabled, anyone who sends a message in that channel is automatically punished based on your configured settings.

## Requirements

- Node.js 20 or newer
- A Discord application and bot token
- Administrator access in the Discord server where the bot will be used

## Discord Bot Setup

1. Go to the Discord Developer Portal.
2. Create an application.
3. Open the Bot page and create a bot.
4. Copy the bot token.
5. Open the OAuth2 page.
6. Copy your application client ID.
7. Invite the bot to your server with the permissions it needs.

The bot uses slash commands and needs administrator permissions for the easiest setup.

## Regular Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file:

```bash
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_discord_application_client_id_here
```

You can also copy `example_env.env` and rename it to `.env`.

3. Start the bot:

```bash
npm start
```

The bot stores its SQLite database in the `data` folder.

## Docker Setup

1. Create a `.env` file:

```bash
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_discord_application_client_id_here
```

2. Build and start the container:

```bash
docker compose up -d --build
```

3. View logs:

```bash
docker compose logs -f
```

4. Stop the bot:

```bash
docker compose down
```

The Docker Compose setup mounts `./data` into the container so the bot database stays saved between restarts.

## Invited To Server

When the bot first joins a server, it will try to ping the server owner with a setup notice.

To enable the honeypot, run:

```text
/honeypot enable
```

This creates the honeypot channel and posts the warning message.

## Commands

```text
/honeypot enable
```

Enables the honeypot and creates the honeypot channel.

```text
/honeypot disable
```

Disables honeypot punishments.

```text
/honeypot view
```

Shows the current honeypot status.

```text
/honeypot config ban_length:<value> ban_reason:<reason>
```

Updates punishment settings.

Supported `ban_length` values:

- `kick`
- `0` for a permanent ban
- timed values like `30m`, `1h`, `1d`, `2w`, or `1y`

## Notes

- Slash commands are registered globally, so command updates may take a short time to appear in Discord.
- The bot must be able to create channels, send messages, manage messages, kick members, and ban members.
- Make sure the bot role is higher than the roles of members it needs to punish.
