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

## Running it

You need [Node.js](https://nodejs.org) 18 or newer. There's nothing to install.

```bash
node server.js
```

The terminal prints the addresses to use, for example:

```
  Players on Wi-Fi:   http://192.168.1.20:3000
  Keeper dashboard:   add /keeper to the address
```

1. Players open `http://<that address>` on their phones. They must be on the **same Wi-Fi** as the laptop.
2. The Keeper opens the same address, taps **I'm the Keeper** at the top of the start screen, and enters the passcode. (Going straight to `/keeper` also works.)

### Options

| Setting | How to change it |
| --- | --- |
| Port | `PORT=8080 node server.js` |
| Keeper passcode | `KEEPER_PASSCODE=123456 node server.js` (default `250247`) |

The game is saved to `data.json`, so restarting the server keeps the players and the round. Delete that file to start completely fresh.
