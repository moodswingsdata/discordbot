# FeeelingsBot

A Discord bot for Mood Swings.

# Commands

* `/feel <card name>` - show the text of a card. Leave "card name" blank to have the server pick a random one.
  ![picture of the /feel command in action](assets/demo.png)
* `/search <query>` - use full Feelings search text. This isn't hooked up yet, sorry!
* `[[card name]]` - mention a card name in double-brackets anywhere in a message and the bot will look it up, just like `/feel <card name>`.

Code derived from https://github.com/discord/cloudflare-sample-app.

# Development

To set up a development instance, you'll need a Discord app.

- Go to [the Discord Developer Hub](https://discord.com/developers/home)
- Create a new app
- Copy `.env.example` to `.env` and fill it out from the info you got above
- On the Installation tab, set the default install permissions for a Guild Install to include scopes "applications.commands" and "bot". Under permissions, include at least "Send Messages" and "Use Slash Commands".
- On the Bot tab, enable the **Message Content Intent** under Privileged Gateway Intents. This allows the bot to read the content of messages so it can detect `[[card name]]` references.
- Optional: you can use [this image](assets/discord-dev.png) for your new app.

Then run this locally. You'll need three terminals:

1. `npm run start` — starts the Cloudflare Worker locally (handles slash commands)
2. `npm run tunnel` — exposes the worker via a public URL for Discord
3. `npm run gateway` — starts the gateway bot (handles `[[card name]]` in messages)

Go to the General Information tab in your Discord app. Copy the URL from the `tunnel` command and paste it as the Interactions Endpoint URL. Save.

Note that free Serveo tunnels die after a while, so you'll probably do this several times per session.

The gateway bot (`npm run gateway`) connects directly to Discord and does not need the tunnel. It reads the same `.env` file and requires `DISCORD_TOKEN` to be set.
