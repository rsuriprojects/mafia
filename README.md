# Nightfall

A role dealer for the party game Mafia. Everyone joins on their own phone with a
short code, gets a secret card, and the app keeps score across games.

**Live:** https://mafia-gamma-swart.vercel.app/

---

## What it does

- **Deals one deck.** Roles are shuffled on the server and handed out one card per
  device, so a seven-player game with two mafia has exactly two mafia — never three,
  never none.
- **Live waiting room.** Names appear as people join. The host starts when everyone's in,
  or starts short if someone flakes, and the deck is rebuilt for whoever actually turned up.
- **Hold-to-reveal cards.** Press and hold to see your role; let go and it flips shut.
  No text selection, no long-press menus, nothing to accidentally leave on screen.
- **Rematch in place.** After the host calls the winner, one tap reshuffles and every
  phone updates. No new code, no rejoining.
- **Elo ratings** that persist across games and account for how lopsided the deck was.
- **Moderator sheet** for the narrator, with a night script that only wakes the roles
  actually in play.

## Layout

```
.
├── index.html      the whole front end
└── api/
    └── game.js     serverless function: game state, joins, ratings
```

The folder must be called `api` — Vercel turns anything inside it into an endpoint,
and `api/game.js` becomes `/api/game`, which is what the front end calls.

## How a game runs

The host picks the player count, the number of mafia, and whether the doctor and
detective are in. They get a code — random four characters, or their own three to six
if they'd rather pick something easy to say out loud.

Everyone types their name and that code. The server shuffles the deck once and each
join claims the next card atomically, inside a single Redis operation, so two people
tapping at the same instant can't land on the same card.

The host starts, everyone holds their card, and the game is played face to face. When
it's over the host calls it — villagers or mafia — and ratings update for everyone.

Starting, calling the winner, and redealing are host-only, enforced on the server rather
than just hidden in the UI. The trade-off is that if the host's phone dies mid-game the
table is stuck, though everyone can still see their own card.

## Ratings

Everyone starts at 1200.

Each game moves a single pot: whatever the winners take, the losers pay, so the table's
total never drifts. The pot splits per side, which means the smaller side moves further
per person — two mafia beating six villagers gain about three points for each one a
villager loses.

The deck is priced in before ratings are compared. One mafia against seven is a losing
hand however well it's played, so winning it pays out big and losing it barely stings;
three against five is the reverse. Roughly one mafia per four players counts as even,
which matches the standard ratio. On top of that, the usual Elo rule applies — beating a
strong table is worth more than beating a weak one. Nobody moves more than 40 points in
a single game.

Identity is just the typed name, case-insensitive, so `rishi` and `Rishi` are the same
player. Fine for a group of friends; there's nothing stopping someone from typing your
name.

## Running your own copy

Push both files to a repo and import it at [vercel.com/new](https://vercel.com/new).
Then attach storage: **Storage → Create Database → Upstash Redis** (free tier), leaving
the custom prefix blank, since the code looks for `KV_REST_API_URL` and
`KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_*` equivalents) and a prefix renames
them. Redeploy with the build cache off — environment variables are read at build time,
so a cached build reuses the old ones.

Until storage is attached the app says so plainly rather than failing quietly.

## Notes

- Lobbies nobody starts expire after an hour and free their code. A running game lasts
  twelve hours. Ratings never expire.
- A custom code can be reclaimed if it's yours, if nobody joined, or if that game
  finished — closing a tab doesn't tell the server anything, so abandoned codes would
  otherwise stay locked.
- Everything is vanilla HTML, CSS and JavaScript. No build step, no framework, no
  dependencies.
