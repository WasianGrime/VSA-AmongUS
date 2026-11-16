# VSA Among Us

A tracker for playing Among Us in real life. One person is the **Keeper** and runs the game from a laptop. Everyone else plays on their phone's browser.

## What it does

- **Players** open the join page, type their name and get a personal 4-digit **player ID**. If they close the page or switch phones, they can get back in with that ID.
- **The Keeper** unlocks the Keeper Console with the passcode (`250247`). From there they can:
  - see every player, their ID, role and task progress
  - choose how many impostors and how many tasks each player gets
  - pick impostors themselves, or let the app pick at random
  - edit the task list (task name and where in the room or house it is)
  - start the game, call emergency meetings, mark players as out, and end the round
- **When the game starts**, each player's phone shows:
  - their role (press and hold to see it, so nobody can peek)
  - the tasks they need to do, which they tick off once done in real life
  - a progress bar for the whole crew's tasks
- Impostors get fake tasks that don't count toward progress, and they can see who the other impostors are.
- The game ends by itself when the crew finishes every task, when every impostor is out, or when the impostors equal the crew. The Keeper can also end it by hand.

## Putting it on Vercel (play on any connection)

On Vercel, players can join from Wi-Fi, LTE or 5G. The game is saved in a free Upstash Redis database that you add from inside Vercel.

1. Import this repo into Vercel (or keep your existing project). No build settings are needed, since `vercel.json` handles them.
2. In the project, open **Storage**, choose **Upstash for Redis** (it may be under Marketplace), create a free database and **connect it to this project**. Vercel adds the `KV_REST_API_URL` and `KV_REST_API_TOKEN` settings for you.
3. **Redeploy** so the new settings take effect.
4. Players open your Vercel address. The Keeper taps **I'm the Keeper** and enters the passcode.

If the database isn't connected, the app shows a message saying so instead of failing silently.

Phones check for updates every 2 seconds, and every 8 seconds when the screen is off. Each check is one database request, so a 10-player game uses about 18,000 requests an hour. Check your Upstash plan's monthly limit.

## Running it on a laptop instead

You need [Node.js](https://nodejs.org) 18 or newer. There's nothing to install.

```bash
npm run local
```

The terminal prints the address for players. Everyone must be on the same Wi-Fi as the laptop, and the game is saved to `data.json`.

## Options

Set these as environment variables (in Vercel: **Settings → Environment Variables**, then redeploy).

| Setting | What it does |
| --- | --- |
| `KEEPER_PASSCODE` | Keeper passcode (default `250247`) |
| `PORT` | Port for the laptop version (default `3000`) |
